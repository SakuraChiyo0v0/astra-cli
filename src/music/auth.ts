/**
 * 网易云扫码登录与会话保存。
 *
 * 协议（实测 2026-10-21 可用）：
 * 1. `POST /weapi/login/qrcode/unikey` { type: 3 } → unikey；二维码内容是 `https://music.163.com/login?codekey=<unikey>`
 * 2. 轮询 `POST /weapi/login/qrcode/client/login` { key, type: 3 }：
 *    800 过期 / 801 等待扫码 / 802 已扫待确认 / 803 成功（响应头 Set-Cookie 里才有 MUSIC_U）
 * 3. **UA 必须是桌面客户端形态**，浏览器 UA 会被上游以 8821（"请切换其他登录方式或升级新版本"）拒绝
 * 4. 轮询要带上前一次响应下发的 NMTID，否则等于换了个设备在问
 *
 * 会话只存在 `<ASTRA_HOME>/netease-session.json`，权限 600，不进曲库也不进日志。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { homePath } from '../core/paths.ts'
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { weapiEncrypt, eapiEncrypt, eapiDecryptBody } from './crypto.ts'

const ORIGIN = 'https://music.163.com'
/** 桌面客户端 UA：浏览器 UA 会被 8821 拒绝（astrahub 实测）。 */
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) NeteaseMusicDesktop/2.3.17.1034'
const QR_TYPE = 3

export interface Session {
  /** cookie 串，含 MUSIC_U 等；只落盘，不回显。 */
  cookie: string
  /** 网易云用户 id。 */
  userId: string | null
  nickname: string | null
  savedAt: string
}

function sessionFile(): string {
  return homePath('netease-session.json')
}

/** 简短的会话指纹，给用户看"是不是同一个账号"，不泄露内容。 */
export function sessionDigest(session: Session): string {
  return createHash('sha256').update(session.cookie).digest('hex').slice(0, 10)
}

export function loadSession(): Session | null {
  try {
    const parsed = JSON.parse(readFileSync(sessionFile(), 'utf8')) as Session
    return typeof parsed.cookie === 'string' && parsed.cookie.length > 0 ? parsed : null
  } catch {
    return null
  }
}

export function saveSession(session: Session): void {
  const file = sessionFile()
  writeFileSync(file, JSON.stringify(session, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
}

export function clearSession(): boolean {
  if (!existsSync(sessionFile())) return false
  rmSync(sessionFile(), { force: true })
  return true
}

/** 带上会话 cookie 的请求头。登录态下取歌单、私人日推都靠它。 */
export function cookieHeader(session: Session | null): string {
  return session ? session.cookie : 'appver=2.0.2'
}

const jar = new Map<string, string>()

function jarHeader(): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

function absorbCookies(setCookies: string[]): void {
  for (const raw of setCookies) {
    const pair = raw.split(';')[0]
    const eq = pair?.indexOf('=') ?? -1
    if (!pair || eq <= 0) continue
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
}

async function weapiPost(path: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ body: Record<string, unknown>; cookie: string }> {
  const { params, encSecKey } = weapiEncrypt(payload)
  const cookie = ['__remember_me=true', jarHeader()].filter(Boolean).join('; ')
  const options: Parameters<typeof httpRequest>[1] = {
    method: 'POST',
    headers: {
      'user-agent': DESKTOP_UA,
      'content-type': 'application/x-www-form-urlencoded',
      accept: '*/*',
      'accept-language': 'zh-CN,zh-Hans;q=0.9',
      referer: `${ORIGIN}/`,
      origin: ORIGIN,
      cookie,
    },
    body: new URLSearchParams({ params, encSecKey }).toString(),
    timeoutMs: 15_000,
    retries: 1,
  }
  if (signal) options.signal = signal
  const response = await httpRequest(`${ORIGIN}${path}`, options)
  const setCookies = response.headers.getSetCookie?.() ?? []
  absorbCookies(setCookies)
  const text = await response.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new AstraError('NETEASE_BAD_RESPONSE', `登录接口返回的不是 JSON：${text.slice(0, 80)}`, { exitCode: 5 })
  }
  return { body, cookie: [jarHeader(), ...setCookies.map((c) => c.split(';')[0])].filter(Boolean).join('; ') }
}

export interface LoginStart {
  unikey: string
  qrContent: string
}

export async function startQrLogin(signal?: AbortSignal): Promise<LoginStart> {
  const { body } = await weapiPost('/weapi/login/qrcode/unikey', { type: QR_TYPE }, signal)
  if (body.code !== 200 || typeof body.unikey !== 'string') {
    throw new AstraError('NETEASE_LOGIN_START_FAILED', `获取二维码失败（code=${String(body.code)}）`, {
      exitCode: 5,
      details: { code: body.code, message: body.message },
    })
  }
  return { unikey: body.unikey, qrContent: `${ORIGIN}/login?codekey=${body.unikey}` }
}

export type PollState = 'waiting' | 'scanned' | 'expired' | 'success' | 'unknown'

export interface PollResult {
  state: PollState
  code: number
  message: string | null
  session: Session | null
}

export async function pollQrLogin(unikey: string, signal?: AbortSignal): Promise<PollResult> {
  const { body, cookie } = await weapiPost('/weapi/login/qrcode/client/login', { key: unikey, type: QR_TYPE }, signal)
  const code = typeof body.code === 'number' ? body.code : -1
  const message = typeof body.message === 'string' ? body.message : null
  if (code === 803) {
    if (!/MUSIC_U=/.test(cookie)) {
      throw new AstraError('NETEASE_LOGIN_NO_COOKIE', '扫描成功但没拿到 MUSIC_U，登录态不完整', {
        exitCode: 5,
        hint: '重试一次；仍然这样说明上游改了协议',
      })
    }
    const session: Session = { cookie, userId: null, nickname: null, savedAt: new Date().toISOString() }
    return { state: 'success', code, message, session }
  }
  if (code === 800 || code === 801 || code === 802) {
    return { state: code === 800 ? 'expired' : code === 802 ? 'scanned' : 'waiting', code, message, session: null }
  }
  return { state: 'unknown', code, message, session: null }
}

/** 用会话查账号信息，确认登录还有效。失败不代表账号错，也可能是网络。 */
export async function fetchAccount(session: Session, signal?: AbortSignal): Promise<{ userId: string | null; nickname: string | null; vip: boolean }> {
  // /api/nuser/account/get 是明文端点，带 MUSIC_U 就能拿到自己的资料
  const options: Parameters<typeof httpRequest>[1] = {
    headers: { 'user-agent': DESKTOP_UA, referer: `${ORIGIN}/`, cookie: session.cookie },
    timeoutMs: 12_000,
    retries: 1,
  }
  if (signal) options.signal = signal
  const response = await httpRequest(`${ORIGIN}/api/nuser/account/get`, options)
  if (!response.ok) throw new AstraError('NETEASE_ACCOUNT_FAILED', `账号信息返回 HTTP ${response.status}`, { exitCode: 5, retryable: true })
  const body = (await response.json()) as { code?: number; account?: { id?: number; vipType?: number }; profile?: { userId?: number; nickname?: string; vipType?: number } }
  const account = body.account ?? {}
  const profile = body.profile ?? {}
  const userId = profile.userId ?? account.id
  return { userId: userId ? String(userId) : null, nickname: profile.nickname ?? null, vip: (profile.vipType ?? account.vipType ?? 0) > 0 }
}

export interface PlaylistSummary {
  id: string
  name: string
  trackCount: number
  creator: string | null
  subscribed: boolean
  coverUrl: string | null
  updatedAt: number | null
}

/** 我的歌单（含收藏的）。需要登录。 */
export async function myPlaylists(session: Session, userId: string, signal?: AbortSignal): Promise<PlaylistSummary[]> {
  const options: Parameters<typeof httpRequest>[1] = {
    headers: { 'user-agent': DESKTOP_UA, referer: `${ORIGIN}/`, cookie: session.cookie },
    timeoutMs: 15_000,
    retries: 1,
  }
  if (signal) options.signal = signal
  const response = await httpRequest(`${ORIGIN}/api/user/playlist?uid=${encodeURIComponent(userId)}&limit=1000&offset=0`, options)
  const body = (await response.json()) as {
    code?: number
    more?: boolean
    playlist?: { id: number; name: string; trackCount?: number; subscribed?: boolean; coverImgUrl?: string; updateTime?: number; creator?: { nickname?: string } }[]
  }
  if (body.code !== 200 || !Array.isArray(body.playlist)) {
    throw new AstraError('NETEASE_PLAYLIST_FAILED', `取我的歌单失败（code=${String(body.code)}）`, {
      exitCode: 5,
      retryable: true,
      hint: '会话可能过期了，`astra music login` 重新扫码',
    })
  }
  return body.playlist.map((p) => ({
    id: String(p.id),
    name: p.name,
    trackCount: p.trackCount ?? 0,
    creator: p.creator?.nickname ?? null,
    subscribed: p.subscribed === true,
    coverUrl: p.coverImgUrl ?? null,
    updatedAt: p.updateTime ?? null,
  }))
}

/** 账号维度的请求（eapi）。用不上时保留给后续的日推、私人 FM。 */
export async function eapiPost(apiPath: string, payload: Record<string, unknown>, session: Session, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const { params } = eapiEncrypt(apiPath, payload)
  const options: Parameters<typeof httpRequest>[1] = {
    method: 'POST',
    headers: {
      'user-agent': DESKTOP_UA,
      'content-type': 'application/x-www-form-urlencoded',
      referer: `${ORIGIN}/`,
      origin: ORIGIN,
      cookie: session.cookie,
    },
    body: new URLSearchParams({ params }).toString(),
    timeoutMs: 15_000,
    retries: 1,
  }
  if (signal) options.signal = signal
  const response = await httpRequest(`https://interface.music.163.com/eapi${apiPath}`, options)
  const { json } = eapiDecryptBody(await response.text())
  return JSON.parse(json) as Record<string, unknown>
}

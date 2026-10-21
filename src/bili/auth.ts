/**
 * B 站扫码登录与会话保存。
 *
 * 协议（实测 2026-10-21）：
 * 1. `GET /x/passport-login/web/qrcode/generate` → `{ url, qrcode_key }`，二维码内容就是 url
 * 2. 轮询 `GET /x/passport-login/web/qrcode/poll?qrcode_key=`：
 *    code 0 = 成功（**cookie 在 Set-Cookie 里**），86101 = 未扫码，86090 = 已扫待确认，86038 = 过期
 * 3. 登录后 SESSDATA 等 cookie 决定画质上限；未登录封顶 360P（实测）
 *
 * 会话只存 `<ASTRA_HOME>/bili-session.json`，权限 600。
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homePath } from '../core/paths.ts'
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

export interface BiliSession {
  cookie: string
  uid: string | null
  nickname: string | null
  /** 登录后是不是大会员（影响能否拿 1080P+ / 4K）。 */
  vip: boolean | null
  savedAt: string
}

function sessionFile(): string {
  return homePath('bili-session.json')
}

export function loadBiliSession(): BiliSession | null {
  try {
    const parsed = JSON.parse(readFileSync(sessionFile(), 'utf8')) as BiliSession
    return typeof parsed.cookie === 'string' && parsed.cookie.includes('SESSDATA=') ? parsed : null
  } catch {
    return null
  }
}

export function saveBiliSession(session: BiliSession): void {
  writeFileSync(sessionFile(), JSON.stringify(session, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(sessionFile(), 0o600)
}

export function clearBiliSession(): boolean {
  if (!existsSync(sessionFile())) return false
  rmSync(sessionFile(), { force: true })
  return true
}

export function cookieHeader(session: BiliSession): string {
  return session.cookie
}

export function biliSessionDigest(session: BiliSession): string {
  return createHash('sha256').update(session.cookie).digest('hex').slice(0, 10)
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<{ body: T; setCookie: string[] }> {
  const options: Parameters<typeof httpRequest>[1] = { headers: { 'user-agent': UA, referer: REFERER }, timeoutMs: 12_000, retries: 1 }
  if (signal) options.signal = signal
  const response = await httpRequest(url, options)
  const setCookie = response.headers.getSetCookie?.() ?? []
  const body = (await response.json()) as T
  return { body, setCookie }
}

export interface QrStart {
  qrcodeKey: string
  url: string
}

export async function startBiliQr(signal?: AbortSignal): Promise<QrStart> {
  const { body } = await getJson<{ code: number; message?: string; data?: { url: string; qrcode_key: string } }>(
    'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',
    signal,
  )
  if (body.code !== 0 || !body.data?.url || !body.data.qrcode_key) {
    throw new AstraError('BILI_QR_FAILED', `获取登录二维码失败（code=${body.code}）`, { exitCode: 5, details: { code: body.code } })
  }
  return { qrcodeKey: body.data.qrcode_key, url: body.data.url }
}

export type BiliPollState = 'waiting' | 'scanned' | 'expired' | 'success' | 'unknown'

export interface BiliPollResult {
  state: BiliPollState
  /** 官方 code：0 / 86101 / 86090 / 86038。 */
  code: number
  message: string | null
  cookie: string | null
  /** 成功时官方还会带 refresh_token 的链接参数，这里只要 cookie。 */
  redirectUrl: string | null
}

export async function pollBiliQr(qrcodeKey: string, signal?: AbortSignal): Promise<BiliPollResult> {
  const { body, setCookie } = await getJson<{ code: number; message?: string; data?: { code: number; message?: string; url?: string } }>(
    `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
    signal,
  )
  const inner = body.data?.code ?? body.code
  const message = body.data?.message ?? body.message ?? null
  if (inner === 0) {
    // 官方把登录态放在 Set-Cookie；有些情况下只有 data.url 里的参数，两边都收
    const cookies = setCookie.map((c) => c.split(';')[0]).filter(Boolean)
    const fromUrl: string[] = []
    if (body.data?.url) {
      try {
        const parsed = new URL(body.data.url)
        for (const key of ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']) {
          const value = parsed.searchParams.get(key)
          if (value) fromUrl.push(`${key}=${value}`)
        }
      } catch {
        // url 结构变了就只靠 cookie
      }
    }
    const cookie = [...cookies, ...fromUrl].join('; ')
    if (!/SESSDATA=/.test(cookie)) {
      throw new AstraError('BILI_LOGIN_NO_COOKIE', '扫码成功但没拿到 SESSDATA', { exitCode: 5, hint: '重试一次；仍然这样说明协议变了' })
    }
    return { state: 'success', code: inner, message, cookie, redirectUrl: body.data?.url ?? null }
  }
  const state: BiliPollState = inner === 86101 ? 'waiting' : inner === 86090 ? 'scanned' : inner === 86038 ? 'expired' : 'unknown'
  return { state, code: inner, message, cookie: null, redirectUrl: null }
}

/** 用会话查账号，确认登录有效、以及是不是大会员。 */
export async function fetchBiliAccount(session: BiliSession, signal?: AbortSignal): Promise<{ uid: string | null; nickname: string | null; vip: boolean }> {
  const options: Parameters<typeof httpRequest>[1] = {
    headers: { 'user-agent': UA, referer: REFERER, cookie: session.cookie },
    timeoutMs: 12_000,
    retries: 1,
  }
  if (signal) options.signal = signal
  const response = await httpRequest('https://api.bilibili.com/x/web-interface/nav', options)
  const body = (await response.json()) as { code: number; data?: { isLogin?: boolean; mid?: number; uname?: string; vipStatus?: number; vipType?: number } }
  const data = body.data ?? {}
  // -101 = 未登录
  return { uid: data.mid ? String(data.mid) : null, nickname: data.uname ?? null, vip: (data.vipStatus ?? 0) === 1 }
}

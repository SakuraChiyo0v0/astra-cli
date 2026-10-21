/**
 * 登录相关的命令逻辑。
 *
 * 关键取舍：**登录要用户拿手机扫，不能让 AI 卡在那里等**。
 * 所以拆成三条命令：
 *   login start   → 立刻返回二维码内容和 unikey，命令结束
 *   login poll    → 查一次状态，立刻返回；AI 隔几秒调一次
 *   login wait    → 阻塞到成功/过期（给人在终端里用，最多 3 分钟）
 * 状态跨进程传递靠 `<ASTRA_HOME>/login-pending.json`（600，用完即删）。
 */
import { readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { homePath } from '../core/paths.ts'
import { AstraError } from '../core/errors.ts'
import { renderQrText, writeQrPng } from '../core/qr.ts'
import { clearSession, fetchAccount, loadSession, pollQrLogin, saveSession, startQrLogin, sessionDigest, type PollState, type Session } from './auth.ts'

const PENDING_TTL_MS = 5 * 60 * 1000

interface Pending {
  unikey: string
  qrContent: string
  startedAt: number
}

function pendingFile(): string {
  return homePath('login-pending.json')
}

function savePending(pending: Pending): void {
  writeFileSync(pendingFile(), JSON.stringify(pending) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(pendingFile(), 0o600)
}

function readPending(): Pending | null {
  try {
    const parsed = JSON.parse(readFileSync(pendingFile(), 'utf8')) as Pending
    if (typeof parsed.unikey !== 'string' || typeof parsed.startedAt !== 'number') return null
    if (Date.now() - parsed.startedAt > PENDING_TTL_MS) return null
    return parsed
  } catch {
    return null
  }
}

function clearPending(): void {
  if (existsSync(pendingFile())) rmSync(pendingFile(), { force: true })
}

const STATE_HINT: Record<PollState, string> = {
  waiting: '用户在网易云 App 里扫码（右上角扫一扫）。过几秒再调 `astra music login poll`',
  scanned: '已扫码，等用户在手机上点确认。过几秒再调 `astra music login poll`',
  expired: '二维码过期了，重新执行 `astra music login start`',
  success: '登录成功',
  unknown: '上游返回了没见过的状态，重新 start 一次；一直这样就说明协议变了',
}

export interface LoginStartView {
  status: 'pending'
  qrContent: string
  /** PNG 文件路径：让 Hermes 直接把图发到聊天里。 */
  qrImage: string
  qrImageSize: number
  /** 发图接口要 base64 时的取法（不进默认输出，免得占满上下文）。 */
  qrPngBase64Hint: string
  /** 终端文本版，发不了图时兜底。 */
  qrText: string
  expiresInSeconds: number
  next: string
}

export async function beginLogin(signal?: AbortSignal): Promise<LoginStartView> {
  const { unikey, qrContent } = await startQrLogin(signal)
  savePending({ unikey, qrContent, startedAt: Date.now() })
  const image = writeQrPng(qrContent, homePath('login-qr.png'), { scale: 8, margin: 4 })
  const text = renderQrText(qrContent)
  return {
    status: 'pending',
    qrContent,
    qrImage: image.path,
    qrImageSize: image.size,
    qrPngBase64Hint: `base64 用 \`base64 < ${image.path}\` 取，长度约 ${Math.round(image.base64.length / 1024)}KB；不要把它打印到对话里`,
    qrText: text.art,
    expiresInSeconds: Math.round(PENDING_TTL_MS / 1000),
    next: '把 data.qrImage 这张 PNG 发给用户（用发图能力，不要打成代码块）；如果发不了图，再把 data.qrText 用等宽代码块发出去。然后每隔 2~3 秒调一次 `astra music login poll`，直到 status 不是 pending',
  }
}

export interface LoginPollView {
  status: 'pending' | 'done' | 'expired' | 'unknown'
  state: PollState
  message: string | null
  account?: { userId: string | null; nickname: string | null; vip: boolean; digest: string }
  next: string
}

async function finish(session: Session, signal?: AbortSignal): Promise<LoginPollView> {
  let account: { userId: string | null; nickname: string | null; vip: boolean } = { userId: null, nickname: null, vip: false }
  try {
    account = await fetchAccount(session, signal)
  } catch {
    // 账号资料拿不到不影响登录本身；会话已经有效
  }
  saveSession({ ...session, userId: account.userId, nickname: account.nickname })
  clearPending()
  return {
    status: 'done',
    state: 'success',
    message: null,
    account: { ...account, digest: sessionDigest(session) },
    next: '登录完成。可以用 `astra music playlists` 看歌单了',
  }
}

export async function pollLogin(signal?: AbortSignal): Promise<LoginPollView> {
  const pending = readPending()
  if (!pending) {
    const existing = loadSession()
    if (existing) {
      return { status: 'done', state: 'success', message: null, account: { userId: existing.userId, nickname: existing.nickname, vip: false, digest: sessionDigest(existing) }, next: '已经是登录状态' }
    }
    throw new AstraError('NO_PENDING_LOGIN', '没有正在进行的登录', { exitCode: 2, hint: '先执行 `astra music login start`' })
  }
  const result = await pollQrLogin(pending.unikey, signal)
  if (result.state === 'success' && result.session) return await finish(result.session, signal)
  if (result.state === 'expired') clearPending()
  return { status: result.state === 'expired' ? 'expired' : result.state === 'unknown' ? 'unknown' : 'pending', state: result.state, message: result.message, next: STATE_HINT[result.state] }
}

/** 给人用的阻塞版：最多等 waitSeconds，期间每 2 秒查一次。 */
export async function waitLogin(waitSeconds: number, signal?: AbortSignal): Promise<LoginPollView> {
  const deadline = Date.now() + waitSeconds * 1000
  let view = await pollLogin(signal)
  while (view.status === 'pending' && Date.now() < deadline && !signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    view = await pollLogin(signal)
  }
  if (view.status === 'pending') {
    return { ...view, next: `等了 ${waitSeconds} 秒还没扫。可以继续 \`astra music login poll\`，或重新 start` }
  }
  return view
}

export interface AccountView {
  loggedIn: boolean
  userId: string | null
  nickname: string | null
  vip: boolean | null
  digest: string | null
  savedAt: string | null
  /** 会话还在但上游不认了。 */
  stale: boolean
}

export async function accountStatus(signal?: AbortSignal): Promise<AccountView> {
  const session = loadSession()
  if (!session) return { loggedIn: false, userId: null, nickname: null, vip: null, digest: null, savedAt: null, stale: false }
  try {
    const account = await fetchAccount(session, signal)
    return { loggedIn: true, userId: account.userId, nickname: account.nickname, vip: account.vip, digest: sessionDigest(session), savedAt: session.savedAt, stale: false }
  } catch {
    return { loggedIn: true, userId: session.userId, nickname: session.nickname, vip: null, digest: sessionDigest(session), savedAt: session.savedAt, stale: true }
  }
}

export function logout(): boolean {
  clearPending()
  return clearSession()
}

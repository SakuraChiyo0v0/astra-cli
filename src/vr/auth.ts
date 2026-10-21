/**
 * VRChat 账号登录与会话保存。
 *
 * 协议（沿用 astrahub 的实测记录）：
 * 1. `GET /auth/user` 带 **Basic** 认证（账号密码各自 URL 编码后 base64）。用 POST 会 405。
 * 2. 成功时 `Set-Cookie` 里那条 `auth=<uuid>` 就是会话。
 * 3. 开了两步验证时，第一步只返回**中间会话**，响应体 `requiresTwoFactorAuth` 给出可用的方式
 *    （`totp` 手机令牌 / `emailOtp` 邮箱验证码）；接着 `POST /auth/twofactorauth/<方式>/verify` 传 `{ code }`。
 * 4. **最终会话用的是第一步的 auth cookie** —— verify 的响应只下发 `twoFactorAuth` 票据，不能当会话用。
 * 5. 退出是 `PUT /logout`。
 *
 * 会话只存 `<ASTRA_HOME>/vr-session.json`，权限 600。
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homePath } from '../core/paths.ts'
import { AstraError } from '../core/errors.ts'
import { getJson, request, basicHeader } from './api.ts'

export interface VrSession {
  /** `auth=<uuid>` 整条 cookie。 */
  cookie: string
  userId: string | null
  displayName: string | null
  savedAt: string
}

/** 两步验证的中间状态：只在进程内与落盘待确认文件里存在，5 分钟有效。 */
export interface PendingTwoFactor {
  cookie: string
  methods: string[]
  username: string
  createdAt: number
}

const PENDING_TTL_MS = 5 * 60 * 1000

function sessionFile(): string {
  return homePath('vr-session.json')
}

function pendingFile(): string {
  return homePath('vr-2fa-pending.json')
}

export function loadSession(): VrSession | null {
  try {
    const parsed = JSON.parse(readFileSync(sessionFile(), 'utf8')) as VrSession
    return typeof parsed.cookie === 'string' && parsed.cookie.includes('auth=') ? parsed : null
  } catch {
    return null
  }
}

export function saveSession(session: VrSession): void {
  const file = sessionFile()
  writeFileSync(file, JSON.stringify(session, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
}

export function clearSession(): boolean {
  if (!existsSync(sessionFile())) return false
  rmSync(sessionFile(), { force: true })
  return true
}

export function cookieOf(session: VrSession): string {
  return session.cookie
}

interface AuthUser {
  id?: string
  displayName?: string
  requiresTwoFactorAuth?: string[]
}

function authCookieFrom(setCookies: string[]): string | null {
  for (const raw of setCookies) {
    const pair = raw.split(';')[0] ?? ''
    const index = pair.indexOf('=')
    if (index > 0 && pair.slice(0, index).trim() === 'auth') return `auth=${pair.slice(index + 1).trim()}`
  }
  return null
}

export type LoginResult =
  | { status: 'done'; session: VrSession }
  | { status: 'needs_2fa'; methods: string[]; next: string }

/** 账号密码登录。需要两步验证时返回中间态，让调用方再调 `submitTwoFactor`。 */
export async function login(username: string, password: string, signal?: AbortSignal): Promise<LoginResult> {
  const { status, data, setCookies } = await request<AuthUser>('GET', '/auth/user', {
    basic: basicHeader(username, password),
    ...(signal ? { signal } : {}),
  })
  const cookie = authCookieFrom(setCookies)
  if (!cookie) {
    throw new AstraError('VRCHAT_NO_COOKIE', '登录没有拿到 auth cookie', {
      exitCode: 5,
      hint: '账号密码可能不对；也可能开了两步验证但没走到验证那步',
    })
  }
  const methods = Array.isArray(data?.requiresTwoFactorAuth) ? data!.requiresTwoFactorAuth : []
  if (methods.length > 0) {
    writePending({ cookie, methods, username, createdAt: Date.now() })
    return {
      status: 'needs_2fa',
      methods,
      next: `让用户把 ${methods.includes('totp') ? '手机验证器里的 6 位码' : '邮箱收到的验证码'} 给你，然后 \`astra vr login 2fa <code>\`。5 分钟内有效`,
    }
  }
  void status
  const session: VrSession = { cookie, userId: data?.id ?? null, displayName: data?.displayName ?? null, savedAt: new Date().toISOString() }
  saveSession(session)
  return { status: 'done', session }
}

function writePending(pending: PendingTwoFactor): void {
  const file = pendingFile()
  writeFileSync(file, JSON.stringify(pending) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
}

export function readPending(): PendingTwoFactor | null {
  try {
    const parsed = JSON.parse(readFileSync(pendingFile(), 'utf8')) as PendingTwoFactor
    if (typeof parsed.cookie !== 'string' || typeof parsed.createdAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

export function clearPending(): void {
  if (existsSync(pendingFile())) rmSync(pendingFile(), { force: true })
}

/** 提交两步验证码。成功后用**第一步拿到的 cookie** 落会话。 */
export async function submitTwoFactor(code: string, signal?: AbortSignal): Promise<VrSession> {
  const pending = readPending()
  if (!pending) {
    throw new AstraError('VRCHAT_NO_PENDING_2FA', '没有待完成的两步验证', {
      exitCode: 2,
      hint: '重新 `astra vr login --username <账号>`；待确认状态 5 分钟有效',
    })
  }
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    clearPending()
    throw new AstraError('VRCHAT_2FA_EXPIRED', '两步验证已过期（5 分钟）', { exitCode: 2, hint: '重新登录' })
  }
  const method = pending.methods.includes('totp') ? 'totp' : 'emailotp'
  await request('POST', `/auth/twofactorauth/${method}/verify`, {
    cookie: pending.cookie,
    body: { code },
    ...(signal ? { signal } : {}),
  })

  // verify 之后用第一步的 cookie 取自己的信息确认会话真的有效
  const me = await getJson<AuthUser>('/auth/user', { cookie: pending.cookie, ...(signal ? { signal } : {}) })
  const session: VrSession = {
    cookie: pending.cookie,
    userId: me.id ?? null,
    displayName: me.displayName ?? null,
    savedAt: new Date().toISOString(),
  }
  saveSession(session)
  clearPending()
  return session
}

export async function logout(): Promise<boolean> {
  const session = loadSession()
  if (!session) return false
  try {
    await request('PUT', '/logout', { cookie: session.cookie })
  } catch {
    // 上游拒绝也要清掉本地会话：用户的本意是登出
  }
  return clearSession()
}

/** 会话是否还有效。返回账号信息，失效则抛错。 */
export async function currentUser(signal?: AbortSignal): Promise<{ id: string; displayName: string; [key: string]: unknown }> {
  const session = loadSession()
  if (!session) throw new AstraError('VRCHAT_NOT_LOGGED_IN', '还没登录 VRChat', { exitCode: 3, hint: '`astra vr login --username <账号> --password <密码>`' })
  return getJson('/auth/user', { cookie: session.cookie, ...(signal ? { signal } : {}) })
}

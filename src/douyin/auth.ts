/**
 * 抖音登录态。
 *
 * 扫码登录这条路已经走不通了（SSO 的 `get_qrcode` 现在只返回登录页 SPA，
 * 页面用 bdms 给 XHR 逐个签名；见 references/douyin-domain.md），所以这里只接受
 * 浏览器里拷出来的 cookie —— 和 `quark cookie set` / `pixiv` 是同一套做法。
 *
 * 存 `<ASTRA_HOME>/douyin-session.json`，写完 chmod 600。
 * 注意：这台机器上 `writeFileSync(..., { mode })` 会被忽略，必须写完再 chmod。
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homePath } from '../core/paths.ts'
import { AstraError, invalidInput } from '../core/errors.ts'

export interface DouyinSession {
  cookie: string
  nickname: string | null
  uid: string | null
  savedAt: string
}

const FILE = 'douyin-session.json'

export function sessionPath(): string {
  return homePath(FILE)
}

export function loadSession(): DouyinSession | null {
  const file = sessionPath()
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DouyinSession>
    if (!parsed.cookie || typeof parsed.cookie !== 'string') return null
    return {
      cookie: parsed.cookie,
      nickname: parsed.nickname ?? null,
      uid: parsed.uid ?? null,
      savedAt: parsed.savedAt ?? '',
    }
  } catch {
    return null
  }
}

export function saveSession(cookie: string, who: { nickname: string | null; uid: string | null }): string {
  const file = sessionPath()
  const record: DouyinSession = { cookie, nickname: who.nickname, uid: who.uid, savedAt: new Date().toISOString() }
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8')
  chmodSync(file, 0o600)
  return file
}

export function clearSession(): boolean {
  const file = sessionPath()
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

/**
 * 把用户粘进来的东西变成 cookie 串。
 *
 * 支持：DevTools 的 Copy as cURL（`-H 'cookie: …'` / `-b '…'`）、裸 cookie 串、
 * 带 `Cookie:` 前缀的一行。httpOnly 的 `sessionid` 只有 cURL 那条路能带出来，
 * 所以要引导用户用 Copy as cURL 而不是 `document.cookie`。
 */
export function parseCookieInput(raw: string): string {
  const text = raw.trim()
  if (!text) throw invalidInput('没有内容', '把浏览器里 Copy as cURL 的整段粘进 stdin：`astra douyin login`')
  const quoted = /(?:-H|--header)\s+['"]cookie:\s*([^'"]+)['"]/i.exec(text)
  if (quoted) return normalize(quoted[1]!)
  const bare = /(?:^|\s)-b\s+['"]([^'"]+)['"]/i.exec(text)
  if (bare) return normalize(bare[1]!)
  const prefixed = /^\s*cookie:\s*(.+)$/im.exec(text)
  if (prefixed) return normalize(prefixed[1]!)
  if (/[;=]/.test(text) && !/\s-H\s/.test(text)) return normalize(text)
  throw invalidInput('没从输入里找到 cookie', '要的是 `cookie: …` 或 `-b \'…\'`；Chrome 里用 Copy as cURL (bash)')
}

function normalize(cookie: string): string {
  const cleaned = cookie.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(' ')
  if (!/sessionid|sid_tt|uid_tt/.test(cleaned)) {
    throw new AstraError('DOUYIN_COOKIE_INCOMPLETE', '这串 cookie 里没有登录凭据（sessionid 之类）', {
      exitCode: 3,
      hint: '确认浏览器里已经登录抖音，再用 Copy as cURL 拷；`document.cookie` 拿不到 httpOnly 的 sessionid',
    })
  }
  return cleaned
}

/**
 * 小黑盒登录态：cookie 存在 `<ASTRA_HOME>/heybox.json`（600）。
 *
 * cookie 等价账号全权（能读也能发），所以：
 *  - 文件权限 600，不进 git、不打印全文（只回显长度和关键字段是否存在）；
 *  - 只给 `link/tree` 这类只读接口用，写接口（评论/发帖）不实现。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homePath } from '../core/paths.ts'
import { AstraError } from '../core/errors.ts'

export interface HeyboxCredential {
  cookie: string
  heyboxId: string
  savedAt: string
}

function credPath(): string {
  return homePath('heybox.json')
}

/** 把浏览器里复制的 `k=v; k2=v2` 解析成对象（容忍换行、多余空格）。 */
export function parseCookie(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of raw.replace(/\n/g, ';').split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

/** 从 cookie 里猜 heybox_id；猜不到就留空，由调用方用接口补。 */
export function guessHeyboxId(cookie: Record<string, string>): string {
  for (const key of ['heybox_id', 'user_heybox_id', 'heyboxid', 'userid']) {
    const value = cookie[key]
    if (value && /^\d+$/.test(value)) return value
  }
  return ''
}

export function saveCredential(raw: string, heyboxId?: string): HeyboxCredential {
  const cookie = parseCookie(raw)
  if (Object.keys(cookie).length === 0) {
    throw invalidCookie('cookie 解析后是空的', '要从浏览器复制整条 `k=v; k2=v2` 串，不是单个值')
  }
  const cred: HeyboxCredential = {
    cookie: Object.entries(cookie).map(([k, v]) => `${k}=${v}`).join('; '),
    heyboxId: heyboxId?.trim() || guessHeyboxId(cookie),
    savedAt: new Date().toISOString(),
  }
  const path = credPath()
  writeFileSync(path, JSON.stringify(cred, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
  return cred
}

export function loadCredential(): HeyboxCredential | null {
  const path = credPath()
  if (!existsSync(path)) return null
  try {
    const cred = JSON.parse(readFileSync(path, 'utf8')) as HeyboxCredential
    return cred.cookie ? cred : null
  } catch {
    return null
  }
}

export function clearCredential(): boolean {
  const path = credPath()
  if (!existsSync(path)) return false
  writeFileSync(path, '')
  chmodSync(path, 0o600)
  return true
}

export function cookieHeader(cred: HeyboxCredential): string {
  return cred.cookie
}

function invalidCookie(message: string, hint: string) {
  return new AstraError('INVALID_INPUT', message, { hint })
}

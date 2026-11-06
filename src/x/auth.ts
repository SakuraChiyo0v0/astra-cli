/**
 * X / Twitter 登录态：cookie 存 `<ASTRA_HOME>/x.json`（600）。
 *
 * 只存两个值就够（`auth_token` + `ct0`）：X 的会话全靠它们，其余 cookie 是设备指纹，
 * 抓取工具会自己补。cookie 等价账号全权，所以文件 600、只在输出里给脱敏值。
 *
 * 输入支持两种形状，从浏览器直接复制即可：
 *  - `cookies.txt`（Netscape 7 列、tab 分隔），导出整份文件最省事；
 *  - `auth_token=…; ct0=…` 这种 `k=v; k2=v2` 串。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homePath } from '../core/paths.ts'
import { invalidInput } from '../core/errors.ts'

export interface XCredential {
  authToken: string
  ct0: string
  savedAt: string
  screenName?: string
}

const COOKIE_NAMES = ['auth_token', 'ct0'] as const

export function credPath(): string {
  return homePath('x.json')
}

export function cookieTxtPath(): string {
  return homePath('x-cookies.txt')
}

/**
 * 解析 cookie 输入。两种格式混在一份文本里也能处理（Netscape 行认列，其余按 `k=v` 拆），
 * 因为用户常常把整份导出文件和手抄的两行一起粘进来。
 */
export function parseXCookie(raw: string): { authToken: string; ct0: string } {
  const values: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const cols = text.split('\t')
    if (cols.length >= 7) {
      values[cols[5]!.trim()] = cols[6]!.trim()
      continue
    }
    for (const part of text.split(';')) {
      const idx = part.indexOf('=')
      if (idx <= 0) continue
      values[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
    }
  }
  const authToken = values.auth_token ?? ''
  const ct0 = values.ct0 ?? ''
  if (!authToken || !ct0) {
    const missing = COOKIE_NAMES.filter((n) => !values[n])
    throw invalidInput(
      `cookie 里缺少 ${missing.join(' / ')}`,
      '浏览器登录 x.com 后 F12 → Application → Cookies → https://x.com，导出整份 cookies.txt 最稳',
    )
  }
  return { authToken, ct0 }
}

/** 只在回显里用：保留尾 4 位够辨认是哪一个账号的会话，其余打掉。 */
export function maskSecret(value: string): string {
  if (!value) return ''
  const tail = value.slice(-4)
  return `****${tail}（${value.length} 位）`
}

export function saveCredential(raw: string, screenName?: string): XCredential {
  const { authToken, ct0 } = parseXCookie(raw)
  const cred: XCredential = {
    authToken,
    ct0,
    savedAt: new Date().toISOString(),
    ...(screenName ? { screenName } : {}),
  }
  const path = credPath()
  writeFileSync(path, JSON.stringify(cred, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
  writeCookieFile(cred)
  return cred
}

export function loadCredential(): XCredential | null {
  const path = credPath()
  if (!existsSync(path)) return null
  try {
    const cred = JSON.parse(readFileSync(path, 'utf8')) as XCredential
    return cred.authToken && cred.ct0 ? cred : null
  } catch {
    return null
  }
}

export function clearCredential(): boolean {
  const path = credPath()
  if (!existsSync(path)) return false
  writeFileSync(path, '', { mode: 0o600 })
  chmodSync(path, 0o600)
  return true
}

/**
 * gallery-dl 只吃 Netscape 格式，所以登录时顺手生成一份；不要求用户自己转格式。
 * 过期时间随便给（180 天）：X 那边作废了这里也不会更糟，报错是「未登录」。
 */
export function writeCookieFile(cred: XCredential): string {
  const exp = Math.floor(Date.now() / 1000) + 180 * 24 * 3600
  const lines = [
    '# Netscape HTTP Cookie File',
    `.x.com\tTRUE\t/\tTRUE\t${exp}\tauth_token\t${cred.authToken}`,
    `.x.com\tTRUE\t/\tTRUE\t${exp}\tct0\t${cred.ct0}`,
  ]
  const path = cookieTxtPath()
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

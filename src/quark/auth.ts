/**
 * 夸克 cookie 存取：`<ASTRA_HOME>/quark.json`，600。
 *
 * 为什么要单独存：分享列表不需要登录，但**下载大文件（>100MB）必须带登录态**，
 * 而且只有登录后会员速度才生效（实测 SVIP 15MB/s）。
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homePath } from '../core/paths.ts'

export interface QuarkCredential {
  cookie: string
  savedAt: string
}

function credentialFile(): string {
  return homePath('quark.json')
}

export function loadQuarkCredential(): QuarkCredential | null {
  try {
    const parsed = JSON.parse(readFileSync(credentialFile(), 'utf8')) as QuarkCredential
    return typeof parsed.cookie === 'string' && parsed.cookie.trim() ? parsed : null
  } catch {
    return null
  }
}

export function loadQuarkCookie(): string | null {
  return loadQuarkCredential()?.cookie ?? null
}

export function saveQuarkCookie(cookie: string): QuarkCredential {
  const credential: QuarkCredential = { cookie: cookie.trim(), savedAt: new Date().toISOString() }
  // 这台机器上 writeFileSync 的 mode 不生效，写完必须 chmod
  writeFileSync(credentialFile(), JSON.stringify(credential, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(credentialFile(), 0o600)
  return credential
}

export function clearQuarkCookie(): boolean {
  if (!existsSync(credentialFile())) return false
  rmSync(credentialFile(), { force: true })
  return true
}

/**
 * 从用户粘贴的东西里抠出 cookie 串。
 * 支持三种输入：裸 cookie、`Cookie: xxx`、浏览器复制的 `name=value; ...`。
 */
export function normalizeCookieInput(input: string): string {
  const trimmed = input.trim().replace(/^cookie\s*:\s*/i, '')
  return trimmed.replace(/\s+/g, ' ')
}

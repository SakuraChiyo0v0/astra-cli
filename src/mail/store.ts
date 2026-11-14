/**
 * 邮箱账号的读写：`<ASTRA_HOME>/mail.json`（600）。
 *
 * 约定：
 * - 只存 IMAP 授权码（应用专用密码），文件权限 600，回显一律 `maskSecret()`
 * - 一个邮箱一条记录，`default` 指向默认读的那个
 * - 删到只剩一个时自动把 default 指向它，避免「配了但没默认」
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { invalidInput } from '../core/errors.ts'
import { homePath } from '../core/paths.ts'
import type { MailAccount, MailStore } from './types.ts'

export function storePath(): string {
  return homePath('mail.json')
}

export function emptyStore(): MailStore {
  return { version: 1, accounts: {} }
}

export function loadStore(): MailStore {
  const file = storePath()
  if (!existsSync(file)) return emptyStore()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<MailStore>
    const accounts = (raw.accounts ?? {}) as Record<string, MailAccount>
    const store: MailStore = { version: 1, accounts }
    if (raw.default && accounts[raw.default]) store.default = raw.default
    return store
  } catch {
    return emptyStore()
  }
}

export function saveStore(store: MailStore): void {
  const file = storePath()
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

/** `abcd1234efgh` → `abcd…gh`；太短整体遮掉。 */
export function maskSecret(secret: string): string {
  const value = (secret ?? '').trim()
  if (!value) return '***'
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}…${value.slice(-2)}`
}

/**
 * 按邮箱域名猜 IMAP 主机。
 *
 * 猜不出来就直接报错让人给 `--host` —— 猜错的代价是「连上了但不是那个邮箱」，
 * 比明确要求多打一个参数更糟。
 */
export function guessHost(email: string): string {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  const table: Record<string, string> = {
    'qq.com': 'imap.qq.com',
    'foxmail.com': 'imap.qq.com',
    'vip.qq.com': 'imap.qq.com',
    '163.com': 'imap.163.com',
    '126.com': 'imap.126.com',
    'yeah.net': 'imap.yeah.net',
    'gmail.com': 'imap.gmail.com',
    'googlemail.com': 'imap.gmail.com',
    'outlook.com': 'outlook.office365.com',
    'hotmail.com': 'outlook.office365.com',
    'live.com': 'outlook.office365.com',
    'qq.com.cn': 'imap.qq.com',
    'sina.com': 'imap.sina.com',
    'sohu.com': 'imap.sohu.com',
    'aliyun.com': 'imap.aliyun.com',
  }
  const host = table[domain]
  if (!host) {
    throw invalidInput(
      `认不出 ${domain || '(空域名)'} 的 IMAP 服务器`,
      '加 --host imap.example.com（QQ/163/Gmail/Outlook 会自动认）',
    )
  }
  return host
}

export function upsertAccount(store: MailStore, account: MailAccount, makeDefault: boolean): MailStore {
  store.accounts[account.name] = account
  if (makeDefault || !store.default) store.default = account.name
  return store
}

export function removeAccount(store: MailStore, name: string): boolean {
  if (!store.accounts[name]) return false
  delete store.accounts[name]
  if (store.default === name) {
    const left = Object.keys(store.accounts)
    if (left.length > 0) store.default = left[0]
    else delete store.default
  }
  return true
}

/** 取要用的账号：给了名字就用它，否则用 default，再否则用唯一的那个。 */
export function resolveAccount(store: MailStore, name: string): MailAccount {
  const key = name.trim() || store.default || Object.keys(store.accounts)[0] || ''
  const account = key ? store.accounts[key] : undefined
  if (!account) {
    const known = Object.keys(store.accounts)
    throw invalidInput(
      known.length === 0 ? '还没有配置邮箱' : `没有账号 ${key}（已配置：${known.join('、')}）`,
      'astra mail login qq 123456@qq.com（授权码走 stdin，不是登录密码）',
    )
  }
  return account
}

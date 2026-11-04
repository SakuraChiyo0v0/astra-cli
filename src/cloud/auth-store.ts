/**
 * 云盘凭证存取：`<ASTRA_HOME>/cloud-<id>.json`，600。
 *
 * 为什么按 provider 分文件而不是塞进一个 json：夸克只要 cookie，百度要 access_token +
 * refresh_token + client_id，字段完全不同，混存容易把 A 的字段读成 B 的。
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homePath } from '../core/paths.ts'

export interface CloudCredential {
  /** 夸克：整段 cookie；百度：BDUSS（可选，用于提速） */
  cookie?: string
  /** 百度 OAuth access_token（30 天） */
  accessToken?: string
  /** 百度 refresh_token（可续期） */
  refreshToken?: string
  /** 百度开放平台 AppKey（OAuth client_id），用于重新生成授权链接 */
  appKey?: string
  savedAt: string
}

export type CloudId = 'quark' | 'baidu'

function credentialFile(id: CloudId): string {
  return homePath(`cloud-${id}.json`)
}

export function loadCloudCredential(id: CloudId): CloudCredential | null {
  try {
    const parsed = JSON.parse(readFileSync(credentialFile(id), 'utf8')) as CloudCredential
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function saveCloudCredential(id: CloudId, cred: Omit<CloudCredential, 'savedAt'>): CloudCredential {
  const full: CloudCredential = { ...cred, savedAt: new Date().toISOString() }
  const file = credentialFile(id)
  writeFileSync(file, JSON.stringify(full, null, 2) + '\n', 'utf8')
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows 之类不支持 chmod，忽略
  }
  return full
}

export function clearCloudCredential(id: CloudId): boolean {
  const file = credentialFile(id)
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

/** 只显示前后各 4 位，够判断"是不是换了 token"，又不会把凭证写进聊天记录。 */
export function maskSecret(value: string | undefined): string {
  if (!value) return '（未配置）'
  const v = value.trim()
  if (v.length <= 10) return v.slice(0, 2) + '***'
  return `${v.slice(0, 4)}…${v.slice(-4)}（${v.length} 字符）`
}

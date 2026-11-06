/**
 * 身份解析：**谁在调用 astra**。
 *
 * 顺序（M1 只解析，不拦）：
 * 1. `ASTRA_TOKEN`（环境变量，机器人/多用户场景）
 * 2. `<ASTRA_HOME>/token` 文件（本机长期令牌，600）
 * 3. 都没有 → 本机 owner（保证现有用法零改动）
 *
 * 令牌形如 `astra_<64 hex>`，库里只存 sha256，明文只出现一次。
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmodSync, writeFileSync } from 'node:fs'
import { homePath } from './paths.ts'

export type PrincipalKind = 'owner' | 'user' | 'bot' | 'service'

export interface Identity {
  /** 主体 id；没有令牌时固定 `owner`。 */
  id: string
  kind: PrincipalKind
  name: string
  /** 令牌来源；`local` 表示没有令牌。 */
  source: 'env' | 'file' | 'local'
  tokenId?: string
}

/** 没有令牌时的主体：本机使用者。 */
export const LOCAL_OWNER_ID = 'owner'

let cached: Identity | null = null

/** 主流程解析完身份后写进来，审计等同步路径直接读。 */
export function setIdentity(identity: Identity): void {
  cached = identity
}

export function currentIdentity(): Identity {
  return cached ?? { id: LOCAL_OWNER_ID, kind: 'owner', name: 'owner', source: 'local' }
}

/** 本次调用带的令牌（没有就是 null）。 */
export function readToken(): { token: string; source: 'env' | 'file' } | null {
  const fromEnv = process.env.ASTRA_TOKEN?.trim()
  if (fromEnv) return { token: fromEnv, source: 'env' }
  try {
    const fromFile = readFileSync(homePath('token'), 'utf8').trim()
    if (fromFile !== '') return { token: fromFile, source: 'file' }
  } catch {
    // 没文件就是没配，正常路径
  }
  return null
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newToken(): string {
  return `astra_${randomBytes(32).toString('hex')}`
}

/** 把令牌存到 `<ASTRA_HOME>/token`（600）。 */
export function saveLocalToken(token: string): string {
  const file = homePath('token')
  writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
  return file
}

/** 只回显尾部，日志/表格里用。 */
export function maskToken(token: string): string {
  if (token.length <= 12) return '***'
  return `${token.slice(0, 10)}…${token.slice(-4)}`
}

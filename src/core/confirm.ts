/**
 * 写操作的二次确认。
 *
 * 所有会改动用户真实账号的操作（音乐点红心、VRChat 加好友 / 发邀请 / 收藏……）都走这一套：
 *
 * 1. 第一次调用**不执行**，只返回"将要做什么"的预览 + 一次性令牌
 * 2. 令牌 5 分钟有效、只能用一次、绑定动作 + 参数集合
 * 3. 必须带着令牌再调一次才真正执行
 *
 * 这样 AI 没法一句话就把用户的账号改了 —— 它必须先把预览拿给用户看。
 *
 * 待确认状态按"用途"分文件存（`<ASTRA_HOME>/pending-<purpose>.json`），
 * 所以音乐和 VRChat 各自有各自的待办，不会互相覆盖。
 */
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homePath } from './paths.ts'
import { AstraError } from './errors.ts'

export const CONFIRM_TTL_MS = 5 * 60 * 1000

export interface PendingAction {
  token: string
  /** 动作名，例如 `like` / `unlike` / `favorite.add`。 */
  action: string
  /** 令牌绑定的参数指纹，防篡改。 */
  binding: string
  /** 给用户看的预览（原样返回，确认时也要展示）。 */
  preview: unknown
  createdAt: number
}

function pendingFile(purpose: string): string {
  return homePath(`pending-${purpose}.json`)
}

/** 参数集合的稳定指纹：排序后拼起来再哈希，顺序不影响。 */
function bindingOf(action: string, params: unknown): string {
  return createHash('sha256').update(action).update(JSON.stringify(deepSort(params))).digest('hex').slice(0, 24)
}

function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSort)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, deepSort(v)]))
  }
  return value
}

function makeToken(): string {
  return createHash('sha256').update(randomUUID()).digest('hex').slice(0, 16)
}

export interface PreparedPreview {
  status: 'needs_confirmation'
  action: string
  token: string
  expiresInSeconds: number
  preview: unknown
  /** 告诉 AI 下一步怎么做。 */
  next: string
}

/**
 * 生成待确认操作，不执行任何动作。
 * `instruction` 是给 AI 的具体指引（不同写操作的措辞不一样）。
 */
export function prepare(purpose: string, action: string, params: unknown, preview: unknown, instruction: string): PreparedPreview {
  const token = makeToken()
  const pending: PendingAction = { token, action, binding: bindingOf(action, params), preview, createdAt: Date.now() }
  const file = pendingFile(purpose)
  writeFileSync(file, JSON.stringify(pending) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
  return {
    status: 'needs_confirmation',
    action,
    token,
    expiresInSeconds: Math.round(CONFIRM_TTL_MS / 1000),
    preview,
    next: `${instruction} 5 分钟内有效；不要自己拼令牌或跳过确认`,
  }
}

/** 读取待确认操作，不校验令牌。 */
export function readPending(purpose: string): PendingAction | null {
  try {
    const parsed = JSON.parse(readFileSync(pendingFile(purpose), 'utf8')) as PendingAction
    if (typeof parsed.token !== 'string' || typeof parsed.createdAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

export function clearPending(purpose: string): boolean {
  const file = pendingFile(purpose)
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

/**
 * 校验令牌并取出待执行的动作。通过后**不立刻清掉** —— 调用方执行完再调 `clearPending`，
 * 这样"执行失败还能重试"和"成功后才作废"能分开。
 */
export function consume(purpose: string, token: string, expectedAction?: string): PendingAction {
  const pending = readPending(purpose)
  if (!pending) {
    throw new AstraError('NO_PENDING_ACTION', '没有待确认的操作', { exitCode: 2, hint: '先生成预览（不带 --confirm 调一次）' })
  }
  if (pending.token !== token) {
    throw new AstraError('TOKEN_MISMATCH', '确认令牌对不上', { exitCode: 2, hint: '重新生成预览；不要手工拼令牌' })
  }
  if (expectedAction !== undefined && pending.action !== expectedAction) {
    throw new AstraError('ACTION_MISMATCH', `令牌属于「${pending.action}」，不是「${expectedAction}」`, { exitCode: 2, hint: '重新生成预览' })
  }
  if (Date.now() - pending.createdAt > CONFIRM_TTL_MS) {
    clearPending(purpose)
    throw new AstraError('TOKEN_EXPIRED', '确认令牌已过期（5 分钟）', { exitCode: 2, hint: '重新生成预览' })
  }
  return pending
}

/** 令牌是否和给定参数匹配（防止执行阶段参数被换掉）。 */
export function bindingMatches(pending: PendingAction, params: unknown): boolean {
  return pending.binding === bindingOf(pending.action, params)
}

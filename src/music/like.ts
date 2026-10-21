/**
 * 红心 / 取消红心（写操作，会改动用户真实的网易云账号）。
 *
 * 实测（2026-10-21，VIP 账号）：
 * - `POST /weapi/song/like` { trackId, like: 'true' | 'false', time: 0 } → `{ code: 200, playlistId }`
 * - **幂等**：重复红心 / 重复取消都返回 200，不报错
 * - **不支持批量**：传 `trackIds` 数组返回 400「请求参数错误」，只能一首一首来
 * - 下架歌返回 `code: 401`「下架歌曲无法收藏」
 * - 取消红心的响应里也带 `playlistId`，那是"我喜欢的音乐"歌单 id，不是错误
 *
 * ## 为什么要有确认令牌
 *
 * 这是写操作，AI 误解一句"把这首加进去"就可能改动用户的歌单。所以：
 * 1. `liked --like <ref>` **不直接执行**，只返回一份"将要做什么"的预览和一次性令牌
 * 2. 令牌 5 分钟内有效、只能用一次、绑定具体操作
 * 3. 必须带着令牌再调一次才真正执行
 *
 * 这样 AI 必须先把"我要给哪几首点红心"拿给用户看，用户点头后才有第二步。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { homePath } from '../core/paths.ts'
import { AstraError } from '../core/errors.ts'
import { weapiPost } from './account-api.ts'
import type { Session } from './auth.ts'

const TOKEN_TTL_MS = 5 * 60 * 1000

export interface PendingLike {
  token: string
  action: 'like' | 'unlike'
  /** 要操作的曲目 id，按用户给的顺序。 */
  trackIds: string[]
  /** 给用户看的描述，确认时原样展示。 */
  titles: { id: string; title: string; artists: string[]; currentlyLiked: boolean }[]
  createdAt: number
}

function pendingFile(): string {
  return homePath('like-pending.json')
}

export function readPending(): PendingLike | null {
  try {
    const parsed = JSON.parse(readFileSync(pendingFile(), 'utf8')) as PendingLike
    if (typeof parsed.token !== 'string' || !Array.isArray(parsed.trackIds)) return null
    return parsed
  } catch {
    return null
  }
}

function savePending(pending: PendingLike): void {
  const file = pendingFile()
  writeFileSync(file, JSON.stringify(pending) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
}

export function clearPending(): boolean {
  const file = pendingFile()
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

/** 令牌绑定"动作 + 曲目集合"，篡改任何一个都对不上。 */
function makeToken(action: string, trackIds: string[]): string {
  const material = `${action}:${[...trackIds].sort().join(',')}:${randomUUID()}`
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

export interface PreviewResult {
  status: 'needs_confirmation'
  action: 'like' | 'unlike'
  token: string
  expiresInSeconds: number
  tracks: PendingLike['titles']
  /** 已经处于目标状态的会被跳过，不当作失败。 */
  willChange: number
  willSkip: number
  next: string
}

/**
 * 生成"待确认"的操作，不执行。
 * `currentlyLiked` 由调用方先查好，用来告诉用户"这首本来就是红的，不用再点"。
 */
export function prepareLike(action: 'like' | 'unlike', tracks: PendingLike['titles']): PreviewResult {
  const need = tracks.filter((t) => (action === 'like' ? !t.currentlyLiked : t.currentlyLiked))
  const token = makeToken(action, need.map((t) => t.id))
  const pending: PendingLike = { token, action, trackIds: need.map((t) => t.id), titles: tracks, createdAt: Date.now() }
  savePending(pending)
  return {
    status: 'needs_confirmation',
    action,
    token,
    expiresInSeconds: Math.round(TOKEN_TTL_MS / 1000),
    tracks,
    willChange: need.length,
    willSkip: tracks.length - need.length,
    next:
      need.length === 0
        ? `这些歌${action === 'like' ? '已经都是红心' : '本来就没红心'}，不需要改动；直接告诉用户即可`
        : `把 tracks 列给用户确认（${action === 'like' ? '点红心' : '取消红心'}），用户同意后执行 `+
          `\`astra music liked --confirm ${token}\`。5 分钟内有效`,
  }
}

export interface ApplyResult {
  action: 'like' | 'unlike'
  changed: { id: string; title: string; ok: boolean; error: string | null }[]
  changedCount: number
  failedCount: number
}

/**
 * 执行待确认的操作。令牌必须存在、未过期、和当前待办匹配。
 * 一首一首来：实测批量接口返回 400。
 */
export async function applyLike(token: string, session: Session, signal?: AbortSignal): Promise<ApplyResult> {
  const pending = readPending()
  if (!pending) {
    throw new AstraError('NO_PENDING_LIKE', '没有待确认的红心操作', { exitCode: 2, hint: '先 `astra music liked --like <ref>` 生成预览' })
  }
  if (pending.token !== token) {
    throw new AstraError('TOKEN_MISMATCH', '确认令牌对不上', { exitCode: 2, hint: '重新生成预览；不要手工拼令牌' })
  }
  if (Date.now() - pending.createdAt > TOKEN_TTL_MS) {
    clearPending()
    throw new AstraError('TOKEN_EXPIRED', '确认令牌已过期（5 分钟）', { exitCode: 2, hint: '重新 `liked --like <ref>` 生成预览' })
  }

  const flag = pending.action === 'like' ? 'true' : 'false'
  const changed: ApplyResult['changed'] = []
  for (const id of pending.trackIds) {
    if (signal?.aborted) throw new AstraError('CANCELLED', '已取消', { exitCode: 130 })
    const title = pending.titles.find((t) => t.id === id)?.title ?? id
    try {
      const body = await weapiPost<{ code?: number; message?: string; playlistId?: number }>('/weapi/song/like', { trackId: Number(id), like: flag, time: 0 }, session, signal)
      const ok = (body.code ?? 200) === 200
      changed.push({ id, title, ok, error: ok ? null : (body.message ?? `code=${String(body.code)}`) })
    } catch (err) {
      // 单首失败不中断整批，但如实记下来
      changed.push({ id, title, ok: false, error: (err as Error).message.slice(0, 160) })
    }
  }
  clearPending()
  const failed = changed.filter((c) => !c.ok)
  return {
    action: pending.action,
    changed,
    changedCount: changed.length - failed.length,
    failedCount: failed.length,
  }
}

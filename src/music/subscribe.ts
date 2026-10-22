/**
 * 订阅：定时盯一个歌单 / 专辑 / 歌手，出新歌就自动下。
 *
 * 这是"AI 代替我盯着"的形态：不用每天问，它自己发现新歌、下好、推飞书。
 *
 * 判断"哪些是新歌"用的是**曲目集合差集**，不是上架时间 —— 网易云的 publishTime 对旧歌重发、
 * 精选集都不准。第一次订阅时只记基线、不下载（除非 `--download-existing`），
 * 否则等于把整个歌单重下一遍。
 *
 * 调度不常驻：靠系统 cron / Hermes 的定时任务调 `astra music subscribe run`。
 * 每次 run 只处理"到点的"订阅，所以调得比 every_hours 勤也没关系。
 */
import { randomUUID } from 'node:crypto'
import { db } from '../core/db.ts'
import { AstraError, invalidInput } from '../core/errors.ts'
import { progress } from '../core/output.ts'
import { getConfig } from '../core/config.ts'
import { artistTopTracks, albumInfo, playlistTracks, type Track } from './netease.ts'
import { createJob, spawnWorker } from '../core/jobs.ts'
import { jobItemsFor, MUSIC_DOMAIN } from './jobs.ts'
import { findTrack } from './library.ts'
import type { Quality } from './audio.ts'

export type SubscribeKind = 'playlist' | 'album' | 'artist'

export interface Subscription {
  id: string
  kind: SubscribeKind
  targetId: string
  title: string
  quality: Quality | null
  everyHours: number
  enabled: boolean
  lastCheckedAt: string | null
  /** 上次见到的曲目 id；null 表示还没跑过基线。 */
  lastSeen: string[] | null
  lastJobId: string | null
  createdAt: string
}

interface Row {
  id: string
  kind: string
  target_id: string
  title: string
  quality: string | null
  every_hours: number
  enabled: number
  last_checked_at: string | null
  last_seen: string | null
  last_job_id: string | null
  created_at: string
}

function fromRow(row: Row): Subscription {
  return {
    id: row.id,
    kind: row.kind as SubscribeKind,
    targetId: row.target_id,
    title: row.title,
    quality: row.quality as Quality | null,
    everyHours: row.every_hours,
    enabled: row.enabled === 1,
    lastCheckedAt: row.last_checked_at,
    lastSeen: row.last_seen ? (JSON.parse(row.last_seen) as string[]) : null,
    lastJobId: row.last_job_id,
    createdAt: row.created_at,
  }
}

export function listSubscriptions(): Subscription[] {
  return (db().prepare('select * from subscriptions order by created_at').all() as unknown as Row[]).map(fromRow)
}

export function findSubscription(idOrPrefix: string): Subscription {
  const rows = db().prepare('select * from subscriptions where id = ? or id like ?').all(idOrPrefix, `${idOrPrefix}%`) as unknown as Row[]
  if (rows.length === 0) throw new AstraError('NOT_FOUND', `没有订阅 ${idOrPrefix}`, { exitCode: 4, hint: '用 `astra music subscribe list` 看已有的' })
  if (rows.length > 1) throw new AstraError('AMBIGUOUS_ID', `订阅 id 前缀 ${idOrPrefix} 对多个订阅`, { exitCode: 2, hint: '多写几位' })
  return fromRow(rows[0]!)
}

export function addSubscription(input: { kind: SubscribeKind; targetId: string; title: string; everyHours: number; quality: Quality | null }): Subscription {
  const existing = db().prepare('select * from subscriptions where kind = ? and target_id = ?').get(input.kind, input.targetId) as Row | undefined
  if (existing) throw new AstraError('ALREADY_SUBSCRIBED', `已经在订阅「${existing.title}」了`, {
    exitCode: 2,
    hint: `订阅 id ${existing.id}；改间隔用 \`astra music subscribe set ${existing.id} --every ...\``,
  })
  const id = randomUUID().slice(0, 8)
  db()
    .prepare(
      `insert into subscriptions (id, kind, target_id, title, quality, every_hours, enabled, created_at)
       values (?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(id, input.kind, input.targetId, input.title, input.quality, input.everyHours, new Date().toISOString())
  return findSubscription(id)
}

export function removeSubscription(idOrPrefix: string): boolean {
  const sub = findSubscription(idOrPrefix)
  return db().prepare('delete from subscriptions where id = ?').run(sub.id).changes > 0
}

export function setSubscription(idOrPrefix: string, patch: { everyHours?: number; enabled?: boolean; quality?: Quality | null }): Subscription {
  const sub = findSubscription(idOrPrefix)
  const sets: string[] = []
  const values: (string | number | null)[] = []
  if (patch.everyHours !== undefined) {
    sets.push('every_hours = ?')
    values.push(patch.everyHours)
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?')
    values.push(patch.enabled ? 1 : 0)
  }
  if (patch.quality !== undefined) {
    sets.push('quality = ?')
    values.push(patch.quality)
  }
  if (sets.length === 0) throw invalidInput('没有要改的东西', '可用：--every <小时> / --enable / --disable / --quality <档位>')
  values.push(sub.id)
  db().prepare(`update subscriptions set ${sets.join(', ')} where id = ?`).run(...values)
  return findSubscription(sub.id)
}

/** 取订阅对象当前的曲目。 */
export async function fetchSubscriptionTracks(sub: Subscription, signal?: AbortSignal): Promise<Track[]> {
  if (sub.kind === 'playlist') return (await playlistTracks(sub.targetId, signal)).tracks
  if (sub.kind === 'album') return (await albumInfo(sub.targetId, signal)).tracks
  return (await artistTopTracks(sub.targetId, signal)).tracks
}

export interface RunResult {
  subscriptionId: string
  title: string
  kind: SubscribeKind
  /** 本次新发现、之前没见过的曲目数。 */
  newTracks: number
  /** 最后真的开了下载任务的曲目（已经在库里的不算）。 */
  downloaded: number
  jobId: string | null
  /** 第一次跑只记基线，不下载。 */
  baseline: boolean
  note: string | null
}

/**
 * 跑一个订阅：取当前曲目 → 和上次的快照比 → 差集里不在曲库的开任务下载。
 *
 * `baselineOnly` 为 true 时只记快照不下载（第一次订阅默认这样，除非用户明确要求下已有的）。
 */
export async function runSubscription(sub: Subscription, options: { baselineOnly?: boolean; signal?: AbortSignal; force?: boolean } = {}): Promise<RunResult> {
  if (!sub.enabled) return { subscriptionId: sub.id, title: sub.title, kind: sub.kind, newTracks: 0, downloaded: 0, jobId: null, baseline: false, note: '订阅已停用' }

  const tracks = await fetchSubscriptionTracks(sub, options.signal)
  const currentIds = tracks.map((t) => t.id)
  const previous = sub.lastSeen
  // 第一次跑（或上次没存快照）：只记基线
  const baseline = previous === null || options.force === true
  const newTracks = baseline ? [] : tracks.filter((t) => !previous!.includes(t.id))
  const toDownload = options.baselineOnly ? [] : newTracks.filter((t) => findTrack('wy', t.id) === null)

  let jobId: string | null = null
  let note: string | null = null
  if (toDownload.length > 0) {
    // 订阅没指定档位时继承 `music.quality`，不是写死 flac ——
    // 用户把默认改成 320k 省流量，订阅却还按 flac 下，等于配置没生效
    const quality = (sub.quality ?? getConfig('music.quality')) as Quality
    const job = createJob({ domain: MUSIC_DOMAIN, kind: 'subscription', title: `订阅「${sub.title}」新增 ${toDownload.length} 首`, profile: quality, items: jobItemsFor(toDownload, quality) })
    spawnWorker(MUSIC_DOMAIN, job.id)
    jobId = job.id
    note = `开了后台任务 ${job.id}`
  } else if (newTracks.length > 0) {
    note = '新歌都已在曲库'
  }

  const now = new Date().toISOString()
  db()
    .prepare('update subscriptions set last_checked_at = ?, last_seen = ?, last_job_id = coalesce(?, last_job_id) where id = ?')
    .run(now, JSON.stringify(currentIds), jobId, sub.id)
  db()
    .prepare('insert or replace into subscription_runs (subscription_id, ran_at, new_tracks, job_id, note) values (?, ?, ?, ?, ?)')
    .run(sub.id, now, newTracks.length, jobId, note)

  progress('subscribe.run', { id: sub.id, title: sub.title, total: tracks.length, new: newTracks.length, queued: toDownload.length, baseline })

  return {
    subscriptionId: sub.id,
    title: sub.title,
    kind: sub.kind,
    newTracks: newTracks.length,
    downloaded: toDownload.length,
    jobId,
    baseline,
    note: baseline ? '第一次检查：只记了当前曲目作为基线，不会把已有的全下一遍' : note,
  }
}

/** 到点该跑的订阅（上次检查超过 every_hours，或从没跑过）。 */
export function dueSubscriptions(now = Date.now()): Subscription[] {
  return listSubscriptions().filter((sub) => {
    if (!sub.enabled) return false
    if (sub.lastCheckedAt === null) return true
    return now - Date.parse(sub.lastCheckedAt) >= sub.everyHours * 3600_000
  })
}

export function recentRuns(subscriptionId: string, limit = 10): { ranAt: string; newTracks: number; jobId: string | null; note: string | null }[] {
  return (
    db().prepare('select * from subscription_runs where subscription_id = ? order by ran_at desc limit ?').all(subscriptionId, limit) as unknown as {
      ran_at: string
      new_tracks: number
      job_id: string | null
      note: string | null
    }[]
  ).map((r) => ({ ranAt: r.ran_at, newTracks: r.new_tracks, jobId: r.job_id, note: r.note }))
}

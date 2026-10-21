/**
 * B 站订阅：定时盯一个合集 / 系列 / 收藏夹，出新视频自动下载。
 *
 * 复用音乐那边的 `subscriptions` 表（kind 前缀 `bili-` 区分），不另建表 ——
 * "间隔 / 启停 / last_seen / run" 这套语义对两边是一样的。
 *
 * **判断新视频用集合差集**，不用发布时间：B 站的时间字段不可靠（重投、精修会改），
 * 而"上次见到的 bvid 列表"是确定的。第一次跑只记基线，不把整个合集重下一遍。
 *
 * 为什么不做"订阅 UP 主"：UP 投稿列表接口带签名也返回 -352 风控（实测），
 * 硬啃只会一直失败。合集 / 系列 / 收藏夹的接口是稳的。
 */
import { randomUUID } from 'node:crypto'
import { db } from '../core/db.ts'
import { AstraError } from '../core/errors.ts'
import { progress } from '../core/output.ts'
import { createJob, spawnWorker } from '../core/jobs.ts'
import { collectionToItems, BILI_DOMAIN } from './jobs.ts'
import { fetchFavorite, fetchSeasonArchives, fetchSeriesArchives, parseCollectionRef, type Collection } from './collection.ts'

export type BiliSubscribeKind = 'bili-season' | 'bili-series' | 'bili-fav'

export interface BiliSubscription {
  id: string
  kind: BiliSubscribeKind
  /** `season:<mid>/<sid>` / `series:<mid>/<sid>` / `fav:<id>`，可直接再解析。 */
  targetId: string
  title: string
  quality: string | null
  everyHours: number
  enabled: boolean
  lastCheckedAt: string | null
  /** 上次见到的 bvid 列表。 */
  lastSeen: string[]
  lastJobId: string | null
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
}

const KIND_PREFIX = 'bili-'

function toView(row: Row): BiliSubscription {
  let lastSeen: string[] = []
  try {
    const parsed = JSON.parse(row.last_seen ?? '[]') as unknown
    if (Array.isArray(parsed)) lastSeen = parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    lastSeen = []
  }
  return {
    id: row.id,
    kind: row.kind as BiliSubscribeKind,
    targetId: row.target_id,
    title: row.title,
    quality: row.quality,
    everyHours: row.every_hours,
    enabled: row.enabled === 1,
    lastCheckedAt: row.last_checked_at,
    lastSeen,
    lastJobId: row.last_job_id,
  }
}

export function listBiliSubscriptions(): BiliSubscription[] {
  const rows = db().prepare("select * from subscriptions where kind like 'bili-%' order by rowid desc").all() as unknown as Row[]
  return rows.map(toView)
}

export function findBiliSubscription(idOrPrefix: string): BiliSubscription {
  const rows = db().prepare("select * from subscriptions where kind like 'bili-%' and (id = ? or id like ?)").all(idOrPrefix, `${idOrPrefix}%`) as unknown as Row[]
  if (rows.length === 0) throw new AstraError('NOT_FOUND', `没有订阅 ${idOrPrefix}`, { exitCode: 4, hint: '用 `astra bili subscribe list` 看' })
  if (rows.length > 1) throw new AstraError('AMBIGUOUS_ID', `订阅 id 前缀 ${idOrPrefix} 对应多个`, { exitCode: 2, hint: '多写几位' })
  return toView(rows[0]!)
}

/** 按输入（合集/系列/收藏夹链接或 ref）拉一次内容，用于建订阅与判断新视频。 */
export async function fetchByTarget(targetId: string, limit: number, signal?: AbortSignal): Promise<Collection> {
  const ref = parseCollectionRef(targetId)
  if (ref.kind === 'fav') return await fetchFavorite(ref.id, limit, signal)
  if (ref.kind === 'series') return await fetchSeriesArchives(ref.mid, ref.seriesId, limit, signal)
  if (ref.kind === 'season') return await fetchSeasonArchives(ref.mid, ref.seasonId, limit, signal)
  throw new AstraError('BAD_TARGET', `认不出这是哪个合集 / 系列 / 收藏夹：${targetId.slice(0, 40)}`, {
    exitCode: 2,
    hint: '用 collectiondetail / seriesdetail 链接，或 `season:<sid>` / `fav:<id>`',
  })
}

export async function addBiliSubscription(input: { target: string; everyHours: number; quality: string | null }, signal?: AbortSignal): Promise<BiliSubscription> {
  const ref = parseCollectionRef(input.target)
  if (ref.kind === null) {
    throw new AstraError('BAD_TARGET', `认不出这是哪个合集 / 系列 / 收藏夹：${input.target.slice(0, 40)}`, { exitCode: 2 })
  }
  const collection = await fetchByTarget(input.target, 200, signal)
  const kind: BiliSubscribeKind = ref.kind === 'fav' ? 'bili-fav' : ref.kind === 'series' ? 'bili-series' : 'bili-season'
  // 存规范化后的 ref，之后每次 run 都能直接解析。
  // 没有 mid 时不要写出 `season:/123` 这种带空斜杠的形状 —— 解析虽然容忍，
  // 但存进去很难看，也容易让人以为坏了
  const withMid = (prefix: string, mid: string | null, id: string): string => (mid ? `${prefix}:${mid}/${id}` : `${prefix}:${id}`)
  const targetId = ref.kind === 'fav' ? `fav:${ref.id}`
    : ref.kind === 'series' ? withMid('series', ref.mid, ref.seriesId)
    : withMid('season', ref.mid, ref.seasonId)
  const id = randomUUID().slice(0, 8)
  db()
    .prepare('insert into subscriptions (id, kind, target_id, title, quality, every_hours, enabled, last_seen, created_at) values (?, ?, ?, ?, ?, ?, 1, ?, ?)')
    .run(id, kind, targetId, collection.title, input.quality, input.everyHours, JSON.stringify(collection.items.map((v) => v.bvid)), new Date().toISOString())
  // 建订阅时把当前已有的一批记为基线 —— 第一次 run 不会把整个合集重下一遍
  return findBiliSubscription(id)
}

export function removeBiliSubscription(idOrPrefix: string): boolean {
  const sub = findBiliSubscription(idOrPrefix)
  return db().prepare('delete from subscriptions where id = ?').run(sub.id).changes > 0
}

export function setBiliSubscription(idOrPrefix: string, patch: { everyHours?: number; enabled?: boolean; quality?: string | null }): BiliSubscription {
  const sub = findBiliSubscription(idOrPrefix)
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
  if (sets.length > 0) {
    values.push(sub.id)
    db().prepare(`update subscriptions set ${sets.join(', ')} where id = ?`).run(...values)
  }
  return findBiliSubscription(sub.id)
}

export interface BiliRunResult {
  subscription: BiliSubscription
  /** 这次新出现的视频数。 */
  newCount: number
  /** 开了任务的话给出 id。 */
  jobId: string | null
  note: string
  /** 是不是第一次跑（只记基线）。 */
  baseline: boolean
}

/**
 * 从当前列表里挑出"上次没见过的"。
 *
 * **第一次（lastSeen 为空）一律返回空** —— 否则建订阅后第一次检查会把整个合集
 * 当成新视频，一次下几百个。这是这个功能最容易踩的坑。
 */
export function pickFresh<T extends { bvid: string }>(current: T[], lastSeen: string[], force = false): { fresh: T[]; baseline: boolean } {
  const baseline = lastSeen.length === 0 || force
  if (baseline) return { fresh: [], baseline: true }
  return { fresh: current.filter((v) => !lastSeen.includes(v.bvid)), baseline: false }
}

/** 跑一次订阅：拉当前列表 → 与 lastSeen 求差 → 新的开任务。 */
export async function runBiliSubscription(idOrPrefix: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<BiliRunResult> {
  const sub = findBiliSubscription(idOrPrefix)
  const collection = await fetchByTarget(sub.targetId, 500, options.signal)
  const currentIds = collection.items.map((v) => v.bvid)
  const previous = sub.lastSeen
  const { fresh, baseline } = pickFresh(collection.items, previous, options.force === true)

  let jobId: string | null = null
  let note: string
  if (fresh.length > 0) {
    const quality = Number(sub.quality ?? '80') || 80
    const items = collectionToItems(fresh, collection.title, quality)
    const job = createJob({
      domain: BILI_DOMAIN,
      kind: 'subscribe',
      title: `订阅「${sub.title}」新增 ${fresh.length} 个`,
      profile: String(quality),
      items,
    })
    spawnWorker(BILI_DOMAIN, job.id)
    jobId = job.id
    note = `发现 ${fresh.length} 个新视频，已开任务 ${job.id}`
    progress('bili.subscribe.new', { id: sub.id, count: fresh.length, jobId: job.id })
  } else {
    note = baseline ? '第一次检查，已记录基线（不会重下已有内容）' : '没有新视频'
  }

  const now = new Date().toISOString()
  db()
    .prepare('update subscriptions set last_checked_at = ?, last_seen = ?, last_job_id = coalesce(?, last_job_id) where id = ?')
    .run(now, JSON.stringify(currentIds), jobId, sub.id)
  db()
    .prepare("insert or replace into subscription_runs (subscription_id, ran_at, new_tracks, job_id, note) values (?, ?, ?, ?, ?)")
    .run(sub.id, now, fresh.length, jobId, note)

  return { subscription: findBiliSubscription(sub.id), newCount: fresh.length, jobId, note, baseline }
}

/** 到点该跑的订阅。 */
export function dueBiliSubscriptions(now = Date.now()): BiliSubscription[] {
  return listBiliSubscriptions().filter((s) => {
    if (!s.enabled) return false
    if (!s.lastCheckedAt) return true
    return now - new Date(s.lastCheckedAt).getTime() >= s.everyHours * 3600 * 1000
  })
}

export { KIND_PREFIX }

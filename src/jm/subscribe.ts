/**
 * 漫画订阅：盯一本连载，出新话就开后台任务补下。
 *
 * 复用 `subscriptions` 表（kind = `jm-album`），和 B 站订阅同一套
 * "间隔 / 启停 / last_checked / run" 语义，不另建表。
 *
 * 判断"新话"用**章节 id 集合差**，不用更新时间：
 * - `last_seen`：建订阅时那一刻的章节 id（基线）。基线里的话不归订阅管，
 *   要补旧话用 `jm get`。`--backfill` 时基线为空，第一次检查就把全部话补下
 * - `seen_pages`：订阅确认落盘过的章节 `{ 章节id: 话数 }`。只在任务跑完、
 *   该话 `downloaded` / `skipped` 时回写；失败的不记，下一轮自动重试
 *
 * 上一轮任务还在跑时不再开新任务，免得同一话被两个 worker 同时写。
 */
import { randomUUID } from 'node:crypto'
import { db } from '../core/db.ts'
import { AstraError } from '../core/errors.ts'
import { progress } from '../core/output.ts'
import { createJob, getJob, spawnWorker } from '../core/jobs.ts'
import { jmClient, type AlbumDetail, type AlbumEpisode } from './client.ts'
import { chapterItems, JM_DOMAIN } from './job-items.ts'

export const JM_SUB_KIND = 'jm-album'

export interface JmSubscription {
  id: string
  albumId: string
  title: string
  everyHours: number
  enabled: boolean
  lastCheckedAt: string | null
  /** 基线章节 id：建订阅时已有的话，订阅不负责下。 */
  baseline: string[]
  /** 订阅确认下好的章节：章节 id → 话数。 */
  done: Record<string, number>
  lastJobId: string | null
  createdAt: string
}

interface Row {
  id: string
  kind: string
  target_id: string
  title: string
  every_hours: number
  enabled: number
  last_checked_at: string | null
  last_seen: string | null
  last_job_id: string | null
  seen_pages: string | null
  created_at: string
}

function parseIds(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function parseDone(raw: string | null): Record<string, number> {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'number') out[k] = v
    return out
  } catch {
    return {}
  }
}

function toView(row: Row): JmSubscription {
  return {
    id: row.id,
    albumId: row.target_id,
    title: row.title,
    everyHours: row.every_hours,
    enabled: row.enabled === 1,
    lastCheckedAt: row.last_checked_at,
    baseline: parseIds(row.last_seen),
    done: parseDone(row.seen_pages),
    lastJobId: row.last_job_id,
    createdAt: row.created_at,
  }
}

export function listJmSubscriptions(): JmSubscription[] {
  const rows = db().prepare('select * from subscriptions where kind = ? order by created_at').all(JM_SUB_KIND) as unknown as Row[]
  return rows.map(toView)
}

export function findJmSubscription(idOrPrefix: string): JmSubscription {
  const rows = db()
    .prepare('select * from subscriptions where kind = ? and (id = ? or id like ? or target_id = ?)')
    .all(JM_SUB_KIND, idOrPrefix, `${idOrPrefix}%`, idOrPrefix) as unknown as Row[]
  if (rows.length === 0) throw new AstraError('NOT_FOUND', `没有漫画订阅 ${idOrPrefix}`, { exitCode: 4, hint: '用 `astra jm subscribe list` 看' })
  if (rows.length > 1) throw new AstraError('AMBIGUOUS_ID', `订阅 id 前缀 ${idOrPrefix} 对应多个`, { exitCode: 2, hint: '多写几位' })
  return toView(rows[0]!)
}

/** 已订阅就返回那条，没有返回 null。 */
export function jmSubscriptionFor(albumId: string): JmSubscription | null {
  const row = db().prepare('select * from subscriptions where kind = ? and target_id = ?').get(JM_SUB_KIND, albumId) as Row | undefined
  return row ? toView(row) : null
}

/**
 * 建订阅。album 由调用方先查好（命令里已经查过一次，不重复打上游）。
 * `backfill` 为 true 时基线为空：第一次检查会把还没下过的话全补上。
 */
export function addJmSubscription(album: Pick<AlbumDetail, 'id' | 'title' | 'episodes'>, input: { everyHours: number; backfill?: boolean }): { subscription: JmSubscription; created: boolean } {
  const existing = jmSubscriptionFor(album.id)
  if (existing) return { subscription: existing, created: false }
  const id = randomUUID().slice(0, 8)
  const baseline = input.backfill === true ? [] : album.episodes.map((e) => e.id)
  db()
    .prepare('insert into subscriptions (id, kind, target_id, title, quality, every_hours, enabled, last_seen, seen_pages, created_at) values (?, ?, ?, ?, null, ?, 1, ?, ?, ?)')
    .run(id, JM_SUB_KIND, album.id, album.title, input.everyHours, JSON.stringify(baseline), '{}', new Date().toISOString())
  return { subscription: findJmSubscription(id), created: true }
}

export function removeJmSubscription(idOrPrefix: string): JmSubscription {
  const sub = findJmSubscription(idOrPrefix)
  db().prepare('delete from subscriptions where id = ?').run(sub.id)
  return sub
}

export function setJmSubscription(idOrPrefix: string, patch: { everyHours?: number; enabled?: boolean }): JmSubscription {
  const sub = findJmSubscription(idOrPrefix)
  if (patch.everyHours !== undefined) db().prepare('update subscriptions set every_hours = ? where id = ?').run(patch.everyHours, sub.id)
  if (patch.enabled !== undefined) db().prepare('update subscriptions set enabled = ? where id = ?').run(patch.enabled ? 1 : 0, sub.id)
  return findJmSubscription(sub.id)
}

/** 当前章节里要补下的：不在基线、也没确认下好过。纯函数，单测直接测。 */
export function pickNewChapters(current: AlbumEpisode[], baseline: string[], done: Record<string, number>): AlbumEpisode[] {
  const skip = new Set([...baseline, ...Object.keys(done)])
  return current.filter((e) => !skip.has(e.id))
}

/** 到点该检查的：启用、且从没检查过或距上次超过间隔。 */
export function dueJmSubscriptions(now = Date.now(), subs = listJmSubscriptions()): JmSubscription[] {
  return subs.filter((s) => {
    if (!s.enabled) return false
    if (!s.lastCheckedAt) return true
    return now - Date.parse(s.lastCheckedAt) >= s.everyHours * 3600_000
  })
}

export interface JmRunResult {
  subscription: JmSubscription
  /** 这次要补的话数（开了任务才非零）。 */
  newCount: number
  jobId: string | null
  /** 新话的话数列表，方便汇报"出了第 13、14 话"。 */
  newChapters: number[]
  note: string
}

function lastJobActive(jobId: string | null): boolean {
  if (!jobId) return false
  try {
    const { job } = getJob(jobId, false, JM_DOMAIN)
    return job.status === 'queued' || job.status === 'running'
  } catch {
    return false
  }
}

/** 跑一次：拉章节列表 → 求差 → 有新话就开后台任务。 */
export async function runJmSubscription(idOrPrefix: string, options: { signal?: AbortSignal } = {}): Promise<JmRunResult> {
  const sub = findJmSubscription(idOrPrefix)
  const now = new Date().toISOString()
  if (lastJobActive(sub.lastJobId)) {
    return { subscription: sub, newCount: 0, jobId: null, newChapters: [], note: `上一轮任务 ${sub.lastJobId} 还在跑，这次跳过` }
  }

  const album = await jmClient().getAlbum(sub.albumId, options.signal)
  const fresh = pickNewChapters(album.episodes, sub.baseline, sub.done)

  let jobId: string | null = null
  let note: string
  if (fresh.length > 0) {
    const job = createJob({
      domain: JM_DOMAIN,
      kind: 'subscribe',
      title: `订阅「${album.title}」新增 ${fresh.length} 话`,
      items: chapterItems(album, fresh),
      meta: { subscriptionId: sub.id, albumId: album.id },
    })
    spawnWorker(JM_DOMAIN, job.id)
    jobId = job.id
    note = `发现 ${fresh.length} 话待下，已开任务 ${job.id}`
    progress('jm.subscribe.new', { id: sub.id, count: fresh.length, jobId })
  } else {
    note = '没有新话'
  }

  // 标题以上游为准（作者改名时跟着变）
  db()
    .prepare('update subscriptions set title = ?, last_checked_at = ?, last_job_id = coalesce(?, last_job_id) where id = ?')
    .run(album.title, now, jobId, sub.id)
  db()
    .prepare('insert or replace into subscription_runs (subscription_id, ran_at, new_tracks, job_id, note) values (?, ?, ?, ?, ?)')
    .run(sub.id, now, fresh.length, jobId, note)

  return { subscription: findJmSubscription(sub.id), newCount: fresh.length, jobId, newChapters: fresh.map((e) => e.sort), note }
}

/**
 * 任务跑完后按**实际结果**回写"这些话下好了"。只认 downloaded / skipped。
 * 从 job_items 读：worker 是另一个进程，run 时的内存早没了。
 */
export function recordJmSubscriptionChapters(subscriptionId: string, jobId: string): void {
  const rows = db()
    .prepare("select native_id, meta from job_items where job_id = ? and status in ('downloaded', 'skipped')")
    .all(jobId) as unknown as { native_id: string; meta: string | null }[]
  if (rows.length === 0) return
  let sub: JmSubscription
  try {
    sub = findJmSubscription(subscriptionId)
  } catch {
    return // 订阅在任务跑的时候被删了
  }
  const done = { ...sub.done }
  for (const row of rows) {
    let sort = 0
    try {
      const meta = JSON.parse(row.meta ?? '{}') as Record<string, unknown>
      if (typeof meta.sort === 'number') sort = meta.sort
    } catch {
      // 没有话数也照样记 id
    }
    done[row.native_id] = sort
  }
  db().prepare('update subscriptions set seen_pages = ? where id = ?').run(JSON.stringify(done), sub.id)
}

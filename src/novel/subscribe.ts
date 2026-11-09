/**
 * 小说追更：盯一本连载，出新章节就重出那本 EPUB。
 *
 * 复用 `subscriptions` 表（kind = `novel`）。判断「新章节」用章节 id 的差集，不用时间：
 * - 建订阅时把当前全部章节记为基线，第一次 run 不会重下
 * - `last_seen` 只记**真的抓下来**的章（任务跑完由 `recordSubscriptionChapters` 回写），
 *   失败的章下一轮还会出现在差集里
 * - 订阅选项（卷、繁转简、要不要图）放 `options` JSON 列
 *
 * 有新章节时开的是一个普通 `book` 任务：已缓存的章是 skipped，只真去抓新的那几章，
 * 然后照常打包覆盖旧 EPUB。
 */
import { randomUUID } from 'node:crypto'
import { db } from '../core/db.ts'
import { AstraError } from '../core/errors.ts'
import { createJob, spawnWorker, type JobItemView, type JobView } from '../core/jobs.ts'
import { progress } from '../core/output.ts'
import { makePlan, type Plan } from './plan.ts'
import { sourceById } from './registry.ts'

export const NOVEL_KIND = 'novel'

export interface NovelSubOptions {
  /** 从 1 开始的卷号；null = 整本 / 不分卷。 */
  volume: number | null
  simplified: boolean
  images: boolean
}

export interface NovelSubscription {
  id: string
  /** `<书源>:<书 id>`。 */
  targetId: string
  source: string
  bookId: string
  title: string
  everyHours: number
  enabled: boolean
  lastCheckedAt: string | null
  lastJobId: string | null
  /** 已经抓到的章节 id。 */
  seen: string[]
  options: NovelSubOptions
}

interface Row {
  id: string
  target_id: string
  title: string
  every_hours: number
  enabled: number
  last_checked_at: string | null
  last_seen: string | null
  last_job_id: string | null
  options: string | null
}

function parseList(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function parseOptions(raw: string | null): NovelSubOptions {
  let v: Partial<NovelSubOptions> = {}
  try {
    v = JSON.parse(raw ?? '{}') as Partial<NovelSubOptions>
  } catch {
    v = {}
  }
  return { volume: typeof v.volume === 'number' ? v.volume : null, simplified: v.simplified === true, images: v.images !== false }
}

export function splitTarget(targetId: string): { source: string; bookId: string } {
  const i = targetId.indexOf(':')
  return { source: targetId.slice(0, i), bookId: targetId.slice(i + 1) }
}

function toView(row: Row): NovelSubscription {
  const { source, bookId } = splitTarget(row.target_id)
  return {
    id: row.id,
    targetId: row.target_id,
    source,
    bookId,
    title: row.title,
    everyHours: row.every_hours,
    enabled: row.enabled === 1,
    lastCheckedAt: row.last_checked_at,
    lastJobId: row.last_job_id,
    seen: parseList(row.last_seen),
    options: parseOptions(row.options),
  }
}

export function listNovelSubscriptions(): NovelSubscription[] {
  return (db().prepare('select * from subscriptions where kind = ? order by created_at').all(NOVEL_KIND) as unknown as Row[]).map(toView)
}

export function findNovelSubscription(idOrPrefix: string): NovelSubscription {
  const rows = db().prepare('select * from subscriptions where kind = ? and (id = ? or id like ?)').all(NOVEL_KIND, idOrPrefix, `${idOrPrefix}%`) as unknown as Row[]
  if (rows.length === 0) throw new AstraError('NOT_FOUND', `没有小说订阅 ${idOrPrefix}`, { exitCode: 4, hint: '`astra novel subscribe list` 看现有订阅' })
  if (rows.length > 1) throw new AstraError('AMBIGUOUS_ID', `订阅 id 前缀 ${idOrPrefix} 对应多个`, { exitCode: 2, hint: '多写几位' })
  return toView(rows[0]!)
}

/** 当前计划里的全部章节 id。 */
function planIds(plan: Plan): string[] {
  return plan.chapters.map((c) => c.id)
}

export async function addNovelSubscription(
  input: { source: string; bookId: string; everyHours: number; options: NovelSubOptions },
  signal?: AbortSignal,
): Promise<NovelSubscription> {
  const source = sourceById(input.source)
  const book = await source.book(input.bookId, signal)
  const plan = makePlan(book, input.options.volume, source.volumesAreBooks)
  const targetId = `${input.source}:${input.bookId}`
  const existing = db().prepare('select id from subscriptions where kind = ? and target_id = ?').get(NOVEL_KIND, targetId) as { id: string } | undefined
  if (existing) throw new AstraError('ALREADY_EXISTS', `已经订阅过《${book.title}》（${existing.id}）`, { exitCode: 2, hint: '`astra novel subscribe list`' })
  const id = randomUUID().slice(0, 8)
  db()
    .prepare('insert into subscriptions (id, kind, target_id, title, every_hours, enabled, last_seen, created_at, options) values (?, ?, ?, ?, ?, 1, ?, ?, ?)')
    .run(id, NOVEL_KIND, targetId, plan.title, input.everyHours, JSON.stringify(planIds(plan)), new Date().toISOString(), JSON.stringify(input.options))
  return findNovelSubscription(id)
}

export function removeNovelSubscription(idOrPrefix: string): boolean {
  const sub = findNovelSubscription(idOrPrefix)
  return db().prepare('delete from subscriptions where id = ?').run(sub.id).changes > 0
}

/** 当前章节里基线没有的。纯函数，单测用。 */
export function freshChapters(current: string[], seen: string[]): string[] {
  const known = new Set(seen)
  return current.filter((id) => !known.has(id))
}

export interface NovelRunResult {
  subscription: NovelSubscription
  newCount: number
  jobId: string | null
  note: string
}

export async function runNovelSubscription(idOrPrefix: string, signal?: AbortSignal): Promise<NovelRunResult> {
  const sub = findNovelSubscription(idOrPrefix)
  const source = sourceById(sub.source)
  const book = await source.book(sub.bookId, signal)
  const plan = makePlan(book, sub.options.volume, source.volumesAreBooks)
  const fresh = freshChapters(planIds(plan), sub.seen)
  let jobId: string | null = null
  let note = '没有新章节'
  if (fresh.length > 0) {
    const job = createJob({
      domain: 'novel',
      kind: 'book',
      title: `追更《${plan.title}》新增 ${fresh.length} 章`,
      items: plan.chapters.map((c) => ({ id: c.id, title: c.title, meta: { source: sub.source, bookId: sub.bookId, title: c.title, images: sub.options.images } })),
      meta: { source: sub.source, bookId: sub.bookId, plan, simplified: sub.options.simplified, images: sub.options.images, subscriptionId: sub.id },
    })
    spawnWorker('novel', job.id)
    jobId = job.id
    note = `发现 ${fresh.length} 章新内容，已开任务 ${job.id}`
    progress('novel.subscribe.new', { id: sub.id, count: fresh.length, jobId })
  }
  const now = new Date().toISOString()
  db().prepare('update subscriptions set last_checked_at = ?, last_job_id = coalesce(?, last_job_id) where id = ?').run(now, jobId, sub.id)
  db().prepare('insert or replace into subscription_runs (subscription_id, ran_at, new_tracks, job_id, note) values (?, ?, ?, ?, ?)').run(sub.id, now, fresh.length, jobId, note)
  return { subscription: findNovelSubscription(sub.id), newCount: fresh.length, jobId, note }
}

/** 任务跑完后按**实际抓到**的章回写基线。只在成书时才算（没出书就等于没追上）。 */
export function recordSubscriptionChapters(subscriptionId: string, job: JobView, items: JobItemView[]): void {
  if (job.status !== 'done') return
  const sub = findNovelSubscription(subscriptionId)
  const got = items.filter((i) => i.status === 'downloaded' || i.status === 'skipped').map((i) => i.id)
  const merged = [...new Set([...sub.seen, ...got])]
  db().prepare('update subscriptions set last_seen = ? where id = ?').run(JSON.stringify(merged), sub.id)
}

export function dueNovelSubscriptions(now = Date.now()): NovelSubscription[] {
  return listNovelSubscriptions().filter((s) => s.enabled && (!s.lastCheckedAt || now - Date.parse(s.lastCheckedAt) >= s.everyHours * 3_600_000))
}

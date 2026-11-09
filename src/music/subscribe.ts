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
import { all, num, one, recordSubscriptionRun as recordRun, run } from '../core/state.ts'
import { AstraError, invalidInput } from '../core/errors.ts'
import { progress } from '../core/output.ts'
import { getConfig } from '../core/config.ts'
import { artistTopTracks, albumInfo, playlistTracks, songDetails, type Track } from './netease.ts'
import { likedIds, requireSession } from './account-api.ts'
import { createJob, spawnWorker } from '../core/jobs.ts'
import { jobItemsFor, MUSIC_DOMAIN } from './jobs.ts'
import { findTrack } from './library.ts'
import type { Quality } from './audio.ts'

export type SubscribeKind = 'playlist' | 'album' | 'artist' | 'liked'

/**
 * 这张 `subscriptions` 表是三域共用的（bili 用 `bili-` 前缀，见 src/bili/subscribe.ts），
 * 所以音乐这边**必须按 kind 过滤**：否则 `music subscribe run` 会把 B 站合集当成歌手 id
 * 丢给网易云，每次都报 `music.163.com 返回 HTTP 404`，还会顺手覆盖掉 bili 那边的 last_seen。
 */
const MUSIC_KINDS: readonly string[] = ['playlist', 'album', 'artist', 'liked']
const MUSIC_KIND_SQL = MUSIC_KINDS.map((k) => `'${k}'`).join(', ')

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
  /** 自适应间隔（0=关，沿用 everyHours）：基准分钟、封顶分钟、增长倍数、当前阶梯。 */
  baseMin: number
  maxMin: number
  factor: number
  currentMin: number
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
  base_min: number
  max_min: number
  factor: number
  current_min: number
}

function fromRow(row: Row): Subscription {
  return {
    id: row.id,
    kind: row.kind as SubscribeKind,
    targetId: row.target_id,
    title: row.title,
    quality: row.quality as Quality | null,
    everyHours: num(row.every_hours),
    enabled: num(row.enabled) === 1,
    lastCheckedAt: row.last_checked_at,
    lastSeen: row.last_seen ? (JSON.parse(row.last_seen) as string[]) : null,
    lastJobId: row.last_job_id,
    createdAt: row.created_at,
    baseMin: num(row.base_min ?? 0),
    maxMin: num(row.max_min ?? 0),
    factor: num(row.factor ?? 2),
    currentMin: num(row.current_min ?? 0),
  }
}

export async function listSubscriptions(): Promise<Subscription[]> {
  return (await all<Row>(`select * from subscriptions where kind in (${MUSIC_KIND_SQL}) order by created_at`)).map(fromRow)
}

export async function findSubscription(idOrPrefix: string): Promise<Subscription> {
  const rows = await all<Row>(`select * from subscriptions where (id = ? or id like ?) and kind in (${MUSIC_KIND_SQL})`, [idOrPrefix, `${idOrPrefix}%`])
  if (rows.length === 0) throw new AstraError('NOT_FOUND', `没有订阅 ${idOrPrefix}`, { exitCode: 4, hint: '用 `astra music subscribe list` 看已有的' })
  if (rows.length > 1) throw new AstraError('AMBIGUOUS_ID', `订阅 id 前缀 ${idOrPrefix} 对多个订阅`, { exitCode: 2, hint: '多写几位' })
  return fromRow(rows[0]!)
}

/**
 * 下一次检查间隔（分钟）。纯函数，测试钉住行为。
 *
 * - 有新歌 → 立刻复位到基准：用户正在活跃，5 分钟内就该跟上
 * - 没新歌 → 乘倍数增长，封顶 maxMin：冷场时别拿请求去换空气
 */
export function nextInterval(input: { current: number; base: number; max: number; factor: number; changed: boolean }): number {
  const base = Math.max(1, Math.trunc(input.base))
  const max = Math.max(base, Math.trunc(input.max))
  if (input.changed) return base
  const factor = Math.min(10, Math.max(2, Math.trunc(input.factor)))
  const current = Math.max(base, Math.trunc(input.current) || base)
  return Math.min(current * factor, max)
}

/** 这条订阅距离下次检查还有多少分钟（自适应优先，否则按 everyHours）。 */
export function intervalMinutesOf(sub: Pick<Subscription, 'everyHours' | 'baseMin' | 'currentMin'>): number {
  if (sub.baseMin > 0) return Math.max(sub.baseMin, sub.currentMin || sub.baseMin)
  return sub.everyHours * 60
}

export async function addSubscription(input: {
  kind: SubscribeKind
  targetId: string
  title: string
  everyHours: number
  quality: Quality | null
  backoff?: { baseMin: number; maxMin: number; factor: number }
}): Promise<Subscription> {
  const existing = await one<Row>('select * from subscriptions where kind = ? and target_id = ?', [input.kind, input.targetId])
  if (existing) throw new AstraError('ALREADY_SUBSCRIBED', `已经在订阅「${existing.title}」了`, {
    exitCode: 2,
    hint: `订阅 id ${existing.id}；改间隔用 \`astra music subscribe set ${existing.id} --every ...\``,
  })
  const id = randomUUID().slice(0, 8)
  await run(
    `insert into subscriptions (id, kind, target_id, title, quality, every_hours, enabled, created_at,
                                base_min, max_min, factor, current_min)
     values (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      id, input.kind, input.targetId, input.title, input.quality, input.everyHours, new Date().toISOString(),
      input.backoff?.baseMin ?? 0,
      input.backoff?.maxMin ?? 0,
      input.backoff?.factor ?? 2,
      input.backoff?.baseMin ?? 0,
    ],
  )
  return findSubscription(id)
}

export async function removeSubscription(idOrPrefix: string): Promise<boolean> {
  const sub = await findSubscription(idOrPrefix)
  return (await run('delete from subscriptions where id = ?', [sub.id])) > 0
}

export async function setSubscription(idOrPrefix: string, patch: {
  everyHours?: number
  enabled?: boolean
  quality?: Quality | null
  baseMin?: number
  maxMin?: number
  factor?: number
}): Promise<Subscription> {
  const sub = await findSubscription(idOrPrefix)
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
  if (patch.baseMin !== undefined) {
    sets.push('base_min = ?', 'current_min = ?')
    values.push(patch.baseMin, patch.baseMin)
  }
  if (patch.maxMin !== undefined) {
    sets.push('max_min = ?')
    values.push(patch.maxMin)
  }
  if (patch.factor !== undefined) {
    sets.push('factor = ?')
    values.push(patch.factor)
  }
  if (sets.length === 0) {
    throw invalidInput('没有要改的东西', '可用：--every <小时> / --base <分钟> / --max <分钟> / --factor <倍数> / --enable / --disable / --quality <档位>')
  }
  values.push(sub.id)
  await run(`update subscriptions set ${sets.join(', ')} where id = ?`, values)
  return findSubscription(sub.id)
}

/** 取订阅对象当前的曲目。 */
export async function fetchSubscriptionTracks(sub: Subscription, signal?: AbortSignal): Promise<Track[]> {
  if (sub.kind === 'playlist') return (await playlistTracks(sub.targetId, signal)).tracks
  if (sub.kind === 'album') return (await albumInfo(sub.targetId, signal)).tracks
  if (sub.kind === 'liked') {
    // targetId 存的就是账号 id，不用再查一次 account 接口
    const { session } = requireSession(sub.targetId, signal)
    const ids = await likedIds(session, sub.targetId, signal)
    // 红心列表只给 id，标题/歌手要靠详情接口补；几百首一次请求就够（内部按 500 分批）
    return ids.length === 0 ? [] : songDetails(ids, signal)
  }
  if (sub.kind === 'artist') return (await artistTopTracks(sub.targetId, signal)).tracks
  throw invalidInput(`不认识的订阅类型 ${sub.kind}`, '音乐订阅只支持 playlist / album / artist / liked；B 站合集请用 `astra bili subscribe`')
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
  const toDownload: Track[] = []
  if (!options.baselineOnly) {
    for (const t of newTracks) if ((await findTrack('wy', t.id)) === null) toDownload.push(t)
  }

  let jobId: string | null = null
  let note: string | null = null
  if (toDownload.length > 0) {
    // 订阅没指定档位时继承 `music.quality`，不是写死 flac ——
    // 用户把默认改成 320k 省流量，订阅却还按 flac 下，等于配置没生效
    const quality = (sub.quality ?? getConfig('music.quality')) as Quality
    const job = await createJob({ domain: MUSIC_DOMAIN, kind: 'subscription', title: `订阅「${sub.title}」新增 ${toDownload.length} 首`, profile: quality, items: jobItemsFor(toDownload, quality) })
    await spawnWorker(MUSIC_DOMAIN, job.id)
    jobId = job.id
    note = `开了后台任务 ${job.id}`
  } else if (newTracks.length > 0) {
    note = '新歌都已在曲库'
  }

  const now = new Date().toISOString()
  // 自适应订阅：按「这次有没有新歌」调整下一次的等待时间。
  // 基线那次不算变化（否则第一次订阅就会把间隔复位，等于没退避）。
  const nextMin = sub.baseMin > 0 && !baseline
    ? nextInterval({
      current: sub.currentMin || sub.baseMin,
      base: sub.baseMin,
      max: sub.maxMin || sub.baseMin,
      factor: sub.factor,
      changed: newTracks.length > 0,
    })
    : null
  if (nextMin !== null) {
    await run('update subscriptions set current_min = ? where id = ?', [nextMin, sub.id])
  }
  await run('update subscriptions set last_checked_at = ?, last_seen = ?, last_job_id = coalesce(?, last_job_id) where id = ?', [now, JSON.stringify(currentIds), jobId, sub.id])
  await recordRun(sub.id, now, newTracks.length, jobId, note)

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
export async function dueSubscriptions(now = Date.now()): Promise<Subscription[]> {
  return (await listSubscriptions()).filter((sub) => {
    if (!sub.enabled) return false
    if (sub.lastCheckedAt === null) return true
    return now - Date.parse(sub.lastCheckedAt) >= intervalMinutesOf(sub) * 60_000
  })
}

export async function recentRuns(subscriptionId: string, limit = 10): Promise<{ ranAt: string; newTracks: number; jobId: string | null; note: string | null }[]> {
  return (
    await all<{
      ran_at: string
      new_tracks: number
      job_id: string | null
      note: string | null
    }>('select * from subscription_runs where subscription_id = ? order by ran_at desc limit ?', [subscriptionId, limit])
  ).map((r) => ({ ranAt: r.ran_at, newTracks: num(r.new_tracks), jobId: r.job_id, note: r.note }))
}

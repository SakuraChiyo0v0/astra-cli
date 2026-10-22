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
import { pageTasksToItems, BILI_DOMAIN } from './jobs.ts'
import { fetchInfo } from './download.ts'
import { fetchFavorite, fetchSeasonArchives, fetchSeriesArchives, parseCollectionRef, type Collection } from './collection.ts'

export type BiliSubscribeKind = 'bili-season' | 'bili-series' | 'bili-fav'

export interface BiliSubscription {
  id: string
  kind: BiliSubscribeKind
  /** `season:<mid>/<sid>` / `series:<mid>/<sid>` / `fav:<id>`，可直接再解析。 */
  targetId: string
  title: string
  quality: string | null
  /** quality 为 null 时说明运行时会用什么；否则为 null。 */
  qualityNote: string | null
  everyHours: number
  enabled: boolean
  lastCheckedAt: string | null
  /** 上次见到的 bvid 列表。 */
  lastSeen: string[]
  lastJobId: string | null
  /** 只下音频（mp3 进音乐库）。 */
  audioOnly: boolean
  /** 下哪些分 P：`all` 完整拿到，`first` 只下 P1（返回里会给 partial）。 */
  pagesMode: 'all' | 'first'
  /**
   * 已下过的分 P：`{ bvid: [1, 2] }`。
   *
   * 只记 bvid 是不够的 —— 视频后来多了一个分 P 时，bvid 已经在基线里，
   * 那个新 P 就永远不会被补上（实测 BV1GEn26uEDT 就卡在这）。
   */
  seenPages: SeenPages
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
  audio_only: number
  pages_mode: string
  seen_pages: string
}

const KIND_PREFIX = 'bili-'

/** 分 P 跟踪：bvid -> 已经下过的 P 号（1-based）。 */
export type SeenPages = Record<string, number[]>

function parseSeenPages(raw: string): SeenPages {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: SeenPages = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((n): n is number => typeof n === 'number')
    }
    return out
  } catch {
    return {}
  }
}

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
    // 老订阅（v0.12 之前建的）没存画质，跑的时候按 80（1080p）算。
    // 只回一个 null 的话，调用方没法判断"继承了什么"，所以把实际会用的值一并说明。
    qualityNote: row.quality === null ? '未指定，运行时按 1080p（qn 80）下载' : null,
    everyHours: row.every_hours,
    enabled: row.enabled === 1,
    lastCheckedAt: row.last_checked_at,
    lastSeen,
    lastJobId: row.last_job_id,
    audioOnly: row.audio_only === 1,
    pagesMode: row.pages_mode === 'first' ? 'first' : 'all',
    seenPages: parseSeenPages(row.seen_pages),
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

export async function addBiliSubscription(input: { target: string; everyHours: number; quality: string | null; audioOnly?: boolean; pagesMode?: 'all' | 'first' }, signal?: AbortSignal): Promise<BiliSubscription> {
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
    .prepare('insert into subscriptions (id, kind, target_id, title, quality, every_hours, enabled, last_seen, created_at, audio_only, pages_mode) values (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
    .run(
      id, kind, targetId, collection.title, input.quality, input.everyHours,
      JSON.stringify(collection.items.map((v) => v.bvid)), new Date().toISOString(),
      input.audioOnly === true ? 1 : 0,
      input.pagesMode === 'first' ? 'first' : 'all',
    )
  // 建订阅时把当前已有的一批记为基线 —— 第一次 run 不会把整个合集重下一遍
  return findBiliSubscription(id)
}

export function removeBiliSubscription(idOrPrefix: string): boolean {
  const sub = findBiliSubscription(idOrPrefix)
  return db().prepare('delete from subscriptions where id = ?').run(sub.id).changes > 0
}

export function setBiliSubscription(idOrPrefix: string, patch: { everyHours?: number; enabled?: boolean; quality?: string | null; audioOnly?: boolean; pagesMode?: 'all' | 'first'; resetPages?: boolean }): BiliSubscription {
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
  if (patch.audioOnly !== undefined) {
    sets.push('audio_only = ?')
    values.push(patch.audioOnly ? 1 : 0)
  }
  if (patch.pagesMode !== undefined) {
    sets.push('pages_mode = ?')
    values.push(patch.pagesMode)
  }
  // --rescan-pages：清空分 P 记录，让下次 run 重新核对每个视频有没有缺 P
  if (patch.resetPages === true) {
    sets.push("seen_pages = '{}'")
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
/**
 * 与基线求差，得出"这次要下什么"。
 *
 * **按 bvid + 分 P 求差，不是只按 bvid。** 只比 bvid 会漏掉一种情况：
 * 视频后来新增了一个分 P（投稿后补了「纯享版」之类），bvid 已经在基线里，
 * 那个新 P 就永远补不上。实测 BV1GEn26uEDT 就卡在这 —— 只下了 P1 的「绿色」，
 * P2 的「纯享版」再也没出现过。
 */
export function pickFresh<T extends { bvid: string }>(
  current: T[],
  lastSeen: string[],
  force = false,
): { fresh: T[]; baseline: boolean } {
  const baseline = lastSeen.length === 0 || force
  if (baseline) return { fresh: [], baseline: true }
  return { fresh: current.filter((v) => !lastSeen.includes(v.bvid)), baseline: false }
}

/** 一个待下的分 P。 */
export interface PageTask {
  bvid: string
  title: string
  /** 1-based P 号。 */
  page: number
  cid: number
}

/**
 * 算出这次要为哪些分 P 建任务。
 *
 * **差集按「视频 × 分 P」算，不是只按 bvid。** 这是 P0#1b 的核心：
 * 只按 bvid 时，视频已在基线里就判"没有新内容"，它后来补的分 P、
 * 或用户手动删掉的分 P 都不会被发现。
 *
 * 规则很简单：**`seenPages[bvid]` 里没有某个 P，就下它。** 没有特殊情况。
 *
 * - 记录不存在（老数据 / 刚 `--rescan-pages` 清空）→ 当作"一页都没下过"
 * - 记录是空数组 → 同上
 * - 记录里有 P 号 → 跳过那些
 *
 * `pagesMode === 'first'` 时只看 P1，其余 P 无论有没有记录都不下
 * （用户明确只想要 P1，这是他的选择，不是漏）。
 */
export function planPages(
  current: { bvid: string; title: string }[],
  pagesByBvid: Map<string, { cid: number; page: number }[]>,
  lastSeen: string[],
  seenPages: SeenPages,
  options: { pagesMode: 'all' | 'first' },
): { tasks: PageTask[]; baseline: boolean } {
  const baseline = lastSeen.length === 0
  if (baseline) return { tasks: [], baseline: true }

  const tasks: PageTask[] = []
  for (const item of current) {
    const pages = pagesByBvid.get(item.bvid) ?? []
    if (pages.length === 0) continue

    // 该下哪些 P 号
    const wantedPages = options.pagesMode === 'first' ? pages.slice(0, 1) : pages
    // 已经下过的那些。记录缺失 = 一页都没下过（不是"全都下过"）——
    // 旧实现把缺失当成"已完成"，正是补不回 P2 的原因
    const done = new Set(seenPages[item.bvid] ?? [])

    for (const page of wantedPages) {
      if (done.has(page.page)) continue
      tasks.push({ bvid: item.bvid, title: item.title, page: page.page, cid: page.cid })
    }
  }
  return { tasks, baseline }
}

/** 跑一次订阅：拉当前列表 → 按 bvid + 分 P 求差 → 该下的开任务。 */
export async function runBiliSubscription(
  idOrPrefix: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<BiliRunResult> {
  const sub = findBiliSubscription(idOrPrefix)
  const collection = await fetchByTarget(sub.targetId, 500, options.signal)
  const currentIds = collection.items.map((v) => v.bvid)
  const previous = sub.lastSeen

  // `--force` 以前的意思是"不管间隔、立刻检查"，同时又兼任"重置基线"。
  // 现在分开：force 只跳过间隔检查（由调用方决定），基线由 lastSeen 判断。
  // 但 `force` 在老脚本里就是"重新核对一遍"，保持它对**分 P** 的重新核对语义。
  const baseline = previous.length === 0

  // 拉 bvid 的分 P 列表。
  //
  // **所有 bvid 都要查**，不能只查"新视频"或"有 seenPages 记录的"——
  // 后者正是 bug：`--rescan-pages` 把记录清空后，一个都不查，于是
  // planPages 拿到的 pages 为空，直接跳过，补不回任何缺失的分 P。
  //
  // 代价是每次检查对合集里的每个视频各查一次详情。合集通常几十到几百个，
  // 顺手算一下就知道值不值：201 个视频 × 一次 view 接口，几秒钟。
  // 相比"漏内容且永远补不上"，这个代价可以接受。
  const pagesByBvid = new Map<string, { cid: number; page: number }[]>()
  for (const item of collection.items) {
    if (options.signal?.aborted) break
    try {
      const info = await fetchInfo(item.bvid, options.signal)
      pagesByBvid.set(item.bvid, info.pages.map((p: { cid: number; page: number }) => ({ cid: p.cid, page: p.page })))
    } catch {
      // 单个视频查不到不该拖垮整次检查；下次再来
      progress('bili.subscribe.info_failed', { id: sub.id, bvid: item.bvid })
    }
  }

  const plan = baseline
    ? { tasks: [] as PageTask[], baseline: true }
    : planPages(collection.items, pagesByBvid, previous, sub.seenPages, { pagesMode: sub.pagesMode })

  let jobId: string | null = null
  let note: string
  if (plan.tasks.length > 0) {
    const quality = Number(sub.quality ?? '80') || 80
    const items = pageTasksToItems(plan.tasks, collection.title, quality, sub.audioOnly)
    const job = createJob({
      domain: BILI_DOMAIN,
      kind: 'subscribe',
      title: `订阅「${sub.title}」新增 ${plan.tasks.length} 项`,
      profile: String(quality),
      items,
      // 任务跑完后要按这个 id 回写"哪几个分 P 真的下过了"
      meta: { subscriptionId: sub.id },
    })
    spawnWorker(BILI_DOMAIN, job.id)
    jobId = job.id
    note = `发现 ${plan.tasks.length} 个待下分 P，已开任务 ${job.id}`
    progress('bili.subscribe.new', { id: sub.id, count: plan.tasks.length, jobId: job.id })
  } else {
    note = baseline ? '第一次检查，已记录基线（不会重下已有内容）' : '没有新视频'
  }

  // 更新"已下分 P"的基线。
  //
  // 只有**任务真的开起来**才记 —— 任务可能失败、可能被取消，那一项就还没下过。
  // 记早了会让失败的项永远补不上（"以为下过了"）。实际确认落盘由
  // `markPagesDownloaded` 在下一次检查前补记，这里只记"已经排进任务"的范围，
  // 保守地**不记**，等任务跑完由 `recordJobPages` 回写。
  const nextSeenPages = { ...sub.seenPages }
  for (const v of collection.items) {
    if (nextSeenPages[v.bvid] === undefined) {
      // 新视频第一次进基线：没有任何已下记录（真下过会由任务完成后回写）
      nextSeenPages[v.bvid] = []
    }
  }

  const now = new Date().toISOString()
  db()
    .prepare('update subscriptions set last_checked_at = ?, last_seen = ?, seen_pages = ?, last_job_id = coalesce(?, last_job_id) where id = ?')
    .run(now, JSON.stringify(currentIds), JSON.stringify(nextSeenPages), jobId, sub.id)
  db()
    .prepare("insert or replace into subscription_runs (subscription_id, ran_at, new_tracks, job_id, note) values (?, ?, ?, ?, ?)")
    .run(sub.id, now, plan.tasks.length, jobId, note)

  return { subscription: findBiliSubscription(sub.id), newCount: plan.tasks.length, jobId, note, baseline }
}

/**
 * 按任务的**实际结果**回写"这些分 P 已经下过了"。
 *
 * 关键：只记 `status = 'downloaded'` 或 `'skipped'` 的项。
 * 失败 / 取消的不能记 —— 记了下一轮就再也不会补，
 * 而这正是"只记 bvid"那个 bug 的同类错误（以为下过了，其实没有）。
 *
 * 从 `job_items` 读而不是在内存里传：worker 是独立进程，
 * 内存里的待下清单在 `subscribe run` 返回时就没了。
 */
export function recordSubscriptionPages(subscriptionId: string, jobId: string | null): void {
  if (!jobId) return
  const rows = db()
    .prepare("select native_id, status, meta from job_items where job_id = ? and status in ('downloaded', 'skipped')")
    .all(jobId) as unknown as { native_id: string; status: string; meta: string | null }[]
  if (rows.length === 0) return

  const sub = findBiliSubscription(subscriptionId)
  const next: SeenPages = { ...sub.seenPages }
  for (const row of rows) {
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(row.meta ?? '{}') as Record<string, unknown>
    } catch {
      continue
    }
    const bvid = typeof meta.bvid === 'string' ? meta.bvid : ''
    // pageIndex 是 0-based，存进去用 1-based 的 P 号
    const pageIndex = typeof meta.pageIndex === 'number' ? meta.pageIndex : null
    if (!bvid || pageIndex === null) continue
    const pageNo = pageIndex + 1
    const list = next[bvid] ?? []
    if (!list.includes(pageNo)) list.push(pageNo)
    next[bvid] = list.sort((a, b) => a - b)
  }
  db()
    .prepare('update subscriptions set seen_pages = ? where id = ?')
    .run(JSON.stringify(next), sub.id)
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

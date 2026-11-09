/**
 * 通用后台任务骨架（音乐与 B 站共用）。
 *
 * 分工：
 * - **这里**管生命周期：建任务、起后台进程、并发跑、取消、恢复、计数、收尾通知
 * - **各能力域**只管"一项怎么处理"：注册一个 `(item, ctx) => result` 的处理器
 *
 * 关键设计（都从音乐那边验证过的行为搬过来）：
 * - 创建任务的命令立刻返回 job id，后台起一个分离子进程跑 `_worker`
 * - 进度只靠数据库，CLI 无常驻进程；`job` 命令随时可查
 * - 每处理完一项检查一次取消标记
 * - worker 进程没了而状态还是 running → 判定为中断，可以 `resume`
 * - 表和列是共用的，各域自己的业务字段（音质 / 画质 / 分 P）放进 `meta` JSON
 *
 * 0.56.0：表搬进统一的状态库（线上是 PG），所有读写变成异步。
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import path from 'node:path'
import { all, num, numOrNull, one, run, tx } from './state.ts'
import { AstraError } from './errors.ts'
import { homePath } from './paths.ts'
import { notify } from './notify.ts'
import { currentIdentity, currentToken } from './identity.ts'
import { pinnedEntry } from './entry.ts'

export type JobStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'cancelled' | 'interrupted'
// 任务项状态。`downloaded` 与单曲 `data.status` 同词，调用方可以用一套过滤；
// `skipped` = 曲库里已有、跳过。
export type ItemStatus = 'queued' | 'running' | 'downloaded' | 'skipped' | 'failed'

export interface JobView {
  id: string
  /** 哪个能力域的任务：`music` / `bili`。 */
  domain: string
  kind: string
  title: string
  status: JobStatus
  /** 音乐是音质，B 站是画质；统一叫 profile。 */
  profile: string | null
  total: number
  done: number
  skipped: number
  failed: number
  createdAt: string
  updatedAt: string
  /** 谁起的（M3）；老任务为 null，只有 owner 看得到。 */
  owner: string | null
  error: string | null
  meta: Record<string, unknown> | null
}

export interface JobItemView {
  seq: number
  id: string
  title: string
  /** 副标题：音乐是歌手，B 站是 UP 主 / 分 P。 */
  subtitle: string | null
  status: ItemStatus
  profile: string | null
  path: string | null
  /** 失败原因（只在 failed 时有）。 */
  error: string | null
  /** 成功但值得一提的事：音质降级、没有音频流等。 */
  note: string | null
  meta: Record<string, unknown> | null
}

/** 一个待处理项。`meta` 由各域自己定义。 */
export interface JobItemInput {
  id: string
  title: string
  subtitle?: string | null
  meta?: Record<string, unknown>
}

/** 处理器返回什么就算什么：skipped 表示"已经有了，跳过"。 */
export interface ItemOutcome {
  status: 'downloaded' | 'skipped'
  profile?: string | null
  path?: string | null
  note?: string | null
  meta?: Record<string, unknown>
}

export interface WorkerContext {
  jobId: string
  domain: string
  /** 这些项已经不需要做了（被取消）。 */
  cancelled: () => Promise<boolean>
  /** 报告一项的进度（写进 job_items）。 */
  report: (seq: number, outcome: ItemOutcome | { status: 'failed'; error: string }) => Promise<void>
  /** 整个任务共用的上下文，比如"同一张专辑只查一次"的缓存。 */
  shared: Map<string, unknown>
}

export type ItemHandler = (item: { seq: number; id: string; meta: Record<string, unknown> }, ctx: WorkerContext) => Promise<ItemOutcome>

interface Handler {
  /** 并发数。 */
  concurrency: (meta: Record<string, unknown>) => number
  handle: ItemHandler
  /** 收尾通知文案：各域自己拼（"音质：24bit 3" / "画质：1080P 5"）。 */
  summary: (items: JobItemView[]) => string[]
  /** worker 启动时清理上次被强杀留下的临时文件。 */
  sweep?: () => Promise<void>
  /**
   * 任务结束（完成 / 部分完成 / 失败 / 取消）后调一次，会被 await。
   *
   * 该域需要按**实际结果**更新自己的状态时用 —— 比如订阅要记下
   * "这个视频的哪几个分 P 确实落盘了"。只有 `downloaded` / `skipped`
   * 的项才算数，失败的下次要重试。
   */
  afterFinish?: (job: JobView, items: JobItemView[]) => void | Promise<void>
  /**
   * 所有项跑完后、发通知**之前**调一次，会被 await。
   *
   * 给「各项只是原料，最后还要合成一个产物」的域用 —— 小说要把各章打成一本 EPUB。
   * 返回的行追加进通知；可以用 `patchJob` 写 meta（产物路径之类）。
   * 跑 finalize 期间任务对外仍是 running，结束后才落 done / partial —— 轮询的调用方
   * 看到「已完成」时产物一定已经写好。抛错 = 任务记为 failed，错误原因进通知。
   */
  finalize?: (job: JobView, items: JobItemView[]) => Promise<string[]>
}

const handlers = new Map<string, Handler>()

/** 各能力域在启动时注册自己的处理器。 */
export function registerJobHandler(domain: string, handler: Handler): void {
  handlers.set(domain, handler)
}

function handlerFor(domain: string): Handler {
  const handler = handlers.get(domain)
  if (!handler) throw new AstraError('NO_JOB_HANDLER', `没有为 ${domain} 注册任务处理器`, { exitCode: 1 })
  return handler
}

interface JobRow {
  id: string
  kind: string
  title: string
  status: string
  quality: string | null
  total: number
  done: number
  failed: number
  skipped: number
  pid: number | null
  error: string | null
  created_at: string
  updated_at: string
  meta: string | null
  owner: string | null
}

interface ItemRow {
  job_id: string
  seq: number
  native_id: string
  title: string
  artists: string
  status: string
  quality: string | null
  file_path: string | null
  error: string | null
  meta: string | null
}

const now = (): string => new Date().toISOString()

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function alive(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 受限主体（带令牌且不是 owner）只能看自己起的任务。 */
function ownerScope(): string | null {
  const identity = currentIdentity()
  return identity.kind === 'owner' ? null : identity.name
}

/** PG 的整数列可能回来是字符串，统一一次。 */
function normalizeJob(row: JobRow): JobRow {
  return {
    ...row,
    total: num(row.total),
    done: num(row.done),
    failed: num(row.failed),
    skipped: num(row.skipped),
    pid: numOrNull(row.pid),
  }
}

function normalizeItem(row: ItemRow): ItemRow {
  return { ...row, seq: num(row.seq) }
}

function domainOf(row: JobRow): string {
  const meta = parseJson(row.meta)
  return typeof meta?.domain === 'string' ? meta.domain : 'music'
}

async function toView(raw: JobRow): Promise<JobView> {
  const row = normalizeJob(raw)
  const meta = parseJson(row.meta)
  let status = row.status as JobStatus
  // 刚建好、还没起 worker 的任务 pid 为空 —— 不能当成中断。早先 createJob 自己返回视图时
  // 就会走到这里，把每个新任务当场写成 interrupted（worker 起来后再改回 running），
  // 建完立刻查进度的调用方（`novel get --wait`）因此一上来就看到「已中断」
  const justCreated = status === 'queued' && !row.pid && Date.now() - Date.parse(row.created_at) < 60_000
  if ((status === 'running' || status === 'queued') && !justCreated && !alive(row.pid)) {
    status = 'interrupted'
    await run("update jobs set status = 'interrupted', updated_at = ? where id = ?", [now(), row.id])
  }
  return {
    id: row.id,
    domain: domainOf(row),
    kind: row.kind,
    title: row.title,
    status,
    profile: row.quality,
    total: row.total,
    done: row.done,
    skipped: row.skipped,
    failed: row.failed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    owner: row.owner,
    error: row.error,
    meta,
  }
}

function itemView(raw: ItemRow): JobItemView {
  const row = normalizeItem(raw)
  const failed = row.status === 'failed'
  return {
    seq: row.seq,
    id: row.native_id,
    title: row.title,
    // artists 列现在存"副标题"：音乐是歌手，B 站是 UP 主 / 分 P
    subtitle: row.artists || null,
    status: row.status as ItemStatus,
    profile: row.quality,
    path: row.file_path,
    error: failed ? row.error : null,
    note: failed ? null : row.error,
    meta: parseJson(row.meta),
  }
}

/** 只写用于显示的元信息（domain），业务数据在 items 的 meta 里。 */
function jobMeta(domain: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ domain, ...extra })
}

async function jobRow(id: string, domain?: string): Promise<JobRow> {
  const scope = ownerScope()
  const rows = (await all<JobRow>('select * from jobs where id = ? or id like ?', [id, `${id}%`])).map(normalizeJob)
  // 别人的任务当作不存在，不暴露它们的存在
  const visible = scope ? rows.filter((r) => r.owner === scope) : rows
  const filtered = domain ? visible.filter((r) => domainOf(r) === domain) : visible
  if (filtered.length === 0) throw new AstraError('NOT_FOUND', `没有任务 ${id}`, { exitCode: 4, hint: '用 `jobs` 看最近的任务' })
  if (filtered.length > 1) throw new AstraError('AMBIGUOUS_ID', `任务 id 前缀 ${id} 对应多个任务`, { exitCode: 2, hint: '多写几位 id' })
  return filtered[0]!
}

export interface CreateJobOptions {
  domain: string
  kind: string
  title: string
  /** 音乐传音质、B 站传画质。 */
  profile?: string | null
  items: JobItemInput[]
  meta?: Record<string, unknown>
}

export async function createJob(options: CreateJobOptions): Promise<JobView> {
  if (options.items.length === 0) throw new AstraError('EMPTY_JOB', '任务里没有内容', { exitCode: 4 })
  const id = randomUUID().slice(0, 8)
  await tx(async (conn) => {
    await conn.exec(
      'insert into jobs (id, kind, title, status, quality, total, created_at, updated_at, meta, owner) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, options.kind, options.title, 'queued', options.profile ?? null, options.items.length, now(), now(), jobMeta(options.domain, options.meta ?? {}), currentIdentity().name],
    )
    // 一次插一批：几百项的任务（整张歌单）逐条 insert 在 PG 上要上百次往返
    const CHUNK = 200
    for (let start = 0; start < options.items.length; start += CHUNK) {
      const slice = options.items.slice(start, start + CHUNK)
      const values: unknown[] = []
      const marks = slice.map((item, offset) => {
        values.push(id, start + offset, item.id, item.title, item.subtitle ?? '', 'queued', now(), item.meta ? JSON.stringify(item.meta) : null)
        return '(?, ?, ?, ?, ?, ?, ?, ?)'
      })
      await conn.exec(`insert into job_items (job_id, seq, native_id, title, artists, status, updated_at, meta) values ${marks.join(', ')}`, values)
    }
  })
  return (await getJob(id, false)).job
}

/** 起后台 worker。开发态（.ts）和打包态（.mjs）都用当前进程同样的入口与参数。 */
export async function spawnWorker(domain: string, jobId: string): Promise<number> {
  const logDir = homePath('logs')
  mkdirSync(logDir, { recursive: true })
  const log = openSync(path.join(logDir, `job-${domain}-${jobId}.log`), 'a')
  // 钉在当前版本：任务可能跑几小时，期间部署换了桩，worker 也不该懒加载到新版本的块
  const entry = pinnedEntry()
  const child = spawn(process.execPath, [...process.execArgv, entry, domain, '_worker', jobId], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: {
      ...process.env,
      ASTRA_QUIET: '0',
      // 父进程已把 ASTRA_TOKEN 从环境删掉；worker 必须显式拿到同一身份，否则会 AUTH_REQUIRED
      ...(currentToken() ? { ASTRA_TOKEN: currentToken()! } : {}),
    },
  })
  child.unref()
  const pid = child.pid ?? 0
  await run('update jobs set pid = ?, updated_at = ? where id = ?', [pid, now(), jobId])
  return pid
}

export async function getJob(id: string, withItems: boolean, domain?: string): Promise<{ job: JobView; items?: JobItemView[] }> {
  const row = await jobRow(id, domain)
  const job = await toView(row)
  if (!withItems) return { job }
  const items = (await all<ItemRow>('select * from job_items where job_id = ? order by seq', [row.id])).map(itemView)
  return { job, items }
}

export async function listJobs(limit: number, activeOnly: boolean, domain?: string): Promise<JobView[]> {
  const rows = (await all<JobRow>('select * from jobs order by created_at desc limit ?', [activeOnly ? 200 : limit])).map(normalizeJob)
  const scope = ownerScope()
  const visible = rows.filter((r) => (scope ? r.owner === scope : true)).filter((r) => !domain || domainOf(r) === domain)
  const views: JobView[] = []
  for (const row of visible) views.push(await toView(row))
  return activeOnly ? views.filter((j) => j.status === 'running' || j.status === 'queued').slice(0, limit) : views
}

async function refreshCounts(jobId: string): Promise<void> {
  await run(
    `update jobs set
       done = (select count(*) from job_items where job_id = ? and status = 'downloaded'),
       skipped = (select count(*) from job_items where job_id = ? and status = 'skipped'),
       failed = (select count(*) from job_items where job_id = ? and status = 'failed'),
       updated_at = ?
     where id = ?`,
    [jobId, jobId, jobId, now(), jobId],
  )
}

async function isCancelled(jobId: string): Promise<boolean> {
  const row = await one<{ status: string }>('select status from jobs where id = ?', [jobId])
  return row?.status === 'cancelled'
}

/**
 * worker 主循环。各域通过 `registerJobHandler` 提供 `handle`。
 *
 * 处理器在**同一进程**里串/并发执行；一个项失败不影响其它项。
 */
export async function runWorker(domain: string, jobId: string): Promise<void> {
  const row = await jobRow(jobId, domain)
  if (row.status === 'cancelled') return
  const handler = handlerFor(domain)
  if (handler.sweep) await handler.sweep()

  await run("update jobs set status = 'running', pid = ?, error = null, updated_at = ? where id = ?", [process.pid, now(), row.id])
  // 中断恢复：上次跑到一半的项重新排队
  await run("update job_items set status = 'queued' where job_id = ? and status = 'running'", [row.id])
  const pending = (await all<ItemRow>("select * from job_items where job_id = ? and status in ('queued', 'failed') order by seq", [row.id])).map(normalizeItem)
  const jobMetaParsed = parseJson(row.meta) ?? {}

  const setItem = (values: unknown[]): Promise<number> =>
    run('update job_items set status = ?, quality = ?, file_path = ?, error = ?, updated_at = ?, meta = coalesce(?, meta) where job_id = ? and seq = ?', values)
  const ctx: WorkerContext = {
    jobId: row.id,
    domain,
    cancelled: () => isCancelled(row.id),
    report: async (seq, outcome) => {
      if (outcome.status === 'failed') {
        await setItem(['failed', null, null, outcome.error.slice(0, 300), now(), null, row.id, seq])
      } else {
        await setItem([outcome.status, outcome.profile ?? null, outcome.path ?? null, outcome.note ?? null, now(), outcome.meta ? JSON.stringify(outcome.meta) : null, row.id, seq])
      }
      await refreshCounts(row.id)
    },
    shared: new Map(),
  }

  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (await ctx.cancelled()) return
      const item = pending[cursor]
      cursor += 1
      if (!item) return
      await setItem(['running', null, null, null, now(), null, row.id, item.seq])
      try {
        const outcome = await handler.handle({ seq: item.seq, id: item.native_id, meta: parseJson(item.meta) ?? {} }, ctx)
        await ctx.report(item.seq, outcome)
      } catch (err) {
        await ctx.report(item.seq, { status: 'failed', error: (err as Error).message })
      }
    }
  }

  const concurrency = Math.max(1, Math.min(handler.concurrency(jobMetaParsed), pending.length || 1))
  await Promise.all(Array.from({ length: concurrency }, worker))

  if (!(await isCancelled(row.id))) {
    await refreshCounts(row.id)
    const counts = await one<{ total: number; done: number; skipped: number; failed: number }>('select total, done, skipped, failed from jobs where id = ?', [row.id])
    const done = num(counts?.done)
    const skipped = num(counts?.skipped)
    const failed = num(counts?.failed)
    const status: JobStatus = failed === 0 ? 'done' : done + skipped > 0 ? 'partial' : 'failed'
    // 有 finalize 的域：状态先留在 running，finalize 跑完（产物写好）再落最终状态。
    // 否则轮询 `--wait` 的调用方会在「已完成、产物还没出来」的空档拿到结果
    if (handler.finalize) await runFinalize(domain, row.id, status)
    else await run('update jobs set status = ?, updated_at = ? where id = ?', [status, now(), row.id])
  }
  await finish(domain, row.id)
}

/** finalize 的结果行，留给 finish() 拼进通知。 */
const finalizeNotes = new Map<string, string[]>()

async function runFinalize(domain: string, jobId: string, status: JobStatus): Promise<void> {
  const handler = handlerFor(domain)
  // finalize 看到的是「即将落定」的状态，便于它判断要不要出产物
  await run('update jobs set status = ?, updated_at = ? where id = ?', [status, now(), jobId])
  const snapshot = await getJob(jobId, true, domain)
  await run("update jobs set status = 'running', updated_at = ? where id = ?", [now(), jobId])
  // finalize 可能要几十秒（打包、传图）。期间用户 cancel 了，就以取消为准：
  // 最终状态只在「还是 running」时才写，不覆盖 cancelled
  const settle = (next: JobStatus, error: string | null = null): Promise<number> =>
    run("update jobs set status = ?, error = coalesce(?, error), updated_at = ? where id = ? and status = 'running'", [next, error, now(), jobId])
  try {
    finalizeNotes.set(jobId, await handler.finalize!(snapshot.job, snapshot.items ?? []))
    await settle(status)
  } catch (err) {
    const message = (err as Error).message.slice(0, 300)
    await settle('failed', message)
    finalizeNotes.set(jobId, [`✗ ${message}`])
  }
}

/** 改任务的状态 / 错误 / meta（meta 是浅合并）。给 `finalize` 用。 */
export async function patchJob(jobId: string, patch: { status?: JobStatus; error?: string | null; meta?: Record<string, unknown> }): Promise<void> {
  const row = await one<{ meta: string | null }>('select meta from jobs where id = ?', [jobId])
  if (!row) return
  if (patch.meta) {
    const merged = { ...(parseJson(row.meta) ?? {}), ...patch.meta }
    await run('update jobs set meta = ?, updated_at = ? where id = ?', [JSON.stringify(merged), now(), jobId])
  }
  if (patch.status) await run('update jobs set status = ?, updated_at = ? where id = ?', [patch.status, now(), jobId])
  if (patch.error !== undefined) await run('update jobs set error = ?, updated_at = ? where id = ?', [patch.error, now(), jobId])
}

async function finish(domain: string, jobId: string): Promise<void> {
  const handler = handlers.get(domain)
  const extra = finalizeNotes.get(jobId) ?? []
  finalizeNotes.delete(jobId)
  const { job, items } = await getJob(jobId, true, domain)
  // 域自己的收尾（按实际结果更新状态）。出问题不能影响通知。
  if (handler?.afterFinish) {
    try {
      await handler.afterFinish(job, items ?? [])
    } catch {
      // 收尾失败不该让任务变红，下次检查会再补
    }
  }
  const failed = (items ?? []).filter((i) => i.status === 'failed')
  const lines = [
    `【${job.title}】${statusLabel(job.status)}`,
    `共 ${job.total} 项：新完成 ${job.done}，已有 ${job.skipped}，失败 ${job.failed}`,
    ...(handler ? handler.summary(items ?? []) : []),
    ...extra,
    ...failed.slice(0, 5).map((i) => `✗ ${i.title}${i.subtitle ? ` - ${i.subtitle}` : ''}：${i.error ?? ''}`),
    failed.length > 5 ? `…另有 ${failed.length - 5} 项失败，详见 astra ${domain} job ${job.id}` : '',
  ].filter(Boolean)
  await notify(lines.join('\n'))
}

export function statusLabel(status: JobStatus): string {
  return { queued: '排队中', running: '处理中', done: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }[status]
}

export async function cancelJob(id: string, domain?: string): Promise<JobView> {
  const row = await jobRow(id, domain)
  if (['done', 'partial', 'failed', 'cancelled'].includes(row.status)) return toView(row)
  const scope = ownerScope()
  await run(`update jobs set status = 'cancelled', updated_at = ? where id = ?${scope ? ' and owner = ?' : ''}`, scope ? [now(), row.id, scope] : [now(), row.id])
  if (alive(row.pid) && row.pid !== process.pid) {
    try {
      process.kill(row.pid!)
    } catch {
      // 已经退出
    }
  }
  await run("update job_items set status = 'queued' where job_id = ? and status = 'running'", [row.id])
  return (await getJob(row.id, false, domain)).job
}

export async function resumeJob(id: string, domain?: string): Promise<JobView> {
  const row = await jobRow(id, domain)
  const view = await toView(row)
  if (view.status === 'running' || view.status === 'queued') {
    throw new AstraError('JOB_RUNNING', `任务 ${row.id} 还在跑`, { exitCode: 2, hint: `用 \`astra ${view.domain} job <id>\` 看进度` })
  }
  const retryable = num((await one<{ n: number }>("select count(*) n from job_items where job_id = ? and status in ('queued', 'failed', 'running')", [row.id]))?.n)
  if (retryable === 0) throw new AstraError('NOTHING_TO_RESUME', `任务 ${row.id} 没有需要重试的项`, { exitCode: 2 })
  const scope = ownerScope()
  await run(`update jobs set status = 'queued', error = null, updated_at = ? where id = ?${scope ? ' and owner = ?' : ''}`, scope ? [now(), row.id, scope] : [now(), row.id])
  await spawnWorker(view.domain, row.id)
  return (await getJob(row.id, false, domain)).job
}

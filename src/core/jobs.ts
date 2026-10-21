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
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import path from 'node:path'
import { db } from './db.ts'
import { AstraError } from './errors.ts'
import { homePath } from './paths.ts'
import { notify } from './notify.ts'

export type JobStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'cancelled' | 'interrupted'
export type ItemStatus = 'queued' | 'running' | 'done' | 'skipped' | 'failed'

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
  status: 'done' | 'skipped'
  profile?: string | null
  path?: string | null
  note?: string | null
  meta?: Record<string, unknown>
}

export interface WorkerContext {
  jobId: string
  domain: string
  /** 这些项已经不需要做了（被取消）。 */
  cancelled: () => boolean
  /** 报告一项的进度（写进 job_items）。 */
  report: (seq: number, outcome: ItemOutcome | { status: 'failed'; error: string }) => void
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

function toView(row: JobRow): JobView {
  const meta = parseJson(row.meta)
  let status = row.status as JobStatus
  if ((status === 'running' || status === 'queued') && !alive(row.pid)) {
    status = 'interrupted'
    db().prepare("update jobs set status = 'interrupted', updated_at = ? where id = ?").run(now(), row.id)
  }
  return {
    id: row.id,
    domain: typeof meta?.domain === 'string' ? meta.domain : 'music',
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
    error: row.error,
    meta,
  }
}

function itemView(row: ItemRow): JobItemView {
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

function jobRow(id: string, domain?: string): JobRow {
  const rows = db().prepare('select * from jobs where id = ? or id like ?').all(id, `${id}%`) as unknown as JobRow[]
  const filtered = domain ? rows.filter((r) => toView(r).domain === domain) : rows
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

export function createJob(options: CreateJobOptions): JobView {
  if (options.items.length === 0) throw new AstraError('EMPTY_JOB', '任务里没有内容', { exitCode: 4 })
  const id = randomUUID().slice(0, 8)
  const database = db()
  database.exec('begin immediate')
  try {
    database
      .prepare('insert into jobs (id, kind, title, status, quality, total, created_at, updated_at, meta) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, options.kind, options.title, 'queued', options.profile ?? null, options.items.length, now(), now(), jobMeta(options.domain, options.meta ?? {}))
    const insert = database.prepare('insert into job_items (job_id, seq, native_id, title, artists, status, updated_at, meta) values (?, ?, ?, ?, ?, ?, ?, ?)')
    options.items.forEach((item, i) => insert.run(id, i, item.id, item.title, item.subtitle ?? '', 'queued', now(), item.meta ? JSON.stringify(item.meta) : null))
    database.exec('commit')
  } catch (err) {
    database.exec('rollback')
    throw err
  }
  return getJob(id, false).job
}

/** 起后台 worker。开发态（.ts）和打包态（.mjs）都用当前进程同样的入口与参数。 */
export function spawnWorker(domain: string, jobId: string): number {
  const logDir = homePath('logs')
  mkdirSync(logDir, { recursive: true })
  const log = openSync(path.join(logDir, `job-${domain}-${jobId}.log`), 'a')
  const entry = process.argv[1]
  if (!entry) throw new AstraError('INTERNAL', '无法确定 CLI 入口文件', { exitCode: 1 })
  const child = spawn(process.execPath, [...process.execArgv, entry, domain, '_worker', jobId], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: { ...process.env, ASTRA_QUIET: '0' },
  })
  child.unref()
  const pid = child.pid ?? 0
  db().prepare('update jobs set pid = ?, updated_at = ? where id = ?').run(pid, now(), jobId)
  return pid
}

export function getJob(id: string, withItems: boolean, domain?: string): { job: JobView; items?: JobItemView[] } {
  const row = jobRow(id, domain)
  const job = toView(row)
  if (!withItems) return { job }
  const items = (db().prepare('select * from job_items where job_id = ? order by seq').all(row.id) as unknown as ItemRow[]).map(itemView)
  return { job, items }
}

export function listJobs(limit: number, activeOnly: boolean, domain?: string): JobView[] {
  const rows = db().prepare('select * from jobs order by created_at desc limit ?').all(activeOnly ? 200 : limit) as unknown as JobRow[]
  const views = rows.map(toView).filter((j) => !domain || j.domain === domain)
  return activeOnly ? views.filter((j) => j.status === 'running' || j.status === 'queued').slice(0, limit) : views
}

function refreshCounts(jobId: string): void {
  db()
    .prepare(
      `update jobs set
         done = (select count(*) from job_items where job_id = ? and status = 'done'),
         skipped = (select count(*) from job_items where job_id = ? and status = 'skipped'),
         failed = (select count(*) from job_items where job_id = ? and status = 'failed'),
         updated_at = ?
       where id = ?`,
    )
    .run(jobId, jobId, jobId, now(), jobId)
}

function isCancelled(jobId: string): boolean {
  const row = db().prepare('select status from jobs where id = ?').get(jobId) as { status: string } | undefined
  return row?.status === 'cancelled'
}

/**
 * worker 主循环。各域通过 `registerJobHandler` 提供 `handle`。
 *
 * 处理器在**同一进程**里串/并发执行；一个项失败不影响其它项。
 */
export async function runWorker(domain: string, jobId: string): Promise<void> {
  const row = jobRow(jobId, domain)
  if (row.status === 'cancelled') return
  const handler = handlerFor(domain)
  if (handler.sweep) await handler.sweep()

  db().prepare("update jobs set status = 'running', pid = ?, error = null, updated_at = ? where id = ?").run(process.pid, now(), row.id)
  // 中断恢复：上次跑到一半的项重新排队
  db().prepare("update job_items set status = 'queued' where job_id = ? and status = 'running'").run(row.id)
  const pending = db().prepare("select * from job_items where job_id = ? and status in ('queued', 'failed') order by seq").all(row.id) as unknown as ItemRow[]
  const jobMetaParsed = parseJson(row.meta) ?? {}

  const setItem = db().prepare('update job_items set status = ?, quality = ?, file_path = ?, error = ?, updated_at = ?, meta = coalesce(?, meta) where job_id = ? and seq = ?')
  const ctx: WorkerContext = {
    jobId: row.id,
    domain,
    cancelled: () => isCancelled(row.id),
    report: (seq, outcome) => {
      if (outcome.status === 'failed') {
        setItem.run('failed', null, null, outcome.error.slice(0, 300), now(), null, row.id, seq)
      } else {
        setItem.run(outcome.status, outcome.profile ?? null, outcome.path ?? null, outcome.note ?? null, now(), outcome.meta ? JSON.stringify(outcome.meta) : null, row.id, seq)
      }
      refreshCounts(row.id)
    },
    shared: new Map(),
  }

  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (ctx.cancelled()) return
      const item = pending[cursor]
      cursor += 1
      if (!item) return
      setItem.run('running', null, null, null, now(), null, row.id, item.seq)
      try {
        const outcome = await handler.handle({ seq: item.seq, id: item.native_id, meta: parseJson(item.meta) ?? {} }, ctx)
        ctx.report(item.seq, outcome)
      } catch (err) {
        ctx.report(item.seq, { status: 'failed', error: (err as Error).message })
      }
    }
  }

  const concurrency = Math.max(1, Math.min(handler.concurrency(jobMetaParsed), pending.length || 1))
  await Promise.all(Array.from({ length: concurrency }, worker))

  if (!isCancelled(row.id)) {
    refreshCounts(row.id)
    const counts = db().prepare('select total, done, skipped, failed from jobs where id = ?').get(row.id) as { total: number; done: number; skipped: number; failed: number }
    const status: JobStatus = counts.failed === 0 ? 'done' : counts.done + counts.skipped > 0 ? 'partial' : 'failed'
    db().prepare('update jobs set status = ?, updated_at = ? where id = ?').run(status, now(), row.id)
  }
  await finish(domain, row.id)
}

async function finish(domain: string, jobId: string): Promise<void> {
  const { job, items } = getJob(jobId, true, domain)
  const handler = handlers.get(domain)
  const failed = (items ?? []).filter((i) => i.status === 'failed')
  const lines = [
    `【${job.title}】${statusLabel(job.status)}`,
    `共 ${job.total} 项：新完成 ${job.done}，已有 ${job.skipped}，失败 ${job.failed}`,
    ...(handler ? handler.summary(items ?? []) : []),
    ...failed.slice(0, 5).map((i) => `✗ ${i.title}${i.subtitle ? ` - ${i.subtitle}` : ''}：${i.error ?? ''}`),
    failed.length > 5 ? `…另有 ${failed.length - 5} 项失败，详见 astra ${domain} job ${job.id}` : '',
  ].filter(Boolean)
  await notify(lines.join('\n'))
}

export function statusLabel(status: JobStatus): string {
  return { queued: '排队中', running: '处理中', done: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }[status]
}

export function cancelJob(id: string, domain?: string): JobView {
  const row = jobRow(id, domain)
  if (['done', 'partial', 'failed', 'cancelled'].includes(row.status)) return toView(row)
  db().prepare("update jobs set status = 'cancelled', updated_at = ? where id = ?").run(now(), row.id)
  if (alive(row.pid) && row.pid !== process.pid) {
    try {
      process.kill(row.pid!)
    } catch {
      // 已经退出
    }
  }
  db().prepare("update job_items set status = 'queued' where job_id = ? and status = 'running'").run(row.id)
  return getJob(row.id, false, domain).job
}

export function resumeJob(id: string, domain?: string): JobView {
  const row = jobRow(id, domain)
  const view = toView(row)
  if (view.status === 'running' || view.status === 'queued') {
    throw new AstraError('JOB_RUNNING', `任务 ${row.id} 还在跑`, { exitCode: 2, hint: `用 \`astra ${view.domain} job <id>\` 看进度` })
  }
  const retryable = (db().prepare("select count(*) n from job_items where job_id = ? and status in ('queued', 'failed', 'running')").get(row.id) as { n: number }).n
  if (retryable === 0) throw new AstraError('NOTHING_TO_RESUME', `任务 ${row.id} 没有需要重试的项`, { exitCode: 2 })
  db().prepare("update jobs set status = 'queued', error = null, updated_at = ? where id = ?").run(now(), row.id)
  spawnWorker(view.domain, row.id)
  return getJob(row.id, false, domain).job
}

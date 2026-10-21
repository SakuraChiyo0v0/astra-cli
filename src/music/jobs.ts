/**
 * 批量任务（歌单 / 专辑 / 歌手 / 多首）：后台进程执行，状态落库。
 *
 * - 创建任务的命令立刻返回 job id，后台起一个分离的子进程 `astra music _worker <id>` 跑
 * - 进度只靠数据库，CLI 无常驻进程；`job` 命令随时可查
 * - worker 每处理完一项检查一次取消标记
 * - worker 进程没了而状态还是 running → 判定为中断（机器重启、容器重建），可以 `job resume`
 * - 结束时如果配了 `notify.feishu_webhook`，推一条汇总到飞书
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { openSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { db } from '../core/db.ts'
import { AstraError } from '../core/errors.ts'
import { homePath } from '../core/paths.ts'
import { getConfig } from '../core/config.ts'
import { songDetails, type Track } from './netease.ts'
import { downloadTrack } from './download.ts'
import type { AlbumInfo } from './netease.ts'
import type { Quality } from './audio.ts'
import { notify } from '../core/notify.ts'

export type JobStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'cancelled' | 'interrupted'
export type ItemStatus = 'queued' | 'running' | 'done' | 'skipped' | 'failed'

export interface JobView {
  id: string
  kind: string
  title: string
  status: JobStatus
  quality: Quality
  total: number
  done: number
  skipped: number
  failed: number
  createdAt: string
  updatedAt: string
  error: string | null
}

export interface JobItemView {
  seq: number
  id: string
  title: string
  artists: string[]
  status: ItemStatus
  quality: string | null
  path: string | null
  error: string | null
  /** 成功但值得一提的事，比如"请求 flac，音源只给到 128k"。 */
  note: string | null
}

interface JobRow {
  id: string
  kind: string
  title: string
  status: string
  quality: string
  total: number
  done: number
  failed: number
  skipped: number
  pid: number | null
  error: string | null
  created_at: string
  updated_at: string
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
}

const now = (): string => new Date().toISOString()

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
  let status = row.status as JobStatus
  if ((status === 'running' || status === 'queued') && !alive(row.pid)) {
    status = 'interrupted'
    db().prepare("update jobs set status = 'interrupted', updated_at = ? where id = ?").run(now(), row.id)
  }
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status,
    quality: row.quality as Quality,
    total: row.total,
    done: row.done,
    skipped: row.skipped,
    failed: row.failed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
  }
}

function itemView(row: ItemRow): JobItemView {
  const failed = row.status === 'failed'
  return {
    seq: row.seq,
    id: row.native_id,
    title: row.title,
    artists: JSON.parse(row.artists) as string[],
    status: row.status as ItemStatus,
    quality: row.quality,
    path: row.file_path,
    // 同一列存两种东西：失败原因，或成功时的提醒（音质降级等）。对外分开，免得 AI 把提醒当失败
    error: failed ? row.error : null,
    note: failed ? null : row.error,
  }
}

function jobRow(id: string): JobRow {
  const rows = db().prepare('select * from jobs where id = ? or id like ?').all(id, `${id}%`) as unknown as JobRow[]
  if (rows.length === 0) throw new AstraError('NOT_FOUND', `没有任务 ${id}`, { exitCode: 4, hint: '用 `astra music jobs` 看最近的任务' })
  if (rows.length > 1) throw new AstraError('AMBIGUOUS_ID', `任务 id 前缀 ${id} 对应多个任务`, { exitCode: 2, hint: '多写几位 id' })
  return rows[0]!
}

export function getJob(id: string, withItems: boolean): { job: JobView; items?: JobItemView[] } {
  const row = jobRow(id)
  const job = toView(row)
  if (!withItems) return { job }
  const items = (db().prepare('select * from job_items where job_id = ? order by seq').all(row.id) as unknown as ItemRow[]).map(itemView)
  return { job, items }
}

export function listJobs(limit: number, activeOnly: boolean): JobView[] {
  const rows = db().prepare('select * from jobs order by created_at desc limit ?').all(activeOnly ? 200 : limit) as unknown as JobRow[]
  const views = rows.map(toView)
  return activeOnly ? views.filter((j) => j.status === 'running' || j.status === 'queued').slice(0, limit) : views
}

export function createJob(kind: string, title: string, quality: Quality, tracks: Track[]): JobView {
  const id = randomUUID().slice(0, 8)
  const database = db()
  database.exec('begin immediate')
  try {
    database
      .prepare('insert into jobs (id, kind, title, status, quality, total, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, kind, title, 'queued', quality, tracks.length, now(), now())
    const insert = database.prepare('insert into job_items (job_id, seq, native_id, title, artists, status, updated_at) values (?, ?, ?, ?, ?, ?, ?)')
    tracks.forEach((t, i) => insert.run(id, i, t.id, t.title, JSON.stringify(t.artists), 'queued', now()))
    database.exec('commit')
  } catch (err) {
    database.exec('rollback')
    throw err
  }
  return getJob(id, false).job
}

/** 起后台 worker。开发态（.ts）和打包态（.mjs）都用当前进程同样的入口与参数。 */
export function spawnWorker(jobId: string): number {
  const logDir = homePath('logs')
  mkdirSync(logDir, { recursive: true })
  const log = openSync(path.join(logDir, `job-${jobId}.log`), 'a')
  const entry = process.argv[1]
  if (!entry) throw new AstraError('INTERNAL', '无法确定 CLI 入口文件', { exitCode: 1 })
  const child = spawn(process.execPath, [...process.execArgv, entry, 'music', '_worker', jobId], {
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

/** 被强杀（取消 / 机器重启）留下的临时文件。下次 worker 启动时顺手清掉。 */
async function sweepPartials(paths: (string | null)[]): Promise<void> {
  const { readdir, rm } = await import('node:fs/promises')
  const dirs = new Set(paths.filter((p): p is string => !!p).map((p) => path.dirname(p)))
  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names) {
      if (/\.part-\d+(\.tagging)?$/.test(name)) await rm(path.join(dir, name), { force: true })
    }
  }
}

/** worker 主循环。并发数取 `music.concurrency`。 */
export async function runWorker(jobId: string): Promise<void> {
  const row = jobRow(jobId)
  if (row.status === 'cancelled') return
  const known = db().prepare('select file_path from tracks').all() as { file_path: string }[]
  await sweepPartials(known.map((k) => k.file_path))
  db().prepare("update jobs set status = 'running', pid = ?, error = null, updated_at = ? where id = ?").run(process.pid, now(), row.id)
  // 中断恢复：上次跑到一半的项重新排队
  db().prepare("update job_items set status = 'queued' where job_id = ? and status = 'running'").run(row.id)
  const pending = db().prepare("select * from job_items where job_id = ? and status in ('queued', 'failed') order by seq").all(row.id) as unknown as ItemRow[]
  const quality = row.quality as Quality
  const albumCache = new Map<string, Promise<AlbumInfo | null>>()
  const concurrency = Number(getConfig('music.concurrency')) || 2

  // 详情一次批量拿，下载时不再逐首查
  let details = new Map<string, Track>()
  try {
    details = new Map((await songDetails(pending.map((p) => p.native_id))).map((t) => [t.id, t]))
  } catch (err) {
    db().prepare("update jobs set status = 'failed', error = ?, updated_at = ? where id = ?").run(`获取歌曲详情失败：${(err as Error).message}`, now(), row.id)
    await finish(row.id)
    return
  }

  const setItem = db().prepare('update job_items set status = ?, quality = ?, file_path = ?, error = ?, updated_at = ? where job_id = ? and seq = ?')
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (isCancelled(row.id)) return
      const item = pending[cursor]
      cursor += 1
      if (!item) return
      const track = details.get(item.native_id)
      if (!track) {
        setItem.run('failed', null, null, '网易云已下架这首歌', now(), row.id, item.seq)
        refreshCounts(row.id)
        continue
      }
      setItem.run('running', null, null, null, now(), row.id, item.seq)
      try {
        const result = await downloadTrack(track, { quality, albumCache })
        const note = result.warnings.length > 0 ? result.warnings.join('；') : null
        setItem.run(result.status === 'already_have' ? 'skipped' : 'done', result.quality, result.path, note, now(), row.id, item.seq)
      } catch (err) {
        setItem.run('failed', null, null, (err as Error).message.slice(0, 300), now(), row.id, item.seq)
      }
      refreshCounts(row.id)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, worker))

  if (!isCancelled(row.id)) {
    refreshCounts(row.id)
    const counts = db().prepare('select total, done, skipped, failed from jobs where id = ?').get(row.id) as { total: number; done: number; skipped: number; failed: number }
    const status: JobStatus = counts.failed === 0 ? 'done' : counts.done + counts.skipped > 0 ? 'partial' : 'failed'
    db().prepare('update jobs set status = ?, updated_at = ? where id = ?').run(status, now(), row.id)
  }
  await finish(row.id)
}

async function finish(jobId: string): Promise<void> {
  const { job, items } = getJob(jobId, true)
  const failed = (items ?? []).filter((i) => i.status === 'failed')
  const lines = [
    `【${job.title}】${statusLabel(job.status)}`,
    `共 ${job.total} 首：新下载 ${job.done}，已有 ${job.skipped}，失败 ${job.failed}`,
    qualitySummary(items ?? []),
    ...failed.slice(0, 5).map((i) => `✗ ${i.title} - ${i.artists.join('/')}：${i.error ?? ''}`),
    failed.length > 5 ? `…另有 ${failed.length - 5} 首失败，详见 astra music job ${job.id}` : '',
  ].filter(Boolean)
  await notify(lines.join('\n'))
}

/** "音质：24bit 3 / flac 2 / 128k 5"。热歌榜实测大半只有 128k，用户应该知道。 */
export function qualitySummary(items: JobItemView[]): string {
  const counts = new Map<string, number>()
  for (const i of items) if ((i.status === 'done' || i.status === 'skipped') && i.quality) counts.set(i.quality, (counts.get(i.quality) ?? 0) + 1)
  if (counts.size === 0) return ''
  const order = ['24bit', 'flac', '320k', '128k']
  return '音质：' + [...counts].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([q, n]) => `${q} ${n}`).join(' / ')
}

export function statusLabel(status: JobStatus): string {
  return { queued: '排队中', running: '下载中', done: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }[status]
}

export function cancelJob(id: string): JobView {
  const row = jobRow(id)
  if (['done', 'partial', 'failed', 'cancelled'].includes(row.status)) return toView(row)
  db().prepare("update jobs set status = 'cancelled', updated_at = ? where id = ?").run(now(), row.id)
  // 正在下的那一首会被打断；临时文件由 download 的 finally 清掉（进程被杀时下次 resume 会覆盖）
  if (alive(row.pid) && row.pid !== process.pid) {
    try {
      process.kill(row.pid!)
    } catch {
      // 已经退出
    }
  }
  db().prepare("update job_items set status = 'queued' where job_id = ? and status = 'running'").run(row.id)
  return getJob(row.id, false).job
}

export function resumeJob(id: string): JobView {
  const row = jobRow(id)
  const view = toView(row)
  if (view.status === 'running' || view.status === 'queued') {
    throw new AstraError('JOB_RUNNING', `任务 ${row.id} 还在跑`, { exitCode: 2, hint: '用 `astra music job <id>` 看进度' })
  }
  const retryable = (db().prepare("select count(*) n from job_items where job_id = ? and status in ('queued', 'failed', 'running')").get(row.id) as { n: number }).n
  if (retryable === 0) throw new AstraError('NOTHING_TO_RESUME', `任务 ${row.id} 没有需要重试的歌`, { exitCode: 2 })
  db().prepare("update jobs set status = 'queued', error = null, updated_at = ? where id = ?").run(now(), row.id)
  spawnWorker(row.id)
  return getJob(row.id, false).job
}

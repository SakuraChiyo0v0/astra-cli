/**
 * 漫画域的后台任务：一个任务 = 一部作品的一批话 / 卷，一项 = 一话（或一卷）。
 *
 * 每项把这一话的图下进 `<作品>/<分组>/<章节>/001.ext`，已存在且是完整图片的页跳过 ——
 * 中断、限流后 `astra comic job resume <id>` 只补缺的页。可选每话打一个 CBZ。
 *
 * 额度 / 限流（`QuotaError`）：**任务里原地等**到源给的恢复时间，再接着下同一话（已下的页跳过）。
 * 以前是记失败、任务以「部分完成」收尾，要人 / 脚本到点 `job resume` —— 拷贝漫画每下一卷就 210 一次，
 * 一本 6 卷发了 6 条通知。现在整本只在结束时通知一次；等待中的状态写在 job meta 的 `waiting` 里，
 * `astra comic job <id>` 能看到在等谁、等到几点。等待期间可以 `job cancel`。
 * 同一话连续被限流 `MAX_QUOTA_WAITS` 次（等了也没下到一页）才记失败，防止源一直不放行时任务永远挂着。
 * 并发固定 1：两个源都不欢迎并发，Komiic 的额度也是按张算的。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { patchJob, registerJobHandler, type ItemOutcome, type JobItemView, type JobView } from '../core/jobs.ts'
import { progress } from '../core/output.ts'
import { mirrorFile } from '../core/db/mirror.ts'
import { buildZip } from '../novel/zip.ts'
import { imageExt } from './fetch.ts'
import { chapterDir, comicDir } from './paths.ts'
import { sourceByName } from './registry.ts'
import { QuotaError, type ComicInfo } from './sources/types.ts'

export const COMIC_DOMAIN = 'comic'

export interface ComicJobMeta {
  source: string
  comicId: string
  title: string
  group: string
  cbz: boolean
}

/** 每项自带的信息（处理器里拿不到 job meta）。 */
export interface ChapterItemMeta {
  source: string
  comicId: string
  title: string
  group: string
  /** 落盘目录名（第01卷 / 第01话）。 */
  dir: string
  name: string
  pages: number | null
  cbz: boolean
}

const PAGE_RE = /^(\d{3,4})\.(jpg|png|webp|gif)$/

/** 目录里已经完整的页号（文件名是页号、魔数是图片、不是空壳）。 */
export function completePages(dir: string): Set<number> {
  const done = new Set<number>()
  if (!existsSync(dir)) return done
  for (const f of readdirSync(dir)) {
    const m = PAGE_RE.exec(f)
    if (!m) continue
    const file = path.join(dir, f)
    try {
      if (statSync(file).size < 1024) continue
      const head = readFileSync(file).subarray(0, 16)
      if (imageExt(head)) done.add(Number(m[1]))
    } catch {
      // 读不了就当没有
    }
  }
  return done
}

function pageFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => PAGE_RE.test(f)).sort() : []
}

export function writeCbz(dir: string): { path: string; size: number } {
  const files = pageFiles(dir)
  const zip = buildZip(files.map((f) => ({ name: f, data: readFileSync(path.join(dir, f)), store: true })))
  const target = `${dir}.cbz`
  writeFileSync(`${target}.tmp`, zip)
  renameSync(`${target}.tmp`, target)
  return { path: target, size: zip.length }
}

async function comicFor(meta: { source: string; comicId: string }, shared: Map<string, unknown>): Promise<ComicInfo> {
  const key = `comic:${meta.source}:${meta.comicId}`
  const hit = shared.get(key) as Promise<ComicInfo> | undefined
  if (hit) return await hit
  const pending = sourceByName(meta.source).comic(meta.comicId)
  shared.set(key, pending)
  return await pending
}

function clock(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

function quotaNote(err: QuotaError): string {
  const at = new Date(Date.now() + err.resetInSeconds * 1000)
  return `${err.message}；约 ${Math.ceil(err.resetInSeconds / 60)} 分钟后（${clock(at)}）可以 resume`
}

/** 同一话连续被限流、且期间一页都没下到，超过这个次数才放弃。 */
export const MAX_QUOTA_WAITS = 6
/** 源给的恢复时间之外多等一会儿，免得踩着点又被拒一次。 */
const WAIT_MARGIN_SECONDS = 60
/** 睡眠切片：每片醒来看一眼是不是被取消了。 */
const WAIT_SLICE_MS = 30_000

export interface QuotaWaitHooks {
  /** 被取消了就不再等。 */
  cancelled: () => Promise<boolean>
  /** 开始等 / 等完（`null`）时调，用来把状态写进 job meta。 */
  onWait: (waiting: { source: string; reason: string; until: string; attempt: number } | null) => Promise<void>
  /** 测试注入；默认真的睡。 */
  sleep?: (ms: number) => Promise<void>
  /** 测试注入；默认 Date.now。 */
  now?: () => number
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 跑 `attempt`；它抛 `QuotaError` 就睡到恢复时间再跑，直到成功、被取消、或连续限流太多次。
 * `progressed()` 返回 true 表示上一轮其实下到了东西（只是中途又被限流），这时计数清零。
 */
export async function withQuotaWait<T>(
  attempt: () => Promise<T>,
  progressed: () => boolean,
  hooks: QuotaWaitHooks,
): Promise<T> {
  const sleep = hooks.sleep ?? realSleep
  const now = hooks.now ?? Date.now
  let strikes = 0
  for (;;) {
    try {
      const result = await attempt()
      if (strikes > 0) await hooks.onWait(null)
      return result
    } catch (err) {
      if (!(err instanceof QuotaError)) {
        if (strikes > 0) await hooks.onWait(null)
        throw err
      }
      strikes = progressed() ? 1 : strikes + 1
      if (strikes > MAX_QUOTA_WAITS) {
        await hooks.onWait(null)
        throw new Error(`${quotaNote(err)}（连续 ${MAX_QUOTA_WAITS} 次等完仍被拒，先停下）`)
      }
      const until = now() + (err.resetInSeconds + WAIT_MARGIN_SECONDS) * 1000
      await hooks.onWait({ source: err.source, reason: err.message, until: new Date(until).toISOString(), attempt: strikes })
      while (now() < until) {
        if (await hooks.cancelled()) {
          await hooks.onWait(null)
          throw new Error(`等待限流解除时被取消（${err.message}）`)
        }
        await sleep(Math.min(WAIT_SLICE_MS, Math.max(0, until - now())))
      }
    }
  }
}

async function downloadChapter(meta: ChapterItemMeta, itemId: string, shared: Map<string, unknown>): Promise<ItemOutcome> {
  const source = sourceByName(meta.source)
  const dir = chapterDir(meta.title, meta.group, meta.dir)
  try {
    const comic = await comicFor(meta, shared)
    const pages = await source.pages(comic, { id: itemId, name: meta.name, pages: meta.pages })
    const have = completePages(dir)
    const todo = pages.map((p, i) => [i + 1, p] as const).filter(([n]) => !have.has(n))
    mkdirSync(dir, { recursive: true })
    const width = pages.length >= 1000 ? 4 : 3
    for (const [n, page] of todo) {
      const body = await source.image(page)
      const ext = imageExt(body)
      if (!ext) throw new Error(`第 ${n} 页不是图片（${body.length} 字节）`)
      const file = path.join(dir, `${String(n).padStart(width, '0')}.${ext}`)
      writeFileSync(`${file}.part`, body)
      renameSync(`${file}.part`, file)
    }
    const got = completePages(dir).size
    if (got < pages.length) throw new Error(`只有 ${got}/${pages.length} 页`)
    let cbz: { path: string; size: number } | null = null
    if (meta.cbz) cbz = writeCbz(dir)
    void mirrorFile({
      platform: `comic-${meta.source}`,
      nativeId: `${meta.comicId}/${itemId}`,
      kind: 'comic',
      title: `${meta.title} ${meta.dir}`,
      album: meta.title,
      meta: { source: meta.source, group: meta.group, pages: pages.length },
      path: cbz?.path ?? dir,
    })
    return {
      status: todo.length === 0 ? 'skipped' : 'downloaded',
      path: cbz?.path ?? dir,
      note: `${pages.length} 页${todo.length && todo.length < pages.length ? `（补 ${todo.length}）` : ''}`,
      meta: { ...meta, pagesDone: pages.length },
    }
  } catch (err) {
    // 限流原样往上抛，由 withQuotaWait 决定等还是放弃；页数记下来给它判断「这一轮有没有进展」
    if (err instanceof QuotaError) shared.set(`pages:${itemId}`, completePages(dir).size)
    throw err
  }
}

function readMeta(job: JobView): ComicJobMeta | null {
  const m = job.meta as Partial<ComicJobMeta> | null
  return m && typeof m.source === 'string' && typeof m.comicId === 'string' && typeof m.title === 'string' ? (m as ComicJobMeta) : null
}

registerJobHandler(COMIC_DOMAIN, {
  concurrency: () => 1,
  summary: (items) => {
    const failed = items.filter((i) => i.status === 'failed')
    const quota = failed.find((i) => /额度|限流|code 210/.test(i.error ?? ''))
    return quota ? [`⏳ ${quota.error}`] : []
  },

  async handle(item, ctx) {
    const meta = item.meta as Partial<ChapterItemMeta>
    if (typeof meta.source !== 'string' || typeof meta.comicId !== 'string' || typeof meta.dir !== 'string') throw new Error('任务项缺少源 / 作品 id')
    const chapter = meta as ChapterItemMeta
    const dir = chapterDir(chapter.title, chapter.group, chapter.dir)
    let before = completePages(dir).size
    return await withQuotaWait(
      () => downloadChapter(chapter, item.id, ctx.shared),
      () => {
        const after = (ctx.shared.get(`pages:${item.id}`) as number | undefined) ?? completePages(dir).size
        const moved = after > before
        before = after
        return moved
      },
      {
        cancelled: ctx.cancelled,
        onWait: async (waiting) => {
          await patchJob(ctx.jobId, { meta: { waiting: waiting ? { ...waiting, item: chapter.dir } : null } })
          if (waiting) progress('comic.wait', { job: ctx.jobId, item: chapter.dir, source: waiting.source, until: waiting.until, attempt: waiting.attempt })
        },
      },
    )
  },

  async finalize(job: JobView, items: JobItemView[]) {
    const meta = readMeta(job)
    if (!meta) return []
    const ok = items.filter((i) => i.status === 'downloaded' || i.status === 'skipped')
    await patchJob(job.id, { meta: { waiting: null, output: { dir: comicDir(meta.title), chapters: ok.length, of: items.length } } })
    return [`📚 ${meta.title} / ${meta.group}：${ok.length}/${items.length}`, `→ ${comicDir(meta.title)}`]
  },
})

/**
 * 漫画域的后台任务：一个任务 = 一部作品的一批话 / 卷，一项 = 一话（或一卷）。
 *
 * 每项把这一话的图下进 `<作品>/<分组>/<章节>/001.ext`，已存在且是完整图片的页跳过 ——
 * 中断、限流后 `astra manga job resume <id>` 只补缺的页。可选每话打一个 CBZ。
 *
 * 额度 / 限流（`QuotaError`）：这一项记失败，并把「还要等多久」写进错误里；
 * 同一任务里后面的项看到 `shared` 里的限流标记就直接跳过请求，免得白打一轮。
 * 并发固定 1：两个源都不欢迎并发，Komiic 的额度也是按张算的。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { patchJob, registerJobHandler, type ItemOutcome, type JobItemView, type JobView } from '../core/jobs.ts'
import { mirrorFile } from '../core/db/mirror.ts'
import { buildZip } from '../novel/zip.ts'
import { imageExt } from './fetch.ts'
import { chapterDir, comicDir } from './paths.ts'
import { sourceByName } from './registry.ts'
import { QuotaError, type ComicInfo } from './sources/types.ts'

export const MANGA_DOMAIN = 'manga'

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

function quotaNote(err: QuotaError): string {
  const at = new Date(Date.now() + err.resetInSeconds * 1000)
  const hh = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return `${err.message}；约 ${Math.ceil(err.resetInSeconds / 60)} 分钟后（${hh}）可以 resume`
}

async function downloadChapter(meta: ChapterItemMeta, itemId: string, shared: Map<string, unknown>): Promise<ItemOutcome> {
  const blocked = shared.get(`blocked:${meta.source}`) as QuotaError | undefined
  if (blocked) throw new Error(quotaNote(blocked))
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
      platform: `manga-${meta.source}`,
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
    if (err instanceof QuotaError) {
      shared.set(`blocked:${meta.source}`, err)
      throw new Error(`${quotaNote(err)}（已下 ${completePages(dir).size} 页）`)
    }
    throw err
  }
}

function readMeta(job: JobView): ComicJobMeta | null {
  const m = job.meta as Partial<ComicJobMeta> | null
  return m && typeof m.source === 'string' && typeof m.comicId === 'string' && typeof m.title === 'string' ? (m as ComicJobMeta) : null
}

registerJobHandler(MANGA_DOMAIN, {
  concurrency: () => 1,
  summary: (items) => {
    const failed = items.filter((i) => i.status === 'failed')
    const quota = failed.find((i) => /额度|限流|code 210/.test(i.error ?? ''))
    return quota ? [`⏳ ${quota.error}`] : []
  },

  async handle(item, ctx) {
    const meta = item.meta as Partial<ChapterItemMeta>
    if (typeof meta.source !== 'string' || typeof meta.comicId !== 'string' || typeof meta.dir !== 'string') throw new Error('任务项缺少源 / 作品 id')
    return await downloadChapter(meta as ChapterItemMeta, item.id, ctx.shared)
  },

  async finalize(job: JobView, items: JobItemView[]) {
    const meta = readMeta(job)
    if (!meta) return []
    const ok = items.filter((i) => i.status === 'downloaded' || i.status === 'skipped')
    patchJob(job.id, { meta: { output: { dir: comicDir(meta.title), chapters: ok.length, of: items.length } } })
    return [`📚 ${meta.title} / ${meta.group}：${ok.length}/${items.length}`, `→ ${comicDir(meta.title)}`]
  },
})

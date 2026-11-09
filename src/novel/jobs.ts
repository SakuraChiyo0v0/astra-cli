/**
 * 小说域的后台任务。两种 kind：
 *
 * - `book`：一项 = 一章（抓正文 + 插图进缓存），全部完成后 `finalize` 打成一本 EPUB。
 *   书的信息（书源、书 id、成书计划）放在 job meta 里，worker 进程重新取一次目录即可。
 * - `index`：一项 = 努努书坊的一个分类 / 作家页，`finalize` 合并成书名索引。
 *
 * 生命周期（并发、取消、resume、通知）都交给 core/jobs.ts。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { getConfig } from '../core/config.ts'
import { patchJob, registerJobHandler, type ItemOutcome, type JobItemView, type JobView } from '../core/jobs.ts'
import { homePath } from '../core/paths.ts'
import { fetchChapter, packBook } from './build.ts'
import { sourceById } from './registry.ts'
import type { Plan } from './plan.ts'
import { mergeIndex, saveIndex, scanIndexPage, type IndexEntry } from './sources/kanunu.ts'
import type { BookInfo } from './sources/types.ts'
import { recordSubscriptionChapters } from './subscribe.ts'

export const NOVEL_DOMAIN = 'novel'

export interface BookJobMeta {
  source: string
  bookId: string
  plan: Plan
  simplified: boolean
  images: boolean
  subscriptionId?: string
}

/** 每章任务项自带的信息（job meta 在处理器里拿不到）。 */
export interface ChapterItemMeta {
  source: string
  bookId: string
  title: string
  images: boolean
}

async function bookFor(meta: { source: string; bookId: string }, shared: Map<string, unknown>): Promise<BookInfo> {
  const key = `book:${meta.source}:${meta.bookId}`
  const hit = shared.get(key) as Promise<BookInfo> | undefined
  if (hit) return await hit
  const pending = sourceById(meta.source).book(meta.bookId)
  shared.set(key, pending)
  return await pending
}

function readBookMeta(job: JobView): BookJobMeta | null {
  const m = job.meta as Partial<BookJobMeta> | null
  return m && typeof m.source === 'string' && typeof m.bookId === 'string' && m.plan ? (m as BookJobMeta) : null
}

/** 索引任务每页的结果先落临时文件：worker 进程重启（resume）后内存里的东西就没了。 */
function indexPartFile(jobId: string, seq: number): string {
  return homePath('novel', 'index-parts', jobId, `${seq}.json`)
}

async function finalizeBook(job: JobView, items: JobItemView[]): Promise<string[]> {
  const meta = readBookMeta(job)
  if (!meta) return []
  if (items.some((i) => i.status !== 'downloaded' && i.status !== 'skipped')) {
    return ['有章节没取到，这次没出书；`astra novel job resume ' + job.id + '` 补抓后会自动出书']
  }
  const source = sourceById(meta.source)
  const book = await source.book(meta.bookId)
  const result = await packBook(meta.source, book, meta.plan, { simplified: meta.simplified, language: source.language })
  patchJob(job.id, { meta: { output: { path: result.path, size: result.size, chapters: result.chapters, chars: result.chars, images: result.images, mirrored: result.mirrored, warnings: result.warnings } } })
  return [`📖 ${result.title}：${result.chapters} 章 / ${result.chars} 字${result.images ? ` / ${result.images} 图` : ''}`, `→ ${result.path}`, ...result.warnings]
}

async function finalizeIndex(job: JobView, items: JobItemView[]): Promise<string[]> {
  const lists: IndexEntry[][] = []
  for (const item of items) {
    const file = indexPartFile(job.id, item.seq)
    if (existsSync(file)) lists.push(JSON.parse(readFileSync(file, 'utf8')) as IndexEntry[])
  }
  const books = mergeIndex(lists)
  const failed = items.filter((i) => i.status === 'failed').length
  // 失败太多时不覆盖旧索引：缺了一大块的新索引比旧索引更糟
  if (failed > items.length / 5) return [`失败 ${failed}/${items.length} 页，没有覆盖旧索引`]
  saveIndex({ builtAt: new Date().toISOString(), pages: items.length, books })
  patchJob(job.id, { meta: { output: { books: books.length, pages: items.length, failedPages: failed } } })
  return [`索引 ${books.length} 本（${items.length} 页${failed ? `，${failed} 页失败` : ''}）`]
}

registerJobHandler(NOVEL_DOMAIN, {
  concurrency: () => Math.max(1, Math.min(6, Number(getConfig('novel.concurrency') || '3') || 3)),
  summary: () => [],

  async handle(item, ctx): Promise<ItemOutcome> {
    if (item.meta.kind === 'index-page') {
      const page = { path: String(item.meta.path), author: typeof item.meta.author === 'string' ? item.meta.author : null }
      const entries = await scanIndexPage(page)
      const file = indexPartFile(ctx.jobId, item.seq)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(entries))
      return { status: 'downloaded', note: `${entries.length} 本` }
    }
    const meta = item.meta as Partial<ChapterItemMeta>
    if (typeof meta.source !== 'string' || typeof meta.bookId !== 'string') throw new Error('任务项缺少书源 / 书 id')
    const book = await bookFor({ source: meta.source, bookId: meta.bookId }, ctx.shared)
    const outcome = await fetchChapter(sourceById(meta.source), meta.source, book, { id: item.id, title: meta.title ?? item.id }, { images: meta.images !== false })
    return {
      status: outcome.cached ? 'skipped' : 'downloaded',
      note: outcome.missingImages > 0 ? `${outcome.missingImages} 张插图没取到` : null,
      meta: { ...meta, chars: outcome.chars, imageCount: outcome.images },
    }
  },

  async finalize(job, items) {
    return job.kind === 'index' ? await finalizeIndex(job, items) : await finalizeBook(job, items)
  },

  afterFinish(job, items) {
    const meta = readBookMeta(job)
    if (meta?.subscriptionId) recordSubscriptionChapters(meta.subscriptionId, job, items)
  },
})

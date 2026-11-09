/**
 * 抓章与成书。
 *
 * - `fetchChapter`：取一章正文 + 插图，写进章节缓存（`<ASTRA_HOME>/novel/cache/…`）。
 *   已经缓存过的章直接跳过 —— 中断后 resume、订阅追更都只补缺的那几章。
 * - `packBook`：从缓存读全部章节，打 EPUB、落盘、登记资产库。**有一章缺就不出书**，
 *   半本书比没有书更糟（读到一半发现缺章）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { mirrorFile } from '../core/db/mirror.ts'
import { AstraError } from '../core/errors.ts'
import { progress } from '../core/output.ts'
import { buildEpub, type EpubChapter, type EpubImage } from './epub.ts'
import { fetchBytes } from './fetch.ts'
import { toEpubImage } from './image.ts'
import { chapterCacheDir, chapterCacheFile, epubPath } from './paths.ts'
import type { Plan } from './plan.ts'
import type { BookInfo, NovelSource } from './sources/types.ts'
import { toSimplified } from './text.ts'

interface CachedChapter {
  title: string
  paragraphs: string[]
  /** 缓存目录里的图片文件名，按顺序。 */
  images: { file: string; mediaType: string }[]
  /** 没取到的插图（不让整章失败）。 */
  missingImages: number
}

/**
 * 章节正文其实是站点的下架 / 版权提示。
 *
 * 实测 8novel 第十四卷每一章都只有一段「因版權問題，文庫不再提供該小說的閱讀！」，
 * 状态码 200、地址也对 —— 不认出来就会打出一本 4 章 76 个字的「书」。
 * 只看很短的正文（≤3 段、总字数 < 120），长章节里提到「版权」不会误判。
 */
const TAKEDOWN_RE = /版[權权]|下架|不再提供|暂停(?:阅读|提供)|暫停(?:閱讀|提供)|无法(?:阅读|查看)|無法(?:閱讀|查看)/

export function takedownNotice(paragraphs: string[]): string | null {
  const text = paragraphs.join('')
  if (paragraphs.length === 0 || paragraphs.length > 3 || text.length >= 120) return null
  return TAKEDOWN_RE.test(text) ? text.slice(0, 60) : null
}

export interface ChapterOutcome {
  cached: boolean
  chars: number
  images: number
  missingImages: number
}

export async function fetchChapter(
  source: NovelSource,
  sourceKey: string,
  book: BookInfo,
  chapter: { id: string; title: string },
  options: { images: boolean; signal?: AbortSignal },
): Promise<ChapterOutcome> {
  const file = chapterCacheFile(sourceKey, book.id, chapter.id)
  if (existsSync(file)) {
    const hit = JSON.parse(readFileSync(file, 'utf8')) as CachedChapter
    return { cached: true, chars: hit.paragraphs.join('').length, images: hit.images.length, missingImages: hit.missingImages }
  }
  const content = await source.chapter(book, chapter, options.signal)
  const notice = takedownNotice(content.paragraphs)
  if (notice) {
    // 不进缓存：进了缓存就会被当成「这章已经下好」，以后站上恢复了也不会再取
    throw new AstraError('NOVEL_TAKEN_DOWN', `「${chapter.title}」站上只剩一句下架提示：${notice}`, {
      exitCode: 4,
      hint: '这一卷在这个书源下架了，换个书源试试（`astra novel search <书名>`）',
    })
  }
  const dir = chapterCacheDir(sourceKey, book.id)
  mkdirSync(dir, { recursive: true })
  const images: CachedChapter['images'] = []
  let missing = 0
  if (options.images) {
    for (const [i, url] of content.images.entries()) {
      try {
        const { status, body } = await fetchBytes(url, { referer: book.url, ...(options.signal ? { signal: options.signal } : {}) })
        const img = status < 400 ? await toEpubImage(body, options.signal) : null
        if (!img) {
          missing += 1
          continue
        }
        const name = `${path.basename(file, '.json')}_${i + 1}.${img.mediaType === 'image/png' ? 'png' : 'jpg'}`
        writeFileSync(path.join(dir, name), img.data)
        images.push({ file: name, mediaType: img.mediaType })
      } catch {
        missing += 1
      }
    }
  }
  if (content.paragraphs.length === 0 && images.length === 0 && content.images.length === 0) {
    throw new AstraError('NOVEL_EMPTY_CHAPTER', `「${chapter.title}」没有正文`, { exitCode: 5, retryable: true })
  }
  const cached: CachedChapter = { title: chapter.title, paragraphs: content.paragraphs, images, missingImages: missing }
  writeFileSync(`${file}.tmp`, JSON.stringify(cached))
  renameSync(`${file}.tmp`, file)
  return { cached: false, chars: content.paragraphs.join('').length, images: images.length, missingImages: missing }
}

/** 正文开头和章节名重复的段落去掉（只看前两段，避免误删正文）。 */
export function dropRepeatedTitle(paragraphs: string[], title: string): string[] {
  const squash = (s: string): string => s.replace(/[\s　]+/g, '')
  const t = squash(title)
  let start = 0
  while (start < Math.min(2, paragraphs.length)) {
    const p = squash(paragraphs[start]!)
    if (p && p.length <= t.length && t.endsWith(p)) start += 1
    else break
  }
  return paragraphs.slice(start)
}

export interface PackResult {
  path: string
  title: string
  author: string | null
  chapters: number
  chars: number
  images: number
  size: number
  mirrored: boolean
  warnings: string[]
}

export async function packBook(
  sourceKey: string,
  book: BookInfo,
  plan: Plan,
  options: { simplified: boolean; language: string; signal?: AbortSignal },
): Promise<PackResult> {
  const dir = chapterCacheDir(sourceKey, book.id)
  const missing = plan.chapters.filter((c) => !existsSync(chapterCacheFile(sourceKey, book.id, c.id)))
  if (missing.length > 0) {
    throw new AstraError('NOVEL_INCOMPLETE', `还有 ${missing.length} 章没取到，不出半本书`, {
      exitCode: 5,
      retryable: true,
      hint: '用 `astra novel job resume <id>` 补抓',
      details: { missing: missing.slice(0, 10).map((c) => c.title) },
    })
  }
  const conv = (s: string): string => (options.simplified ? toSimplified(s) : s)
  const warnings: string[] = []
  const chapters: EpubChapter[] = []
  let chars = 0
  let images = 0
  let lostImages = 0
  for (const c of plan.chapters) {
    const cached = JSON.parse(readFileSync(chapterCacheFile(sourceKey, book.id, c.id), 'utf8')) as CachedChapter
    const imgs: EpubImage[] = cached.images.map((i) => ({ data: readFileSync(path.join(dir, i.file)), mediaType: i.mediaType }))
    const paragraphs = dropRepeatedTitle(cached.paragraphs, c.title).map(conv)
    chars += paragraphs.join('').length
    images += imgs.length
    lostImages += cached.missingImages
    if (paragraphs.length === 0 && imgs.length === 0) continue
    chapters.push({ title: conv(c.title), paragraphs, images: imgs })
  }
  if (lostImages > 0) warnings.push(`${lostImages} 张插图没取到（站上缺图或图床不可达），正文完整`)

  let cover: EpubImage | null = null
  if (book.cover) {
    try {
      const { status, body } = await fetchBytes(book.cover, { referer: book.url, ...(options.signal ? { signal: options.signal } : {}) })
      cover = status < 400 ? await toEpubImage(body, options.signal) : null
    } catch {
      cover = null
    }
    if (!cover) warnings.push('封面没取到')
  }

  const title = conv(plan.title)
  const author = book.author ? conv(book.author) : null
  const identifier = `${sourceKey}:${book.id}${plan.volumeKey ? `:${plan.volumeKey}` : ''}`
  const epub = buildEpub({
    identifier,
    title,
    author,
    language: options.simplified ? 'zh-Hans' : options.language,
    cover,
    chapters,
    source: book.url,
  })
  const target = epubPath({ title, author, source: sourceKey })
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(`${target}.tmp`, epub)
  renameSync(`${target}.tmp`, target)
  progress('novel.packed', { path: target, chapters: chapters.length, bytes: epub.length })

  const mirrored = await mirrorFile({
    platform: `novel-${sourceKey}`,
    nativeId: identifier.slice(sourceKey.length + 1),
    kind: 'ebook',
    title,
    artists: author,
    meta: { source: sourceKey, url: book.url, chapters: chapters.length, simplified: options.simplified },
    path: target,
  })
  return { path: target, title, author, chapters: chapters.length, chars, images, size: statSync(target).size, mirrored, warnings }
}

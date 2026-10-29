/**
 * 下载一本 / 一章：取图 → 解混淆 → 落盘。
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { AstraError } from '../core/errors.ts'
import { progress } from '../core/output.ts'
import { comicClient, type AlbumDetail, type ChapterDetail } from './client.ts'
import { chapterDir, pageFile } from './paths.ts'
import { descrambleToFile } from './scramble.ts'

export interface ChapterDownloadResult {
  chapterId: string
  sort: number
  title: string
  pages: number
  dir: string
  status: 'downloaded' | 'already_have'
}

export interface AlbumDownloadResult {
  status: 'downloaded' | 'already_have'
  album: { id: string; title: string; authors: string[]; tags: string[]; episodes: number }
  chapters: ChapterDownloadResult[]
  bytesHint: null
}

async function countExistingPagesAsync(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0
  try {
    const names = await readdir(dir)
    return names.filter((name) => /\.(jpe?g|png|webp|gif)$/i.test(name)).length
  } catch {
    return 0
  }
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next
      next += 1
      if (i >= items.length) return
      results[i] = await fn(items[i]!, i)
    }
  })
  await Promise.all(workers)
  return results
}

export async function downloadChapter(
  album: AlbumDetail,
  chapter: ChapterDetail,
  options: { force?: boolean; concurrency?: number; signal?: AbortSignal } = {},
): Promise<ChapterDownloadResult> {
  const dir = chapterDir(album, chapter)
  const existing = await countExistingPagesAsync(dir)
  if (!options.force && existing >= chapter.images.length) {
    return {
      chapterId: chapter.id,
      sort: chapter.sort,
      title: chapter.title,
      pages: existing,
      dir,
      status: 'already_have',
    }
  }

  await mkdir(dir, { recursive: true })
  const client = comicClient()
  const scrambleId = Number(chapter.scrambleId) || 0
  const concurrency = Math.max(1, Math.min(6, options.concurrency ?? 3))

  await mapPool(chapter.images, concurrency, async (imgName, index) => {
    options.signal?.throwIfAborted()
    const target = pageFile(album, chapter, index, imgName)
    if (!options.force && existsSync(target)) return
    progress('comic.page', { album: album.id, chapter: chapter.id, page: index + 1, total: chapter.images.length })
    const bytes = await client.downloadImageBytes(chapter, imgName, options.signal)
    await descrambleToFile({
      scrambled: bytes,
      scrambleId,
      aid: Number(chapter.id),
      imgName,
      outputPath: target,
      signal: options.signal,
    })
  })

  // 写一个小 meta，方便以后对账（纯文本，不进 stdout）
  await writeFile(
    path.join(dir, '.astra-comic.json'),
    JSON.stringify({ albumId: album.id, chapterId: chapter.id, title: chapter.title, pages: chapter.images.length, scrambleId: chapter.scrambleId }, null, 2) + '\n',
    'utf8',
  )

  return {
    chapterId: chapter.id,
    sort: chapter.sort,
    title: chapter.title,
    pages: chapter.images.length,
    dir,
    status: 'downloaded',
  }
}

export async function downloadAlbum(
  albumId: string,
  options: { force?: boolean; chapter?: number | 'all'; concurrency?: number; signal?: AbortSignal } = {},
): Promise<AlbumDownloadResult> {
  const client = comicClient()
  const album = await client.getAlbum(albumId, options.signal)
  const scrambleId = await client.getScrambleId(album.episodes[0]!.id, options.signal)

  let episodes = album.episodes
  if (typeof options.chapter === 'number') {
    const hit = episodes.find((e) => e.sort === options.chapter)
    if (!hit) throw new AstraError('NOT_FOUND', `没有第 ${options.chapter} 话`, { exitCode: 4, hint: '`astra comic info` 看章节列表' })
    episodes = [hit]
  }

  const chapters: ChapterDownloadResult[] = []
  for (const ep of episodes) {
    options.signal?.throwIfAborted()
    progress('comic.chapter', { album: album.id, chapter: ep.id, sort: ep.sort, title: ep.title })
    const detail = await client.getChapter(ep.id, scrambleId, options.signal)
    chapters.push(await downloadChapter(album, detail, options))
  }

  const allHave = chapters.every((c) => c.status === 'already_have')
  return {
    status: allHave ? 'already_have' : 'downloaded',
    album: {
      id: album.id,
      title: album.title,
      authors: album.authors,
      tags: album.tags,
      episodes: album.episodes.length,
    },
    chapters,
    bytesHint: null,
  }
}

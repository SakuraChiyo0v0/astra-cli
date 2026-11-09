/**
 * 下载一本 / 一章：取图 → 解混淆 → 校验 → 落盘 → 登记资产库。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AstraError } from '../core/errors.ts'
import { progress } from '../core/output.ts'
import { mirrorFile } from '../core/db/mirror.ts'
import { jmClient, type AlbumDetail, type ChapterDetail } from './client.ts'
import { chapterDir, pageFile } from './paths.ts'
import { imageIntact, saveVerifiedPage } from './pages.ts'
import { descrambleToFile } from './scramble.ts'
import { jmNativeId, LEGACY_SIDECAR_NAME, SIDECAR_NAME } from './sidecar.ts'

export interface ChapterDownloadResult {
  chapterId: string
  sort: number
  title: string
  pages: number
  dir: string
  status: 'downloaded' | 'already_have'
  /** 登记进资产库的页数。小于 pages 说明漫画目录还不是 `lib root`。 */
  registered: number
}

export interface AlbumDownloadResult {
  status: 'downloaded' | 'already_have'
  album: { id: string; title: string; authors: string[]; tags: string[]; episodes: number }
  chapters: ChapterDownloadResult[]
  bytesHint: null
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

function sidecarBody(album: AlbumDetail, chapter: ChapterDetail): string {
  return JSON.stringify({
    albumId: album.id,
    albumTitle: album.title,
    authors: album.authors,
    chapterId: chapter.id,
    sort: chapter.sort,
    title: chapter.title,
    pages: chapter.images.length,
    scrambleId: chapter.scrambleId,
  }, null, 2) + '\n'
}

async function writeSidecar(dir: string, album: AlbumDetail, chapter: ChapterDetail): Promise<void> {
  await writeFile(path.join(dir, SIDECAR_NAME), sidecarBody(album, chapter), 'utf8')
  // 旧名留着会和新名内容分叉；新名写好后删掉
  await rm(path.join(dir, LEGACY_SIDECAR_NAME), { force: true })
}

/** 登记一页。资产库失败不影响下载（mirrorFile 自己吞错）。 */
async function mirrorJmPage(album: AlbumDetail, chapter: ChapterDetail, page: number, file: string): Promise<boolean> {
  return await mirrorFile({
    platform: 'jm',
    nativeId: jmNativeId(album.id, chapter.sort, page),
    kind: 'image',
    title: album.title,
    artists: album.authors.filter((a) => a.trim() !== '').join(', ') || null,
    album: chapter.title || null,
    meta: {
      albumId: album.id,
      chapterId: chapter.id,
      sort: chapter.sort,
      page,
      scrambleId: chapter.scrambleId,
    },
    path: file,
  })
}

export async function downloadChapter(
  album: AlbumDetail,
  chapter: ChapterDetail,
  options: { force?: boolean; concurrency?: number; signal?: AbortSignal } = {},
): Promise<ChapterDownloadResult> {
  const dir = chapterDir(album, chapter)
  const targets = chapter.images.map((imgName, index) => pageFile(album, chapter, index, imgName))

  if (!options.force && targets.length > 0) {
    const intact = await Promise.all(targets.map((file) => imageIntact(file)))
    if (intact.every(Boolean)) {
      await mkdir(dir, { recursive: true })
      await writeSidecar(dir, album, chapter)
      let registered = 0
      for (let i = 0; i < targets.length; i += 1) {
        if (await mirrorJmPage(album, chapter, i + 1, targets[i]!)) registered += 1
      }
      return {
        chapterId: chapter.id,
        sort: chapter.sort,
        title: chapter.title,
        pages: targets.length,
        dir,
        status: 'already_have',
        registered,
      }
    }
  }

  await mkdir(dir, { recursive: true })
  const client = jmClient()
  const scrambleId = Number(chapter.scrambleId) || 0
  const concurrency = Math.max(1, Math.min(6, options.concurrency ?? 3))
  let fetched = false
  let registered = 0

  await mapPool(chapter.images, concurrency, async (imgName, index) => {
    options.signal?.throwIfAborted()
    const target = targets[index]!
    if (!options.force && await imageIntact(target)) {
      if (await mirrorJmPage(album, chapter, index + 1, target)) registered += 1
      return
    }
    fetched = true
    progress('jm.page', { album: album.id, chapter: chapter.id, page: index + 1, total: chapter.images.length })
    await saveVerifiedPage(target, async () => {
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
    if (await mirrorJmPage(album, chapter, index + 1, target)) registered += 1
  })

  await writeSidecar(dir, album, chapter)

  return {
    chapterId: chapter.id,
    sort: chapter.sort,
    title: chapter.title,
    pages: chapter.images.length,
    dir,
    status: fetched ? 'downloaded' : 'already_have',
    registered,
  }
}

export async function downloadAlbum(
  albumOrId: string | AlbumDetail,
  options: { force?: boolean; chapter?: number | 'all'; concurrency?: number; signal?: AbortSignal } = {},
): Promise<AlbumDownloadResult> {
  const client = jmClient()
  // 调用方已经查过详情时直接用，少打一次上游
  const album = typeof albumOrId === 'string' ? await client.getAlbum(albumOrId, options.signal) : albumOrId
  const scrambleId = await client.getScrambleId(album.episodes[0]!.id, options.signal)

  let episodes = album.episodes
  if (typeof options.chapter === 'number') {
    const hit = episodes.find((e) => e.sort === options.chapter)
    if (!hit) throw new AstraError('NOT_FOUND', `没有第 ${options.chapter} 话`, { exitCode: 4, hint: '`astra jm info` 看章节列表' })
    episodes = [hit]
  }

  const chapters: ChapterDownloadResult[] = []
  for (const ep of episodes) {
    options.signal?.throwIfAborted()
    progress('jm.chapter', { album: album.id, chapter: ep.id, sort: ep.sort, title: ep.title })
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

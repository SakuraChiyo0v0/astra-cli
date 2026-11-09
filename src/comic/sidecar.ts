/**
 * 章节目录里的 `.astra-comic.json`。
 *
 * 下载时写下，`lib adopt` 读它给存量页一个稳定身份：
 * `comic:<本子id>_c<话数>_p<页码>`。页码来自文件名（`001.jpg` → 1），
 * 话数优先用 sidecar 里的 `sort`，老文件没有这个字段时用章节目录名（`03` → 3）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AdoptIdentity } from '../core/db/library.ts'

export interface ComicSidecar {
  albumId: string
  chapterId: string
  /** 章节标题。老 sidecar 只有这个，没有 albumTitle。 */
  title: string
  albumTitle: string | null
  authors: string[]
  pages: number
  scrambleId: string
  /** 话数。null 表示文件里没写，调用方再从目录名猜。 */
  sort: number | null
}

export function comicNativeId(albumId: string, sort: number, page: number): string {
  return `${albumId}_c${sort}_p${page}`
}

/** `001.jpg` / `12.webp` → 页码。认不出返回 null。 */
export function pageNumberFromFile(filename: string): number | null {
  const match = path.basename(filename).match(/^(\d+)\.[^.]+$/)
  if (!match) return null
  const n = Number(match[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

function asNonNegInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** 读图片所在目录的 sidecar。没有、坏了、缺 albumId 都返回 null。 */
export function readComicSidecar(imagePath: string): ComicSidecar | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(path.dirname(imagePath), '.astra-comic.json'), 'utf8')) as Record<string, unknown>
    if (typeof raw.albumId !== 'string' || raw.albumId.trim() === '') return null
    const authors = Array.isArray(raw.authors) ? raw.authors.filter((a): a is string => typeof a === 'string' && a.trim() !== '') : []
    return {
      albumId: raw.albumId,
      chapterId: typeof raw.chapterId === 'string' ? raw.chapterId : '',
      title: typeof raw.title === 'string' ? raw.title : '',
      albumTitle: typeof raw.albumTitle === 'string' && raw.albumTitle.trim() !== '' ? raw.albumTitle : null,
      authors,
      pages: typeof raw.pages === 'number' ? raw.pages : 0,
      scrambleId: typeof raw.scrambleId === 'string' ? raw.scrambleId : '',
      sort: asNonNegInt(raw.sort),
    }
  } catch {
    return null
  }
}

/**
 * 话数。sidecar 里的 `sort` 优先；没有时用图片的父目录名（默认模板是 `{chapter:02}`）。
 */
export function chapterNumber(meta: ComicSidecar, imagePath: string): number | null {
  if (meta.sort !== null) return meta.sort
  const dir = path.basename(path.dirname(imagePath))
  if (/^\d+$/.test(dir)) return Number(dir)
  return null
}

/**
 * `lib adopt` / `lib scan --adopt` 认漫画页：同目录有 `.astra-comic.json` 就用
 * `comic:<本子>_c<话数>_p<页码>`，和下载时 mirror 登记的是同一套 id。
 * 由 manifest 登记进 core（core 不 import 领域）。
 */
export function comicAdoptIdentity(file: { abs: string; base: string; ext: string; kind: string }): AdoptIdentity | null {
  if (file.kind !== 'image') return null
  const comic = readComicSidecar(file.abs)
  if (!comic) return null
  const page = pageNumberFromFile(file.base)
  if (!page) return null
  const sort = chapterNumber(comic, file.abs)
  if (sort === null) return null
  return {
    platform: 'comic',
    nativeId: comicNativeId(comic.albumId, sort, page),
    title: comic.albumTitle || comic.title || path.basename(file.base, file.ext),
    artists: comic.authors.length > 0 ? comic.authors.join(', ') : null,
    album: comic.albumTitle ? (comic.title || null) : null,
    meta: { albumId: comic.albumId, sort, page },
    via: 'comic-sidecar',
  }
}

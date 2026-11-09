/**
 * 章节目录里的 `.astra-jm.json`（旧名 `.astra-comic.json`，读的时候兼容）。
 *
 * 下载时写下，`lib adopt` 读它给存量页一个稳定身份：
 * `jm:<本子id>_c<话数>_p<页码>`。页码来自文件名（`001.jpg` → 1），
 * 话数优先用 sidecar 里的 `sort`，老文件没有这个字段时用章节目录名（`03` → 3）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AdoptIdentity } from '../core/db/library.ts'

export interface JmSidecar {
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

export function jmNativeId(albumId: string, sort: number, page: number): string {
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

export const SIDECAR_NAME = '.astra-jm.json'
/** 0.57.0 之前叫这个（那时 JM 域叫 comic）。读的时候兼容，写只写新名。 */
export const LEGACY_SIDECAR_NAME = '.astra-comic.json'

function readSidecarFile(dir: string): string {
  try {
    return readFileSync(path.join(dir, SIDECAR_NAME), 'utf8')
  } catch {
    return readFileSync(path.join(dir, LEGACY_SIDECAR_NAME), 'utf8')
  }
}

/** 读图片所在目录的 sidecar（新名优先，兼容旧名）。没有、坏了、缺 albumId 都返回 null。 */
export function readJmSidecar(imagePath: string): JmSidecar | null {
  try {
    const raw = JSON.parse(readSidecarFile(path.dirname(imagePath))) as Record<string, unknown>
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
export function chapterNumber(meta: JmSidecar, imagePath: string): number | null {
  if (meta.sort !== null) return meta.sort
  const dir = path.basename(path.dirname(imagePath))
  if (/^\d+$/.test(dir)) return Number(dir)
  return null
}

/**
 * `lib adopt` / `lib scan --adopt` 认漫画页：同目录有 `.astra-jm.json` 就用
 * `jm:<本子>_c<话数>_p<页码>`，和下载时 mirror 登记的是同一套 id。
 * 由 manifest 登记进 core（core 不 import 领域）。
 */
export function jmAdoptIdentity(file: { abs: string; base: string; ext: string; kind: string }): AdoptIdentity | null {
  if (file.kind !== 'image') return null
  const meta = readJmSidecar(file.abs)
  if (!meta) return null
  const page = pageNumberFromFile(file.base)
  if (!page) return null
  const sort = chapterNumber(meta, file.abs)
  if (sort === null) return null
  return {
    platform: 'jm',
    nativeId: jmNativeId(meta.albumId, sort, page),
    title: meta.albumTitle || meta.title || path.basename(file.base, file.ext),
    artists: meta.authors.length > 0 ? meta.authors.join(', ') : null,
    album: meta.albumTitle ? (meta.title || null) : null,
    meta: { albumId: meta.albumId, sort, page },
    via: 'jm-sidecar',
  }
}

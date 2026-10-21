/**
 * 曲库：本工具下载过的歌。用来去重（不重复下载）和回答"我有没有这首"。
 */
import { existsSync } from 'node:fs'
import { db } from '../core/db.ts'
import type { AudioFormat, Quality } from './audio.ts'
import { normalize } from './match.ts'

export interface LibraryTrack {
  platform: string
  id: string
  title: string
  artists: string[]
  album: string | null
  durationMs: number | null
  path: string
  format: AudioFormat
  quality: Quality
  bytes: number | null
  bps: number | null
  sourceId: string | null
  createdAt: string
  /** 记录还在，但文件被删了 / 挪走了。 */
  missing: boolean
}

interface Row {
  platform: string
  native_id: string
  title: string
  artists: string
  album: string | null
  duration_ms: number | null
  file_path: string
  format: string
  quality: string
  bytes: number | null
  bps: number | null
  source_id: string | null
  created_at: string
}

function fromRow(row: Row): LibraryTrack {
  return {
    platform: row.platform,
    id: row.native_id,
    title: row.title,
    artists: JSON.parse(row.artists) as string[],
    album: row.album,
    durationMs: row.duration_ms,
    path: row.file_path,
    format: row.format as AudioFormat,
    quality: row.quality as Quality,
    bytes: row.bytes,
    bps: row.bps,
    sourceId: row.source_id,
    createdAt: row.created_at,
    missing: !existsSync(row.file_path),
  }
}

export function findTrack(platform: string, id: string): LibraryTrack | null {
  const row = db().prepare('select * from tracks where platform = ? and native_id = ?').get(platform, id) as Row | undefined
  return row ? fromRow(row) : null
}

export function saveTrack(entry: Omit<LibraryTrack, 'missing' | 'createdAt'> & { audioSha256: string | null }): void {
  db()
    .prepare(
      `insert into tracks (platform, native_id, title, artists, album, duration_ms, file_path, format, quality, bytes, bps, audio_sha256, source_id, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (platform, native_id) do update set
         title = excluded.title, artists = excluded.artists, album = excluded.album, duration_ms = excluded.duration_ms,
         file_path = excluded.file_path, format = excluded.format, quality = excluded.quality, bytes = excluded.bytes,
         bps = excluded.bps, audio_sha256 = excluded.audio_sha256, source_id = excluded.source_id, created_at = excluded.created_at`,
    )
    .run(
      entry.platform, entry.id, entry.title, JSON.stringify(entry.artists), entry.album, entry.durationMs, entry.path,
      entry.format, entry.quality, entry.bytes, entry.bps, entry.audioSha256, entry.sourceId, new Date().toISOString(),
    )
}

export function forgetTrack(platform: string, id: string): boolean {
  return db().prepare('delete from tracks where platform = ? and native_id = ?').run(platform, id).changes > 0
}

/** 模糊找：每个关键词都要出现在 标题 / 歌手 / 专辑 之一里。 */
export function searchLibrary(keyword: string, limit: number): { total: number; tracks: LibraryTrack[] } {
  const words = keyword.split(/\s+/).map(normalize).filter(Boolean)
  const rows = db().prepare('select * from tracks order by created_at desc').all() as unknown as Row[]
  const matched = rows.filter((row) => {
    const haystack = normalize(`${row.title} ${(JSON.parse(row.artists) as string[]).join(' ')} ${row.album ?? ''}`)
    return words.every((w) => haystack.includes(w))
  })
  return { total: matched.length, tracks: matched.slice(0, limit).map(fromRow) }
}

export function libraryStats(): { tracks: number; bytes: number; byQuality: Record<string, number> } {
  const total = db().prepare('select count(*) n, coalesce(sum(bytes), 0) b from tracks').get() as { n: number; b: number }
  const groups = db().prepare('select quality, count(*) n from tracks group by quality').all() as { quality: string; n: number }[]
  return { tracks: total.n, bytes: total.b, byQuality: Object.fromEntries(groups.map((g) => [g.quality, g.n])) }
}

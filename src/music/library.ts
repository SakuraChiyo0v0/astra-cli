/**
 * 曲库：本工具下载过的歌。用来去重（不重复下载）和回答"我有没有这首"。
 *
 * 除了档位名（`quality`），还存**母带规格**：采样率、位深、声道。
 * 档位名是"我们请求了什么"，规格是"文件里到底是什么"——只存前者回答不了
 * "哪些还是 16bit、哪些能升级"。
 */
import { existsSync } from 'node:fs'
import { db } from '../core/db.ts'
import type { AudioFormat, Quality } from './audio.ts'
import { normalize } from './match.ts'

export interface TrackSpec {
  sampleRate: number | null
  bitsPerSample: number | null
  channels: number | null
}

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
  /** 母带规格；老记录为 null，可用 `have --refresh` 回读补齐。 */
  spec: TrackSpec
  bytes: number | null
  bps: number | null
  hasCover: boolean | null
  hasLyric: boolean | null
  hasWordLyric: boolean | null
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
  sample_rate: number | null
  bits_per_sample: number | null
  channels: number | null
  has_cover: number | null
  has_lyric: number | null
  has_word_lyric: number | null
  source_id: string | null
  created_at: string
}

const bit = (v: number | null): boolean | null => (v === null ? null : v === 1)

/**
 * 采样率写成 44.1k 这种常见写法。
 * 直接 `round(44100/1000)` 会变成 "44k" —— 44.1kHz 是 CD 标准值，抹掉小数会让人以为是别的规格。
 */
export function specKey(sampleRate: number, bits: number): string {
  const khz = Math.round((sampleRate / 1000) * 10) / 10
  return `${khz}k/${bits}`
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
    spec: { sampleRate: row.sample_rate, bitsPerSample: row.bits_per_sample, channels: row.channels },
    bytes: row.bytes,
    bps: row.bps,
    hasCover: bit(row.has_cover),
    hasLyric: bit(row.has_lyric),
    hasWordLyric: bit(row.has_word_lyric),
    sourceId: row.source_id,
    createdAt: row.created_at,
    missing: !existsSync(row.file_path),
  }
}

export function findTrack(platform: string, id: string): LibraryTrack | null {
  const row = db().prepare('select * from tracks where platform = ? and native_id = ?').get(platform, id) as Row | undefined
  return row ? fromRow(row) : null
}

/**
 * 跨 id 的"其实是同一首歌"指纹：标题 + 歌手 + 时长（取整到秒）。
 *
 * 为什么需要：曲库原来只按 `platform + native_id` 去重。同一首歌换个 id 出现
 * （重发版、不同专辑、单曲与精选）就会被当成新歌再下一遍，覆盖同名文件。
 *
 * 标题和歌手都做归一化（去空格标点、小写、去括号附注），时长取整到秒 ——
 * 平台之间差一两秒是常态，差太多就该当两首歌。
 */
export function trackFingerprint(title: string, artists: string[], durationMs: number | null): string {
  const clean = (text: string): string =>
    text.toLowerCase().normalize('NFKC').replace(/[(（[【].*?[)）\]】]/g, '').replace(/[\s·・\-_'"“”‘’`~!！?？,，.。:：;；()（）[\]【】<>《》/\|]+/g, '')
  const parts = [clean(title), artists.map(clean).sort().join(',')]
  // 时长按 5 秒分桶，而不是精确到秒。
  // 精确到秒看着合理，实测不行：213.2s / 212.5s / 213.9s 都是"同一首"，但取整后会落进
  // 213 / 212 / 214 三个不同值。分桶能容忍来源间一两秒的偏差，又足够区分片段（30s）与全曲。
  parts.push(durationMs && durationMs > 0 ? String(Math.floor(durationMs / 5000)) : '0')
  return parts.join('|')
}

/** 按指纹找已下载的同一首歌（跨 id）。 */
export function findByFingerprint(platform: string, fingerprint: string): LibraryTrack | null {
  const row = db().prepare('select * from tracks where platform = ? and fingerprint = ? limit 1').get(platform, fingerprint) as Row | undefined
  return row ? fromRow(row) : null
}

export interface SaveEntry {
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
  audioSha256: string | null
  spec?: TrackSpec
  hasCover?: boolean
  hasLyric?: boolean
  hasWordLyric?: boolean
}

export function saveTrack(entry: SaveEntry): void {
  db()
    .prepare(
      `insert into tracks (platform, native_id, title, artists, album, duration_ms, file_path, format, quality, bytes, bps,
                           audio_sha256, source_id, created_at, sample_rate, bits_per_sample, channels, has_cover, has_lyric, has_word_lyric, fingerprint)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (platform, native_id) do update set
         title = excluded.title, artists = excluded.artists, album = excluded.album, duration_ms = excluded.duration_ms,
         file_path = excluded.file_path, format = excluded.format, quality = excluded.quality, bytes = excluded.bytes,
         bps = excluded.bps, audio_sha256 = excluded.audio_sha256, source_id = excluded.source_id, created_at = excluded.created_at,
         sample_rate = excluded.sample_rate, bits_per_sample = excluded.bits_per_sample, channels = excluded.channels,
         has_cover = excluded.has_cover, has_lyric = excluded.has_lyric, has_word_lyric = excluded.has_word_lyric,
         fingerprint = excluded.fingerprint`,
    )
    .run(
      entry.platform, entry.id, entry.title, JSON.stringify(entry.artists), entry.album, entry.durationMs, entry.path,
      entry.format, entry.quality, entry.bytes, entry.bps, entry.audioSha256, entry.sourceId, new Date().toISOString(),
      entry.spec?.sampleRate ?? null, entry.spec?.bitsPerSample ?? null, entry.spec?.channels ?? null,
      entry.hasCover === undefined ? null : entry.hasCover ? 1 : 0,
      entry.hasLyric === undefined ? null : entry.hasLyric ? 1 : 0,
      entry.hasWordLyric === undefined ? null : entry.hasWordLyric ? 1 : 0,
      trackFingerprint(entry.title, entry.artists, entry.durationMs),
    )
}

/** 回填补读的规格与附属文件状态（老记录没有这些列的值）。 */
export function updateTrackSpec(
  platform: string,
  id: string,
  patch: { spec?: TrackSpec; bytes?: number | null; bps?: number | null; hasCover?: boolean; hasLyric?: boolean; hasWordLyric?: boolean; quality?: Quality },
): void {
  const sets: string[] = []
  const values: (string | number | null)[] = []
  if (patch.spec) {
    sets.push('sample_rate = ?', 'bits_per_sample = ?', 'channels = ?')
    values.push(patch.spec.sampleRate, patch.spec.bitsPerSample, patch.spec.channels)
  }
  if (patch.bytes !== undefined) { sets.push('bytes = ?'); values.push(patch.bytes) }
  if (patch.bps !== undefined) { sets.push('bps = ?'); values.push(patch.bps) }
  if (patch.quality !== undefined) { sets.push('quality = ?'); values.push(patch.quality) }
  if (patch.hasCover !== undefined) { sets.push('has_cover = ?'); values.push(patch.hasCover ? 1 : 0) }
  if (patch.hasLyric !== undefined) { sets.push('has_lyric = ?'); values.push(patch.hasLyric ? 1 : 0) }
  if (patch.hasWordLyric !== undefined) { sets.push('has_word_lyric = ?'); values.push(patch.hasWordLyric ? 1 : 0) }
  if (sets.length === 0) return
  values.push(platform, id)
  db().prepare(`update tracks set ${sets.join(', ')} where platform = ? and native_id = ?`).run(...values)
}

/**
 * 回填指纹。老记录（加列之前存的）没有指纹，去重就用不上。
 *
 * 单独一个函数、单独一步，是因为它和"规格有没有变"无关：
 * 文件完全没变老记录也要补指纹，不能塞进 refresh 的"有变化才写"分支里。
 */
export function backfillFingerprints(force = false): number {
  // 默认只补 null；`force` 时全量重算 —— 算法一旦调整（比如从"取整到秒"改成"5 秒分桶"，
  // 同一首歌的新旧指纹会不一样），旧指纹就是错的，必须整体重写。
  const where = force ? '1 = 1' : 'fingerprint is null'
  const rows = db().prepare(`select platform, native_id, title, artists, duration_ms from tracks where ${where}`).all() as {
    platform: string; native_id: string; title: string; artists: string; duration_ms: number | null
  }[]
  if (rows.length === 0) return 0
  const update = db().prepare('update tracks set fingerprint = ? where platform = ? and native_id = ?')
  let n = 0
  for (const row of rows) {
    let artists: string[] = []
    try {
      const parsed = JSON.parse(row.artists) as unknown
      if (Array.isArray(parsed)) artists = parsed.filter((x): x is string => typeof x === 'string')
    } catch {
      artists = []
    }
    update.run(trackFingerprint(row.title, artists, row.duration_ms), row.platform, row.native_id)
    n += 1
  }
  return n
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

export function allTracks(): LibraryTrack[] {
  return (db().prepare('select * from tracks order by created_at desc').all() as unknown as Row[]).map(fromRow)
}

export interface LibraryStats {
  tracks: number
  bytes: number
  byQuality: Record<string, number>
  /** 按"48k/24"这种规格分组，比档位名更能说明问题。 */
  bySpec: Record<string, number>
  missing: number
  noCover: number
  noWordLyric: number
}

export function libraryStats(): LibraryStats {
  const rows = db().prepare('select * from tracks').all() as unknown as Row[]
  const byQuality: Record<string, number> = {}
  const bySpec: Record<string, number> = {}
  let bytes = 0
  let missing = 0
  let noCover = 0
  let noWordLyric = 0
  for (const row of rows) {
    byQuality[row.quality] = (byQuality[row.quality] ?? 0) + 1
    const spec = row.sample_rate && row.bits_per_sample ? specKey(row.sample_rate, row.bits_per_sample) : '未知规格'
    bySpec[spec] = (bySpec[spec] ?? 0) + 1
    bytes += row.bytes ?? 0
    if (!existsSync(row.file_path)) missing += 1
    if (row.has_cover === 0) noCover += 1
    if (row.has_word_lyric === 0) noWordLyric += 1
  }
  return { tracks: rows.length, bytes, byQuality, bySpec, missing, noCover, noWordLyric }
}

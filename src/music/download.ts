/**
 * 一首歌的完整流水线：
 *   曲库去重 → 补全元数据 → 取直链（实测音质）→ 下载到临时文件 → 复核格式
 *   → 写标签 / 封面 / 歌词 → 校验音频字节未变 → 移到目标路径 → 记入曲库
 *
 * 失败时临时文件清掉，不会在音乐目录里留半截文件。
 * 标签 / 封面 / 歌词失败只记 warning，不让整首歌失败 —— 音频才是用户要的东西。
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { getConfig, musicRoot } from '../core/config.ts'
import { progress } from '../core/output.ts'
import { probeFile, extensionFor, type Quality, type AudioFormat } from './audio.ts'
import { albumInfo, beijingDate, lyric, type AlbumInfo, type Track } from './netease.ts'
import { resolveUrl } from './resolve.ts'
import { audioPayload, writeTags, type TagData } from './tags.ts'
import { renderTemplate, resolveInside } from './paths.ts'
import { findTrack, saveTrack, type LibraryTrack } from './library.ts'

export interface DownloadOptions {
  quality: Quality
  /** 已在曲库里时也重新下载（比如想要更高音质）。 */
  force?: boolean
  signal?: AbortSignal
  /** 批量下载时同一张专辑只查一次。 */
  albumCache?: Map<string, Promise<AlbumInfo | null>>
}

export interface DownloadResult {
  status: 'downloaded' | 'already_have'
  track: { id: string; title: string; artists: string[]; album: string | null }
  path: string
  format: AudioFormat
  quality: Quality
  requestedQuality: Quality
  downgraded: boolean
  bytes: number | null
  bitrateKbps: number | null
  source: string | null
  lyricFile: string | null
  warnings: string[]
}

function existingResult(hit: LibraryTrack, requested: Quality): DownloadResult {
  return {
    status: 'already_have',
    track: { id: hit.id, title: hit.title, artists: hit.artists, album: hit.album },
    path: hit.path,
    format: hit.format,
    quality: hit.quality,
    requestedQuality: requested,
    downgraded: false,
    bytes: hit.bytes,
    bitrateKbps: hit.bps ? Math.round(hit.bps / 1000) : null,
    source: hit.sourceId,
    lyricFile: null,
    warnings: [],
  }
}

async function fetchBuffer(url: string, signal?: AbortSignal): Promise<{ data: Buffer; mime: string } | null> {
  const options: Parameters<typeof httpRequest>[1] = { timeoutMs: 20_000, retries: 1 }
  if (signal) options.signal = signal
  const response = await httpRequest(url, options)
  if (response.status >= 400) {
    await response.body?.cancel()
    return null
  }
  const data = Buffer.from(await response.arrayBuffer())
  const mime = data.subarray(0, 4).toString('hex') === '89504e47' ? 'image/png' : 'image/jpeg'
  return { data, mime }
}

/** 下载到临时文件。直链常是 http，CDN 有时会断流，按 Range 续一次。 */
async function downloadTo(url: string, file: string, expectedBytes: number | null, signal?: AbortSignal): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const already = attempt === 0 ? 0 : await stat(file).then((s) => s.size).catch(() => 0)
    const headers: Record<string, string> = already > 0 ? { Range: `bytes=${already}-` } : {}
    const options: Parameters<typeof httpRequest>[1] = { headers, timeoutMs: 120_000, retries: 1 }
    if (signal) options.signal = signal
    const response = await httpRequest(url, options)
    if (response.status >= 400 || !response.body) {
      await response.body?.cancel()
      throw new AstraError('DOWNLOAD_FAILED', `下载音频返回 HTTP ${response.status}`, { exitCode: 5, retryable: true })
    }
    const append = already > 0 && response.status === 206
    try {
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(file, { flags: append ? 'a' : 'w' }))
    } catch (err) {
      if (signal?.aborted) throw new AstraError('CANCELLED', '已取消', { exitCode: 130 })
      progress('music.download.retry', { attempt: attempt + 1, reason: (err as Error).message })
      continue
    }
    const size = (await stat(file)).size
    if (expectedBytes === null || size >= expectedBytes) return size
    progress('music.download.retry', { attempt: attempt + 1, reason: `只收到 ${size}/${expectedBytes} 字节` })
  }
  throw new AstraError('DOWNLOAD_FAILED', '音频下载多次中断', { exitCode: 5, retryable: true })
}

function lyricText(lrc: string): string {
  return lrc
    .split(/\r?\n/)
    .map((line) => line.replace(/\[[^\]]*\]/g, '').trim())
    .filter((line) => line && !/^(作词|作曲|编曲|制作人|混音|母带|录音)\s*[:：]/.test(line))
    .join('\n')
}

/** 原文和翻译按时间戳合并成双语 LRC：同一时间戳下先原文再译文。 */
export function mergeLrc(original: string, translation: string | null): string {
  if (!translation) return original
  const tagged = (text: string): Map<string, string> => {
    const out = new Map<string, string>()
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\[(\d{1,3}:\d{2}(?:[.:]\d{1,3})?)\](.*)$/)
      if (m && m[2]!.trim()) out.set(m[1]!, m[2]!.trim())
    }
    return out
  }
  const trans = tagged(translation)
  return original
    .split(/\r?\n/)
    .flatMap((line) => {
      const m = line.match(/^\[(\d{1,3}:\d{2}(?:[.:]\d{1,3})?)\]/)
      const t = m ? trans.get(m[1]!) : undefined
      return t ? [line, `[${m![1]}]${t}`] : [line]
    })
    .join('\n')
}

export async function downloadTrack(track: Track, options: DownloadOptions): Promise<DownloadResult> {
  const { quality, signal } = options
  const hit = findTrack('wy', track.id)
  if (hit && !hit.missing && !options.force) return existingResult(hit, quality)

  const warnings: string[] = []
  const resolved = await resolveUrl(track, quality, signal)
  if (resolved.downgraded) warnings.push(`请求 ${quality}，音源只给到 ${resolved.probe.quality}`)

  // 专辑信息：专辑歌手 / 公司 / 曲目总数，写标签用；失败不影响下载
  let album: AlbumInfo | null = null
  if (track.albumId) {
    const cache = options.albumCache
    let pending = cache?.get(track.albumId)
    if (!pending) {
      pending = albumInfo(track.albumId, signal).then((r) => r.album).catch(() => null)
      cache?.set(track.albumId, pending)
    }
    album = await pending
  }

  const root = musicRoot()
  const albumArtists = album?.artists.length ? album.artists : track.artists.slice(0, 1)
  const date = beijingDate(track.publishTime ?? album?.publishTime ?? null)
  const ext = extensionFor(resolved.probe.format)
  const relative = renderTemplate(getConfig('music.template'), {
    artist: track.artists.join(', '),
    albumartist: albumArtists.join(', '),
    album: track.album ?? '未知专辑',
    title: track.title,
    year: date?.slice(0, 4) ?? '',
    track: track.trackNo ? String(track.trackNo) : '',
    disc: track.discNo ? String(Number.parseInt(track.discNo, 10) || '') : '',
    ext,
  })
  const target = resolveInside(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.part-${process.pid}`

  try {
    progress('music.download', { id: track.id, title: track.title, quality: resolved.probe.quality, bytes: resolved.probe.bytes })
    const size = await downloadTo(resolved.url, tmp, resolved.probe.bytes, signal)
    const probe = await probeFile(tmp, track.durationMs)
    if (probe.problem) throw new AstraError('BAD_AUDIO', `下载到的文件不是音频：${probe.problem}`, { exitCode: 5, retryable: true })
    // 时长对不上，多半是拿错了版本（Live / 剪辑版）或文件被截断。差 10 秒以上提醒
    const actualSeconds = probe.flac && probe.flac.sampleRate > 0 ? probe.flac.totalSamples / probe.flac.sampleRate : null
    if (actualSeconds !== null && track.durationMs && Math.abs(actualSeconds - track.durationMs / 1000) > 10) {
      warnings.push(`音频时长 ${Math.round(actualSeconds)} 秒，与网易云记录的 ${Math.round(track.durationMs / 1000)} 秒不一致，可能不是同一版本`)
    }
    if (probe.format !== resolved.probe.format) warnings.push(`探测为 ${resolved.probe.format}，下载后实为 ${probe.format}`)

    // 歌词
    const lyricMode = getConfig('music.lyric')
    let lyricBody: { lrc: string; text: string } | null = null
    if (lyricMode !== 'none') {
      try {
        const lr = await lyric(track.id, signal)
        if (lr.lrc) lyricBody = { lrc: mergeLrc(lr.lrc, lr.translation), text: lyricText(lr.lrc) }
      } catch (err) {
        warnings.push(`歌词获取失败：${(err as Error).message}`)
      }
    }

    // 封面
    let cover: TagData['cover'] = null
    const coverUrl = track.coverUrl ?? album?.coverUrl ?? null
    if (coverUrl) {
      try {
        cover = await fetchBuffer(`${coverUrl}?param=1200y1200`, signal)
        if (!cover) warnings.push('封面下载失败')
      } catch (err) {
        warnings.push(`封面下载失败：${(err as Error).message}`)
      }
    }

    const tags: TagData = {
      title: track.title,
      artists: track.artists,
      album: track.album,
      albumArtists,
      date,
      trackNo: track.trackNo,
      trackTotal: album?.size ?? null,
      discNo: track.discNo ? Number.parseInt(track.discNo, 10) || null : null,
      publisher: album?.company ?? null,
      lyrics: lyricBody && (lyricMode === 'embed' || lyricMode === 'both') ? lyricBody.text : null,
      cover,
      source: { platform: 'netease', id: track.id },
    }

    const before = createHash('sha256').update(audioPayload(await readFile(tmp), probe.format)).digest('hex')
    let audioSha256: string | null = before
    try {
      const tagResult = await writeTags(tmp, probe.format, tags)
      if (!tagResult.written && tagResult.reason) warnings.push(tagResult.reason)
      if (tagResult.written) {
        const after = createHash('sha256').update(audioPayload(await readFile(tmp), probe.format)).digest('hex')
        if (after !== before) throw new AstraError('TAG_CORRUPTED_AUDIO', '写标签改动了音频数据', { exitCode: 1 })
      }
    } catch (err) {
      if (err instanceof AstraError && err.code === 'TAG_CORRUPTED_AUDIO') throw err
      warnings.push(`标签写入失败：${(err as Error).message}`)
      audioSha256 = null
    }

    if (hit && hit.path !== target) await rm(hit.path, { force: true })
    await rename(tmp, target)

    let lyricFile: string | null = null
    if (lyricBody && (lyricMode === 'lrc' || lyricMode === 'both')) {
      lyricFile = target.replace(/\.[^.]+$/, '.lrc')
      await writeFile(lyricFile, lyricBody.lrc, 'utf8')
    }

    saveTrack({
      platform: 'wy',
      id: track.id,
      title: track.title,
      artists: track.artists,
      album: track.album,
      durationMs: track.durationMs,
      path: target,
      format: probe.format,
      quality: probe.quality,
      bytes: size,
      bps: probe.bps,
      sourceId: `${resolved.sourceId}@${resolved.route}`,
      audioSha256,
    })

    return {
      status: 'downloaded',
      track: { id: track.id, title: track.title, artists: track.artists, album: track.album },
      path: target,
      format: probe.format,
      quality: probe.quality,
      requestedQuality: quality,
      downgraded: resolved.downgraded,
      bytes: size,
      bitrateKbps: probe.bps ? Math.round(probe.bps / 1000) : null,
      source: `${resolved.sourceId}@${resolved.route}`,
      lyricFile,
      warnings,
    }
  } finally {
    await rm(tmp, { force: true })
    await rm(`${tmp}.tagging`, { force: true })
  }
}

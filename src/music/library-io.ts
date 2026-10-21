/**
 * 曲库的"对外产物"：歌单封面归档、M3U 播放列表导出。
 *
 * 为什么需要：
 * - 现在只有单曲内嵌封面，播放器按专辑浏览时常常是空白 —— 存一张 `cover.jpg` 到专辑目录就能补上
 * - Navidrome 等播放器能读 M3U；把曲库导出一份，换播放器时不用重扫
 *
 * 零推测原则照旧：封面取不到就不写，不拿别的图凑。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AstraError } from '../core/errors.ts'
import { allTracks, type LibraryTrack } from './library.ts'
import { extractCoverArt } from './tags.ts'

export interface CoverArchiveResult {
  /** 写了多少张 cover.jpg。 */
  written: number
  /** 已经有的（跳过）。 */
  skipped: number
  /** 取不到封面或写失败的，带原因。 */
  failed: { path: string; reason: string }[]
}

/**
 * 给每张专辑目录放一张 `cover.jpg`。
 *
 * 只处理曲库里有的曲目（不扫全盘），按"歌所在目录的父目录"判断专辑目录。
 * 已有 `cover.jpg` 的直接跳过，不重复下。
 */
export async function archiveAlbumCovers(signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<CoverArchiveResult> {
  const tracks = allTracks().filter((t) => !t.missing)
  const result: CoverArchiveResult = { written: 0, skipped: 0, failed: [] }
  const seen = new Set<string>()
  for (const [index, track] of tracks.entries()) {
    const albumDir = path.dirname(track.path)
    if (seen.has(albumDir)) continue
    seen.add(albumDir)
    const dest = path.join(albumDir, 'cover.jpg')
    const exists = await stat(dest).catch(() => null)
    if (exists) {
      result.skipped += 1
      onProgress?.(index + 1, tracks.length)
      continue
    }
    try {
      // 从文件里抠内嵌封面：不联网，也不会因为平台换了图而对不上
      const buffer = await readFile(track.path)
      const cover = extractCoverArt(buffer)
      if (!cover) {
        result.failed.push({ path: dest, reason: '文件里没有内嵌封面' })
      } else {
        await writeFile(dest, cover.data)
        result.written += 1
      }
    } catch (err) {
      result.failed.push({ path: dest, reason: (err as Error).message.slice(0, 120) })
    }
    if (signal?.aborted) break
    onProgress?.(index + 1, tracks.length)
  }
  return result
}

export interface M3uOptions {
  output: string
  /** 只导出某个关键词匹配的曲目；不给则全部。 */
  keyword?: string
  /** 用绝对路径（默认，播放器能直接找到文件）还是相对播放列表。 */
  relative?: boolean
}

/**
 * 导出 M3U8 播放列表。
 *
 * 用 M3U8（UTF-8）而不是 M3U：中文路径在 M3U 里常被播放器按本地编码误解，
 * 表现为"歌名全是乱码"或"文件找不到"。
 */
export async function exportM3u(options: M3uOptions): Promise<{ output: string; count: number; skipped: number }> {
  const keyword = options.keyword?.trim().toLowerCase() ?? ''
  const baseDir = path.dirname(path.resolve(options.output))
  const tracks = allTracks().filter((t) => {
    if (t.missing) return false
    if (!keyword) return true
    return [t.title, ...t.artists, t.album ?? ''].join(' ').toLowerCase().includes(keyword)
  })
  if (tracks.length === 0) {
    throw new AstraError('EMPTY_PLAYLIST', keyword ? `没有匹配「${keyword}」的曲目` : '曲库是空的', { exitCode: 4 })
  }

  const lines: string[] = ['#EXTM3U']
  let count = 0
  for (const track of tracks) {
    const target = options.relative === true ? path.relative(baseDir, track.path) : path.resolve(track.path)
    lines.push(`#EXTINF:${Math.round((track.durationMs ?? 0) / 1000)},${track.artists.join(', ')} - ${track.title}`)
    // Windows 播放列表里的分隔符用反斜杠更稳，但正斜杠两边都认
    lines.push(target.replace(/\\/g, '/'))
    count += 1
  }
  await mkdir(baseDir, { recursive: true })
  await writeFile(options.output, lines.join('\n') + '\n', 'utf8')
  return { output: options.output, count, skipped: allTracks().length - tracks.length }
}

/** 供测试与调试：生成 M3U 内容而不落盘。 */
export function buildM3uLines(tracks: LibraryTrack[], baseDir: string, relative: boolean): string[] {
  const lines = ['#EXTM3U']
  for (const track of tracks) {
    const target = relative ? path.relative(baseDir, track.path) : path.resolve(track.path)
    lines.push(`#EXTINF:${Math.round((track.durationMs ?? 0) / 1000)},${track.artists.join(', ')} - ${track.title}`)
    lines.push(target.replace(/\\/g, '/'))
  }
  return lines
}

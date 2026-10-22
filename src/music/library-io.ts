/**
 * 曲库的"对外产物"：歌单封面归档、M3U 播放列表导出。
 *
 * 为什么需要：
 * - 现在只有单曲内嵌封面，播放器按专辑浏览时常常是空白 —— 存一张 `cover.jpg` 到专辑目录就能补上
 * - Navidrome 等播放器能读 M3U；把曲库导出一份，换播放器时不用重扫
 *
 * 零推测原则照旧：封面取不到就不写，不拿别的图凑。
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync, type Dirent } from 'node:fs'
import path from 'node:path'
import { AstraError } from '../core/errors.ts'
import { musicRoot } from '../core/config.ts'
import { allTracks, type LibraryTrack } from './library.ts'
import { extractCoverArt } from './tags.ts'

/** 扫描时认作"音频文件"的扩展名。 */
const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.ogg', '.opus', '.wav', '.aac', '.wma'])

/**
 * 扫音乐根目录，找出所有"装音频的目录"。
 *
 * **以目录为准，不以曲库记录为准。** 这是清单 P2#13 的核心：
 * 原来遍历 `allTracks()`，曲库没收录的专辑（手动放进去的、下载后没入库的、
 * 记录被 forget 掉的）根本不在遍历范围里，`written` 看着全部成功，
 * 实际漏了目录，而且 `failed` 是空的 —— 静默跳过。
 *
 * 只认"直接含有音频文件"的目录：上一层（歌手目录）通常只有子目录，
 * 不该给它写 cover.jpg。代价是"音频在更深的子目录里"扫不到，
 * 但那不是这套模板会产出的结构（模板是 `<歌手>/<专辑>/<曲目>.flac`）。
 */
export async function findAlbumDirs(root: string): Promise<string[]> {
  const out: string[] = []
  const list = async (dir: string): Promise<Dirent[]> => {
    try {
      return await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
  }
  for (const entry of await list(root)) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const children = await list(dir)
    const hasAudio = children.some((c) => c.isFile() && AUDIO_EXT.has(path.extname(c.name).toLowerCase()))
    if (hasAudio) {
      out.push(dir)
      continue
    }
    // 再往下一层看看（`<歌手>/<专辑>/` 是标准结构；也容忍 `<专辑>/<碟>/`）
    for (const child of children) {
      if (!child.isDirectory()) continue
      const sub = path.join(dir, child.name)
      const grand = await list(sub)
      if (grand.some((g) => g.isFile() && AUDIO_EXT.has(path.extname(g.name).toLowerCase()))) out.push(sub)
    }
  }
  return out
}

export interface CoverArchiveResult {
  /** 写了多少张 cover.jpg。 */
  written: number
  /** 已经有的（跳过）。 */
  skipped: number
  /** 取不到封面或写失败的，带原因。 */
  failed: { path: string; reason: string }[]
  /**
   * **没有 cover.jpg 的专辑目录**，即使这次没能补上。
   *
   * 和 `failed` 的区别：`failed` 说的是"这一张没写成、为什么"，
   * `missing` 说的是"跑完之后，库里头还有哪些目录是没封面的" ——
   * 包含两种情况：
   * 1. 文件里确实没有内嵌封面（补不了，要靠联网或手工）
   * 2. **有内嵌封面但这次没覆盖到**（比如同一专辑的曲目分散在多个目录，
   *    只按第一个目录写了 cover.jpg，其余目录仍然空着）
   *
   * 第 2 种才是真正需要兜底的：它有封面却没写出来，用户以为跑过了就没事了。
   */
  missing: { dir: string; reason: string }[]
  /** 一共扫到多少个专辑目录。 */
  dirs: number
  /** 跑完之后**确实有** cover.jpg 的目录数（含原来就有的）。 */
  hasCover: number
}

/** 自检：扫到的目录里，哪些跑完之后仍然没有 cover.jpg。 */
export function verifyCovers(result: CoverArchiveResult): { ok: boolean; missing: { dir: string; reason: string }[] } {
  return { ok: result.missing.length === 0, missing: result.missing }
}

/**
 * 给每张专辑目录放一张 `cover.jpg`。
 *
 * 只处理曲库里有的曲目（不扫全盘），按"歌所在目录的父目录"判断专辑目录。
 * 已有 `cover.jpg` 的直接跳过，不重复下。
 */
export interface CoverArchiveOptions {
  /** 音乐根目录；不给就取 `musicRoot()`。 */
  root?: string
  /** 只看这些目录（测试与 `--dir` 用）。 */
  dirs?: string[]
}

export async function archiveAlbumCovers(
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
  options: CoverArchiveOptions = {},
): Promise<CoverArchiveResult> {
  const result: CoverArchiveResult = { written: 0, skipped: 0, failed: [], missing: [], dirs: 0, hasCover: 0 }

  // **以目录为准**（清单 P2#13）。不看曲库记录 —— 曲库没收录的专辑照样要覆盖。
  const root = options.root ?? musicRoot()
  const dirs = options.dirs ?? await findAlbumDirs(root)
  result.dirs = dirs.length

  // 目录 -> 该目录下的音频文件。曲库记录只是"加速线索"，
  // 找不到就现场扫目录，绝不因为"曲库没有"就跳过。
  const knownByDir = new Map<string, string[]>()
  for (const track of allTracks()) {
    if (track.missing) continue
    const dir = path.dirname(track.path)
    const list = knownByDir.get(dir)
    if (list) list.push(track.path)
    else knownByDir.set(dir, [track.path])
  }

  let index = 0
  for (const albumDir of dirs) {
    index += 1
    const dest = path.join(albumDir, 'cover.jpg')

    // 判据是 cover.jpg **在不在**，不是"内嵌封面能不能读到"
    if (await stat(dest).catch(() => null)) {
      result.skipped += 1
      result.hasCover += 1
      onProgress?.(index, dirs.length)
      continue
    }

    // 候选音频：先用曲库里的，再用目录里实际存在的（两者取并集，
    // 曲库没有这条记录时也能找到文件）
    const candidates = new Set(knownByDir.get(albumDir) ?? [])
    try {
      for (const entry of await readdir(albumDir, { withFileTypes: true })) {
        if (entry.isFile() && AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) {
          candidates.add(path.join(albumDir, entry.name))
        }
      }
    } catch {
      // 目录读不了就走下面的失败分支
    }

    // 挨个试，直到抠出封面为止 —— 第一首可能是纯音乐/翻唱，没有内嵌封面
    let wrote = false
    let lastReason = '目录里没有音频文件'
    for (const file of candidates) {
      try {
        const buffer = await readFile(file)
        const cover = extractCoverArt(buffer)
        if (!cover) {
          lastReason = '文件里没有内嵌封面'
          continue
        }
        await writeFile(dest, cover.data)
        result.written += 1
        result.hasCover += 1
        wrote = true
        break
      } catch (err) {
        lastReason = (err as Error).message.slice(0, 120)
      }
    }
    if (!wrote) {
      result.failed.push({ path: dest, reason: lastReason })
      // 跑完之后这个目录仍然没有 cover.jpg —— 调用方靠这个判断有没有漏
      result.missing.push({ dir: albumDir, reason: lastReason })
    }
    if (signal?.aborted) break
    onProgress?.(index, dirs.length)
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

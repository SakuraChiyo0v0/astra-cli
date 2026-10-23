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
import { albumArtistsFor, isCompilation, primaryArtist } from './album-artist.ts'
import { kugouWordLyric, toEnhancedLrc } from './kugou-lyric.ts'
import { findTrack, findByFingerprint, forgetTrack, saveTrack, trackFingerprint, type LibraryTrack } from './library.ts'
import { albumTypeRank, preferredAlbum, type AlbumCandidate } from './album-priority.ts'

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
  /** 主歌词文件 `.lrc`：有逐字就是逐字格式，否则是逐行。 */
  lyricFile: string | null
  /** 逐行兜底 `.line.lrc`；只有拿到逐字歌词时才有。 */
  lineLyricFile: string | null
  /** @deprecated 同 `lineLyricFile`，保留这个键不打断已有脚本。 */
  wordLyricFile: string | null
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
    lineLyricFile: null,
    wordLyricFile: null,
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

/**
 * 实际用的落盘模板。
 *
 * 合辑换成 `<合辑目录>/{album}/<文件名段>`：目录前缀不看用户模板，因为模板可能是
 * `{artist}/…`，那样合辑里每个歌手各起一个目录，等于没归到一起。文件名那一段照用
 * 用户的模板，不擅自改他的命名习惯。
 */
export function templateFor(options: { template: string; compilationDir: string; compilation: boolean }): string {
  if (!options.compilation) return options.template
  const segments = options.template.split(/[\\/]+/).filter(Boolean)
  const file = segments[segments.length - 1] ?? '{title}.{ext}'
  return `${options.compilationDir}/{album}/${file}`
}

/** 这个 `music.lyric` 取值要不要往文件里写歌词。 */
export function embedsLyric(mode: string): boolean {
  return mode === 'embed' || mode === 'embed-synced' || mode === 'embed-plain' || mode === 'both'
}

/** 这个取值要不要另外存一份 `.lrc`。 */
export function writesLrcFile(mode: string): boolean {
  return mode === 'lrc' || mode === 'both'
}

/**
 * 挑内嵌用哪份歌词。
 *
 * `embed-plain` 要纯文本（老播放器不认时间戳），其余取值有带时间戳的就用带时间戳的：
 * 逐字 `<mm:ss.xx>` 优先，其次普通 `[mm:ss.xx]`。剥掉时间戳的纯文本播放器解析不出滚动歌词，
 * Navidrome 会直接当成"无歌词"。
 */
export function pickEmbeddedLyrics(
  mode: string,
  synced: { enhanced?: string | null; lrc?: string | null; plain?: string | null },
): string | null {
  if (!embedsLyric(mode)) return null
  if (mode === 'embed-plain') return synced.plain ?? null
  return synced.enhanced ?? synced.lrc ?? synced.plain ?? null
}

/**
 * 剥掉时间戳与制作人员名单，得到纯逐行文本（`.line.lrc` 用）。
 *
 * 两种时间戳都要剥：普通 LRC 的 `[mm:ss.xx]` 和逐字的 `<mm:ss.xx>`。
 * 只剥方括号的话，从增强 LRC 转出来的 `.line.lrc` 会残留一堆 `<00:12.34>`，
 * 不认逐字标签的播放器会把它们当正文显示出来。
 */
export function lyricText(lrc: string): string {
  return lrc
    .split(/\r?\n/)
    .map((line) => line.replace(/\[[^\]]*\]/g, '').replace(/<[^>]*>/g, '').trim())
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
  // 先按 id 找，再按"标题 + 歌手 + 时长"指纹找。
  // 同一首歌换 id 出现（重发版 / 不同专辑 / 单曲与精选）很常见，只认 id 会重下一遍并覆盖同名文件。
  //
  // **但命中不等于就该跳过**（P4#5）：同一首歌可能同时在 Thriller(1982) 和
  // HIStory(1995) 里。只在"已有那份的专辑更该拥有它"时才跳过；否则要把它
  // 从精选集**搬**回原专辑 —— 否则并行下载时谁先下完谁占，等于随机。
  const byId = findTrack('wy', track.id)
  const hit = byId ?? findByFingerprint('wy', trackFingerprint(track.title, track.artists, track.durationMs))
  let existing = hit && !hit.missing && !options.force ? hit : null
  // 归位时要清理的旧文件。**只有新文件确认落盘后才删它**（P4#6）
  let reassignFrom: string | null = null
  let reassignFromId: string | null = null

  const warnings: string[] = []

  // 专辑信息：专辑歌手 / 公司 / 曲目总数，写标签用；失败不影响下载。
  // 挪到取链之前是为了先做归属判断（P4#5）—— 判完要跳过的话就不必取链了。
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

  // 归属判断（P4#5）：库里已经有这首歌时，比一比"哪张专辑更该拥有它"。
  //
  // 判据是年份 / 专辑类型 / 曲目号，与**下载完成顺序无关**。
  // 输了就跳过；赢了说明现在这张才是原专辑，已有那份该让位 ——
  // 把它从精选集搬回原专辑（下面 `existing = null` 继续走下）。
  if (existing) {
    const mine: AlbumCandidate = {
      id: track.albumId ?? '',
      name: track.album ?? '',
      publishTime: track.publishTime ?? album?.publishTime ?? null,
      type: album?.type ?? null,
      trackNo: track.trackNo,
    }
    const theirs: AlbumCandidate = {
      id: existing.albumId ?? '',
      name: existing.album ?? '',
      // 老记录没存年份，只能退回"不知道" —— 这时按类型/trackNo 比，
      // 分不出来就保持现状（不因下载顺序翻转，这是底线）
      publishTime: existing.albumYear ? new Date(`${existing.albumYear}-01-01`).getTime() : null,
      // 老记录没存类型；`albumTypeRank(null)` 是中间档，
      // 于是 `theirsSecondary` 为 false → 不动文件。这是安全的默认值。
      type: existing.albumType ?? null,
      trackNo: null,
    }

    // 三个方向要分清（P4#6）：
    // 1. 已有那份更该拥有 → 跳过
    // 2. **已有那份是精选/合辑/现场，现在这张是录音室原专辑** → 归位（唯一允许动的方向）
    // 3. 其它（新专辑反而更"二手"）→ 不动，跳过
    //
    // 为什么只放开方向 2：清单实测过归位方向搞反的代价 ——
    // 下精选集时把原专辑里的歌搬走了，调用方从目录看到"新专辑里有、旧专辑没了"，
    // 误以为新专辑那两条是重复副本、删掉之后原文件彻底丢失。
    // 只让"精选 → 原专辑"这一个方向动文件，是因为那个方向下原专辑本来就该有，
    // 搬过去只会让库更正确；反方向则会把用户已经整理好的目录打乱。
    if (preferredAlbum(theirs, mine)) {
      // 已有那份更该拥有 —— 正常跳过
      if (existing.id !== track.id) progress('music.dedup', { wanted: track.id, existing: existing.id, title: track.title })
      return existingResult(existing, quality)
    }

    // 到这里 mine 不输给 theirs。但**只有"精选让位给录音室原专辑"才动文件**。
    //
    // 判据（两个都要成立）：
    // 1. 已有那份是"二手"专辑（精选 / 合辑 / 现场 / 原声）
    // 2. 现在这张更早，或者已有那份类型明确是二手
    //
    // 只看年份是不够的：同年出的重混版不该把原版挤走。
    // 两端信息不全时一律不动 —— 在不确定的情况下搬用户已经整理好的文件，
    // 代价远大于"这首歌暂时待在精选集里"。
    const theirsSecondary = albumTypeRank(theirs.type) >= 4
    const mineMoreOriginal = albumTypeRank(mine.type) < albumTypeRank(theirs.type)
    const strictlyOlder = theirs.publishTime !== null && mine.publishTime !== null && mine.publishTime < theirs.publishTime

    if (!(theirsSecondary && (mineMoreOriginal || strictlyOlder))) {
      if (existing.id !== track.id) progress('music.dedup', { wanted: track.id, existing: existing.id, title: track.title })
      return existingResult(existing, quality)
    }

    progress('music.reassign', {
      title: track.title,
      from: existing.album ?? '(未知专辑)',
      to: track.album ?? '(未知专辑)',
      fromYear: theirs.publishTime ? new Date(theirs.publishTime).getUTCFullYear() : null,
      toYear: mine.publishTime ? new Date(mine.publishTime).getUTCFullYear() : null,
    })

    // **先删再下是错的**（P4#6）：中间任何失败（网络断、磁盘满、Ctrl-C）
    // 都会让文件真的没了。实测丢过 2 首歌，只能重下整张专辑补回。
    //
    // 正确顺序：先把新位置下好、确认落盘，再删旧的（见下面 saveTrack 之后）。
    reassignFrom = existing.path
    reassignFromId = existing.id
    existing = null
  }

  const resolved = await resolveUrl(track, quality, signal)
  if (resolved.downgraded) warnings.push(`请求 ${quality}，音源只给到 ${resolved.probe.quality}`)

  const root = musicRoot()
  const albumScope = { albumArtists: album?.artists ?? null, albumId: track.albumId }
  const albumArtists = albumArtistsFor({ ...albumScope, trackArtists: track.artists })
  const date = beijingDate(track.publishTime ?? album?.publishTime ?? null)
  const ext = extensionFor(resolved.probe.format)
  const vars = {
    artist: track.artists.join(', '),
    // 三位歌手以上时 {artist} 会变成一长串；{artist_list} 用分号，和标签里的多值写法一致
    artist_list: track.artists.join(';'),
    albumartist: albumArtists.join(', '),
    primary_artist: primaryArtist(track.artists),
    album: track.album ?? '未知专辑',
    title: track.title,
    year: date?.slice(0, 4) ?? '',
    track: track.trackNo ? String(track.trackNo) : '',
    disc: track.discNo ? String(Number.parseInt(track.discNo, 10) || '') : '',
    // 音源标识（official / qdy@wy 之类），想按来源分目录时用得上
    source: resolved.sourceId === 'official' ? 'official' : `${resolved.sourceId}@${resolved.route}`,
    ext,
  }
  const relative = renderTemplate(
    templateFor({ template: getConfig('music.template'), compilationDir: getConfig('music.compilation-dir'), compilation: isCompilation(albumScope) }),
    vars,
  )
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

    // 逐字歌词必须在**写标签之前**拿到 —— 内嵌要用它。
    // 原先这段在最后，所以 embed 永远只能拿到剥掉时间戳的纯文本，
    // Navidrome 因此显示"无歌词"。
    const wordLyricText = await (async (): Promise<{ enhanced: string; plain: string } | null> => {
      if (getConfig('music.wordLyric') === 'off') return null
      try {
        const krc = await kugouWordLyric(track, signal)
        if (!krc) return null
        const enhanced = toEnhancedLrc(krc)
        return { enhanced, plain: lyricText(enhanced) }
      } catch (err) {
        warnings.push(`逐字歌词获取失败：${(err as Error).message}`)
        return null
      }
    })()

    // 内嵌用哪份：优先逐字（带 <mm:ss.xx>），否则普通 LRC（带 [mm:ss.xx]），都没有才退回纯文本。
    // 播放器没有时间戳就解析不出"滚动歌词"，只当成一段文字 —— 这就是 Navidrome 显示"无歌词"的原因。
    // `embed-plain` 是给不认时间戳的老播放器留的退路。
    const embeddedLyrics = pickEmbeddedLyrics(lyricMode, {
      enhanced: wordLyricText?.enhanced,
      lrc: lyricBody?.lrc,
      plain: lyricBody?.text ?? wordLyricText?.plain,
    })

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
      lyrics: embedsLyric(lyricMode) ? embeddedLyrics : null,
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

    // 歌词落盘：**逐字写 `.lrc`，逐行兜底写 `.line.lrc`**。
    //
    // 为什么不是 `.word.lrc`：播放器/Navidrome 只按 `<歌名>.lrc` 找 sidecar，
    // 换个扩展名等于永远不被读取 —— 逐字歌词写了也没用。
    // 带 `<mm:ss.xx>` 的增强 LRC 是 `.lrc` 的超集，认普通 LRC 的播放器也能读，
    // 所以逐字放主位、逐行放旁边给不认逐字标签的播放器兜底。
    //
    // 顺序：有逐字就 `.lrc` = 逐字 + `.line.lrc` = 逐行；没有逐字就 `.lrc` = 逐行。
    let lyricFile: string | null = null
    let lineLyricFile: string | null = null
    const base = target.replace(/\.[^.]+$/, '')
    if (wordLyricText) {
      lyricFile = `${base}.lrc`
      await writeFile(lyricFile, wordLyricText.enhanced, 'utf8')
      lineLyricFile = `${base}.line.lrc`
      await writeFile(lineLyricFile, wordLyricText.plain, 'utf8')
    } else if (lyricBody && writesLrcFile(lyricMode)) {
      lyricFile = `${base}.lrc`
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
      sourceId: resolved.sourceId === 'official' ? 'official' : `${resolved.sourceId}@${resolved.route}`,
      audioSha256,
      // 母带规格：只有 FLAC 能从头部精确读出；MP3 无法从标签可靠拿到采样率，留 null
      spec: { sampleRate: probe.flac?.sampleRate ?? null, bitsPerSample: probe.flac?.bitsPerSample ?? null, channels: probe.flac?.channels ?? null },
      hasCover: cover !== null,
      hasLyric: lyricBody !== null,
      hasWordLyric: lineLyricFile !== null,
      // 存下来给下次的归属判断用（P4#5）—— 不然每次都要再查一次专辑接口
      albumId: track.albumId ?? null,
      albumYear: (track.publishTime ?? album?.publishTime ?? null)
        ? new Date((track.publishTime ?? album?.publishTime)! * 1000).getUTCFullYear()
        : null,
      albumType: album?.type ?? null,
    })

    // 新文件已经落盘，这时候才能清理旧位置（P4#6）。
    // 顺序很重要：反过来的话中途失败就真的丢歌了。
    if (reassignFrom && reassignFrom !== target) {
      try {
        await rm(reassignFrom, { force: true })
        if (reassignFromId && reassignFromId !== track.id) forgetTrack('wy', reassignFromId)
        // 顺手清掉同名的歌词 sidecar —— 它们跟着音频走，留下就是孤儿
        const oldBase = reassignFrom.replace(/\.[^.]+$/, '')
        for (const ext of ['.lrc', '.line.lrc', '.word.lrc']) await rm(`${oldBase}${ext}`, { force: true })
        progress('music.reassign.done', { title: track.title, removed: reassignFrom, nowAt: target })
      } catch (err) {
        // 删不掉也不该让下载失败 —— 新文件已经好了，旧的多留一份只是占空间。
        // 但要如实说，否则用户会看到两个副本不知从哪来。
        warnings.push(`旧位置没清理掉（${reassignFrom}）：${(err as Error).message.slice(0, 100)}`)
      }
    }

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
      source: resolved.sourceId === 'official' ? 'official' : `${resolved.sourceId}@${resolved.route}`,
      lyricFile,
      lineLyricFile,
      // 旧键：值是 .line.lrc 的路径，语义和以前一样（逐行那份）
      wordLyricFile: lineLyricFile,
      warnings,
    }
  } finally {
    await rm(tmp, { force: true })
    await rm(`${tmp}.tagging`, { force: true })
  }
}

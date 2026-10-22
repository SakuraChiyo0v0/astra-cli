/**
 * B 站音频下载的"一条龙"：转码 → 写标签 → 内嵌封面。
 *
 * 为什么要做这个：`bili get --audio-only` 原来只给一个裸 m4a —— 没有歌名、没有歌手、没有封面。
 * 放进 Navidrome 或手机播放器里全是「01.m4a」这种，用户得手工转 mp3、补标签、抓封面，
 * 一个视频四步。既然 astra 已经在下载了，这些就不该让人再干一遍。
 *
 * 标签来源（都用平台能给的**原值**，不推测）：
 * - title   = 视频标题（分 P 时用分 P 名，因为那才是"这首"的名字）
 * - artist  = UP 主
 * - album   = UP 主名（同一 UP 的音频归到一个专辑，播放器里好找）
 * - cover   = 视频封面
 *
 * 与音乐域的关系：复用 `music/tags.ts` 的 ID3v2.4 / FLAC 写入，不重复实现。
 */
import { rmSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { AstraError } from '../core/errors.ts'
import { getConfig } from '../core/config.ts'
import { runFfmpeg } from '../media/run.ts'
import { writeTags, type TagData } from '../music/tags.ts'
import type { AudioFormat } from '../music/audio.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

export interface AudioTagInfo {
  /** "这首"的名字：单 P 用视频标题，多 P 用分 P 名。 */
  title: string
  uploader: string
  coverUrl: string | null
  /** 可选，写进 date。 */
  pubdate?: number | null
  /** 来源标记（bvid），写进 SOURCE_ID —— 日后能追溯回原视频。 */
  bvid?: string | null
  /**
   * 专辑名，写进 TALB。
   *
   * 不传时用 UP 主名（老行为）。用户会把同一个 UP 的作品按大类分专辑
   * （`O叔流行` / `O叔古典` / `O叔现场`），靠专辑标签在播放器里分组 ——
   * 否则 300 多首全堆在 `oskarpianist` 一个专辑下没法看。
   */
  album?: string | null
}

export interface AudioPipelineOptions {
  /** 输入：刚合出来的 m4a / 原始音频流。 */
  source: string
  /** 最终输出路径（扩展名决定格式）。 */
  output: string
  info: AudioTagInfo
  signal?: AbortSignal
}

export interface AudioPipelineResult {
  output: string
  format: AudioFormat
  tagged: boolean
  coverEmbedded: boolean
  warnings: string[]
}

/** 下载封面。取不到不算失败 —— 没封面只是不完整，不是坏文件。 */
async function fetchCover(url: string, signal?: AbortSignal): Promise<{ mime: string; data: Buffer } | null> {
  try {
    const response = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: signal ?? undefined })
    if (!response.ok) return null
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length === 0 || data.length > 8 * 1024 * 1024) return null
    // 按魔数判类型，不信 content-type
    const isPng = data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    return { mime: isPng ? 'image/png' : 'image/jpeg', data }
  } catch {
    return null
  }
}

/**
 * 把音频转成目标格式并写标签。
 *
 * 只支持 mp3 / flac —— 与 `music/tags.ts` 的写标签能力保持一致。
 * 用户设了 m4a 时只转码不写标签，并如实告诉他原因。
 */
export async function processBiliAudio(options: AudioPipelineOptions): Promise<AudioPipelineResult> {
  const { source, output, info } = options
  const warnings: string[] = []
  const configured = getConfig('music.ffmpeg')
  const ext = output.toLowerCase().split('.').pop() ?? ''
  const wantTag = getConfig('bili.tag') !== 'false'

  // 1) 转码
  if (ext === 'mp3') {
    const bitrate = getConfig('bili.audio-bitrate') || '320'
    const result = await runFfmpeg(configured, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
      '-vn', '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, output,
    ], options.signal)
    if (result.code !== 0) throw new AstraError('FFMPEG_FAILED', `转 mp3 失败：${result.stderr.trim().slice(0, 200)}`, { exitCode: 5 })
  } else if (ext === 'flac') {
    const result = await runFfmpeg(configured, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
      '-vn', '-c:a', 'flac', output,
    ], options.signal)
    if (result.code !== 0) throw new AstraError('FFMPEG_FAILED', `转 flac 失败：${result.stderr.trim().slice(0, 200)}`, { exitCode: 5 })
  } else if (source !== output) {
    // m4a 之类：只复制
    const result = await runFfmpeg(configured, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-vn', '-c:a', 'copy', output], options.signal)
    if (result.code !== 0) throw new AstraError('FFMPEG_FAILED', `音频复制失败：${result.stderr.trim().slice(0, 200)}`, { exitCode: 5 })
  }

  const written = await stat(output).catch(() => null)
  if (!written || written.size === 0) {
    throw new AstraError('FFMPEG_NO_OUTPUT', '转码报告成功但没有产出文件', { exitCode: 5 })
  }

  // 2) 写标签（只有 mp3 / flac 支持）
  const format: AudioFormat = ext === 'mp3' ? 'mp3' : ext === 'flac' ? 'flac' : ext === 'm4a' ? 'm4a' : 'unknown'
  let tagged = false
  let coverEmbedded = false
  if (!wantTag) {
    return { output, format, tagged, coverEmbedded, warnings }
  }
  if (format !== 'mp3' && format !== 'flac') {
    warnings.push(`${ext} 格式暂不支持写标签；想要完整元信息请设 \`bili.audio-format mp3\``)
    return { output, format, tagged, coverEmbedded, warnings }
  }

  let cover: TagData['cover'] = null
  if (info.coverUrl) {
    cover = await fetchCover(info.coverUrl, options.signal)
    if (!cover) warnings.push('封面下载失败，只写了文字标签')
  }

  const tags: TagData = {
    title: info.title,
    artists: [info.uploader].filter(Boolean),
    album: info.album || info.uploader || null,
    albumArtists: [info.uploader].filter(Boolean),
    date: info.pubdate ? new Date(info.pubdate * 1000).toISOString().slice(0, 10) : null,
    trackNo: null,
    trackTotal: null,
    discNo: null,
    publisher: null,
    lyrics: null,
    cover,
    source: { platform: 'bilibili', id: info.bvid ?? info.title },
    // 音频一旦离开下载目录，`SOURCE_ID` 这种自定义键名播放器不显示，用户想回原视频
    // 只能靠记忆。把 BV 号单独写成一个人人看得懂的字段 + 一条能直接点开的链接。
    extra: info.bvid ? { BILIBILI_BVID: info.bvid, BILIBILI_URL: `https://www.bilibili.com/video/${info.bvid}` } : undefined,
  }
  try {
    const result = await writeTags(output, format, tags)
    tagged = result.written
    coverEmbedded = result.written && cover !== null
    if (!result.written && result.reason) warnings.push(result.reason)
  } catch (err) {
    warnings.push(`写标签失败：${(err as Error).message.slice(0, 150)}`)
  }

  return { output, format, tagged, coverEmbedded, warnings }
}

/** 输出格式：`bili.audio-format` 决定，非法值退回 mp3。 */
export function audioTargetFormat(): 'mp3' | 'flac' | 'm4a' {
  const value = (getConfig('bili.audio-format') || 'mp3').toLowerCase()
  return value === 'flac' ? 'flac' : value === 'm4a' ? 'm4a' : 'mp3'
}

/** 清掉中间文件，失败时也不留垃圾。 */
export function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    // 忽略
  }
}

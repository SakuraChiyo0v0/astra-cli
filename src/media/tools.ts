/**
 * 媒体处理：对**已经下载到本地**的音视频做常规加工。
 *
 * 为什么单独一个域：B 站下下来的视频经常要"剪一段""只要音频""转个能播的格式"。
 * 让人再开终端敲 ffmpeg 是倒退 —— 这正是 astra 该替用户做的事。
 *
 * 设计原则（与下载一致）：
 * - **默认不覆盖**：输出已存在就报错，除非显式 `--overwrite`
 * - 参数白名单：不接受任意 filter 串，只暴露几种常见操作
 * - 做完回读结果核验（时长 / 编码 / 尺寸），不只看退出码
 */
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { AstraError, invalidInput } from '../core/errors.ts'
import { getConfig } from '../core/config.ts'
import { probe, type ProbeResult } from '../bili/ffmpeg.ts'
import { runFfmpeg, runFfprobe } from './run.ts'

export interface MediaInfo extends ProbeResult {
  path: string
  bytes: number
  /** 容器格式。 */
  format: string | null
  bitrateKbps: number | null
  hasVideo: boolean
  hasAudio: boolean
  sampleRate: number | null
  /** 画面宽高（只有视频有）。 */
  fps: number | null
}

/** 读一个媒体文件的实际情况。 */
export async function mediaInfo(file: string, signal?: AbortSignal): Promise<MediaInfo> {
  const configured = getConfig('music.ffmpeg')
  const exists = await stat(file).catch(() => null)
  if (!exists) throw new AstraError('NOT_FOUND', `文件不存在：${file}`, { exitCode: 4 })

  const result = await runFfprobe(configured, [
    '-v', 'error',
    '-show_entries', 'format=duration,bit_rate,format_name',
    '-show_entries', 'stream=codec_type,codec_name,width,height,sample_rate,avg_frame_rate',
    '-of', 'json', file,
  ], signal, 60_000)
  if (result.code !== 0) throw new AstraError('FFPROBE_FAILED', `读不出媒体信息：${result.stderr.trim().slice(0, 200)}`, { exitCode: 5 })

  type Stream = { codec_type?: string; codec_name?: string; width?: number; height?: number; sample_rate?: string; avg_frame_rate?: string }
  const parsed = JSON.parse(result.stdout) as { format?: { duration?: string; bit_rate?: string; format_name?: string }; streams?: Stream[] }
  const video = parsed.streams?.find((s) => s.codec_type === 'video')
  const audio = parsed.streams?.find((s) => s.codec_type === 'audio')
  const fpsRaw = video?.avg_frame_rate?.split('/')
  const fps = fpsRaw && fpsRaw.length === 2 && Number(fpsRaw[1]) > 0 ? Number(fpsRaw[0]) / Number(fpsRaw[1]) : null

  return {
    path: path.resolve(file),
    bytes: exists.size,
    format: parsed.format?.format_name ?? null,
    durationSec: parsed.format?.duration ? Number(parsed.format.duration) : null,
    bitrateKbps: parsed.format?.bit_rate ? Math.round(Number(parsed.format.bit_rate) / 1000) : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    fps: fps !== null && Number.isFinite(fps) ? Math.round(fps * 100) / 100 : null,
  }
}

/**
 * 输出路径检查。
 *
 * 两条铁律：
 * 1. **输出绝不能等于输入** —— 否则 `--overwrite` 会把源文件毁掉（实测踩过：
 *    抽音轨时扩展名推断出错，输出路径回落到源文件，配合 overwrite 直接把原视频截成了 5 秒）。
 * 2. 默认不覆盖已存在的文件，除非显式要求。
 */
async function ensureWritable(output: string, overwrite: boolean, input?: string): Promise<void> {
  const resolved = path.resolve(output)
  if (input !== undefined && resolved === path.resolve(input)) {
    throw new AstraError('OUTPUT_IS_INPUT', `输出路径和源文件相同：${resolved}`, {
      exitCode: 2,
      hint: '换个 --out；这个操作不会原地改写源文件',
    })
  }
  await mkdir(path.dirname(resolved), { recursive: true })
  if (overwrite) return
  const exists = await stat(resolved).catch(() => null)
  if (exists) {
    throw new AstraError('OUTPUT_EXISTS', `输出已存在：${resolved}`, {
      exitCode: 2,
      hint: '换个输出路径，或用 --overwrite 覆盖',
    })
  }
}

/** 解析 `12.5` / `00:01:30` / `1:30` 这类时间。 */
export function parseTime(text: string): number {
  const trimmed = text.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  const parts = trimmed.split(':').map(Number)
  if (parts.some((x) => !Number.isFinite(x) || x < 0)) throw invalidInput(`时间格式不对：${text}`, '支持 12.5 / 1:30 / 00:01:30.5')
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!
  throw invalidInput(`时间格式不对：${text}`, '支持 12.5 / 1:30 / 00:01:30.5')
}

function formatTime(seconds: number): string {
  return `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}.${String(Math.round((seconds % 1) * 1000)).padStart(3, '0')}`
}

export interface ExtractAudioOptions {
  input: string
  output?: string
  /** aac / mp3 / flac / copy。默认按扩展名推断。 */
  format?: string
  bitrateKbps?: number
  overwrite?: boolean
  signal?: AbortSignal
}

/** 抽音轨。视频里本来就是 aac 时直接 copy，避免二次有损。 */
export async function extractAudio(options: ExtractAudioOptions): Promise<{ output: string; info: MediaInfo }> {
  const info = await mediaInfo(options.input, options.signal)
  if (!info.hasAudio) throw new AstraError('NO_AUDIO_STREAM', `${path.basename(options.input)} 里没有音频流`, { exitCode: 4 })

  // 没指定格式时按源的音频编码推断，**不能拿源文件的容器扩展名**（.mp4 不是音频格式，
  // 用它会导致输出路径和输入相同，直接被"不覆盖"拦住）
  const inferred = info.audioCodec === 'flac' ? 'flac' : info.audioCodec === 'mp3' ? 'mp3' : 'm4a'
  const format = (options.format ?? inferred).toLowerCase()
  const ext = format === 'aac' ? 'm4a' : format === 'copy' ? 'm4a' : format
  const output = options.output ?? options.input.replace(/\.[^.]+$/, `.${ext}`)
  await ensureWritable(output, options.overwrite === true, options.input)

  const codec = format
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', options.input, '-vn']
  if (codec === 'flac') {
    args.push('-c:a', 'flac')
  } else if (codec === 'mp3') {
    args.push('-c:a', 'libmp3lame', '-b:a', `${options.bitrateKbps ?? 320}k`)
  } else if (codec === 'copy') {
    args.push('-c:a', 'copy')
  } else {
    // aac：源本来就是 aac 且没指定码率时直接 copy
    if (info.audioCodec === 'aac' && options.bitrateKbps === undefined) args.push('-c:a', 'copy')
    else args.push('-c:a', 'aac', '-b:a', `${options.bitrateKbps ?? 192}k`)
  }
  args.push(output)

  const result = await runFfmpeg(getConfig('music.ffmpeg'), args, options.signal)
  if (result.code !== 0) throw new AstraError('FFMPEG_FAILED', `抽音轨失败：${result.stderr.trim().slice(0, 300)}`, { exitCode: 5 })
  return { output, info: await mediaInfo(output, options.signal) }
}

export interface CutOptions {
  input: string
  /** 起点（秒）。 */
  start?: number
  /** 终点（秒）；与 duration 二选一。 */
  end?: number
  duration?: number
  output?: string
  /** true = 不重编码（快，但切点只能落在关键帧上）。 */
  copy?: boolean
  overwrite?: boolean
  signal?: AbortSignal
}

/** 裁剪一段时间。默认重编码，保证切点精确。 */
export async function cut(options: CutOptions): Promise<{ output: string; info: MediaInfo; warnings: string[] }> {
  const source = await mediaInfo(options.input, options.signal)
  const warnings: string[] = []
  if (options.start === undefined && options.end === undefined && options.duration === undefined) {
    throw invalidInput('至少要给 --start / --end / --duration 之一')
  }
  if (options.end !== undefined && options.duration !== undefined) throw invalidInput('--end 与 --duration 不能同时给')
  const start = options.start ?? 0
  if (options.end !== undefined && options.end <= start) throw invalidInput('--end 必须大于 --start')
  if (options.duration !== undefined && options.duration <= 0) throw invalidInput('--duration 必须是正数')
  if (source.durationSec !== null && start >= source.durationSec) {
    throw invalidInput(`--start ${start} 秒超过了视频长度 ${Math.round(source.durationSec)} 秒`)
  }

  const ext = path.extname(options.input)
  const output = options.output ?? options.input.replace(new RegExp(`${ext.replace('.', '\\.')}$`), `.cut${ext}`)
  await ensureWritable(output, options.overwrite === true, options.input)

  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  // -ss 放前面（快速定位），-i 之后再用 -t 限制长度
  if (start > 0) args.push('-ss', formatTime(start))
  args.push('-i', options.input)
  if (options.duration !== undefined) args.push('-t', String(options.duration))
  else if (options.end !== undefined) args.push('-t', String(options.end - start))
  if (options.copy === true) {
    args.push('-c', 'copy')
    args.push('-avoid_negative_ts', 'make_zero')
    warnings.push('用了 -c copy，切点会对齐到关键帧，可能比请求的稍长/稍短')
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k')
  }
  args.push(output)

  const result = await runFfmpeg(getConfig('music.ffmpeg'), args, options.signal)
  if (result.code !== 0) throw new AstraError('FFMPEG_FAILED', `裁剪失败：${result.stderr.trim().slice(0, 300)}`, { exitCode: 5 })
  return { output, info: await mediaInfo(output, options.signal), warnings }
}

export interface TranscodeOptions {
  input: string
  output?: string
  /** 目标格式：mp4 / mkv / webm。 */
  format?: string
  /** 缩放到这个宽度（保持比例，偶数对齐）。 */
  width?: number
  /** 视频码率（kbps）；不给用 CRF。 */
  videoBitrateKbps?: number
  overwrite?: boolean
  signal?: AbortSignal
}

/** 转封装 / 转码。尺寸不变且容器兼容时用 copy。 */
export async function transcode(options: TranscodeOptions): Promise<{ output: string; info: MediaInfo; warnings: string[] }> {
  const source = await mediaInfo(options.input, options.signal)
  const warnings: string[] = []
  const format = (options.format ?? path.extname(options.input).replace('.', '') ?? 'mp4').toLowerCase()
  // 同格式转码（比如只改分辨率）是最常见的用法，输出不能和源同名 —— 加个后缀区分
  const sameFormat = path.extname(options.input).toLowerCase() === `.${format}`
  const output = options.output ?? options.input.replace(/\.[^.]+$/, `${sameFormat ? '.transcoded' : ''}.${format}`)
  await ensureWritable(output, options.overwrite === true, options.input)

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', options.input]
  const needVideoEncode = options.width !== undefined || options.videoBitrateKbps !== undefined || format === 'webm'
  if (options.width !== undefined) {
    if (!Number.isInteger(options.width) || options.width < 16 || options.width > 7680) throw invalidInput('--width 必须是 16..7680 的整数')
    args.push('-vf', `scale=${options.width}:-2`)
  }
  if (needVideoEncode) {
    if (format === 'webm') {
      args.push('-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0')
      args.push('-c:a', 'libopus', '-b:a', '128k')
    } else {
      args.push('-c:v', 'libx264', '-preset', 'medium')
      if (options.videoBitrateKbps !== undefined) args.push('-b:v', `${options.videoBitrateKbps}k`)
      else args.push('-crf', '21')
      args.push('-c:a', 'aac', '-b:a', '192k')
      args.push('-movflags', '+faststart')
    }
  } else {
    // 只换容器，不重编码
    args.push('-c', 'copy')
    warnings.push('只换了容器，没有重新编码')
  }
  args.push(output)

  const result = await runFfmpeg(getConfig('music.ffmpeg'), args, options.signal)
  if (result.code !== 0) throw new AstraError('FFMPEG_FAILED', `转码失败：${result.stderr.trim().slice(0, 300)}`, { exitCode: 5 })
  return { output, info: await mediaInfo(output, options.signal), warnings }
}

export interface ThumbnailOptions {
  input: string
  /** 取哪一秒的画面，默认 1/3 处。 */
  at?: number
  output?: string
  width?: number
  overwrite?: boolean
  signal?: AbortSignal
}

/** 截一帧当封面。 */
export async function thumbnail(options: ThumbnailOptions): Promise<{ output: string; bytes: number; at: number }> {
  const source = await mediaInfo(options.input, options.signal)
  if (!source.hasVideo) throw new AstraError('NO_VIDEO_STREAM', `${path.basename(options.input)} 里没有画面`, { exitCode: 4 })
  const at = options.at ?? (source.durationSec ? Math.max(0, source.durationSec / 3) : 1)
  if (source.durationSec !== null && at >= source.durationSec) throw invalidInput(`--at ${at} 秒超过视频长度 ${Math.round(source.durationSec)} 秒`)
  const output = options.output ?? options.input.replace(/\.[^.]+$/, '.jpg')
  await ensureWritable(output, options.overwrite === true, options.input)
  const width = options.width ?? 0
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', formatTime(at), '-i', options.input,
    '-frames:v', '1',
    ...(width > 0 ? ['-vf', `scale=${width}:-2`] : []),
    '-q:v', '3', output,
  ]
  const result = await runFfmpeg(getConfig('music.ffmpeg'), args, options.signal)
  if (result.code !== 0) throw new AstraError('FFMPEG_FAILED', `截图失败：${result.stderr.trim().slice(0, 300)}`, { exitCode: 5 })
  const written = await stat(output).catch(() => null)
  if (!written || written.size === 0) throw new AstraError('FFMPEG_NO_OUTPUT', 'ffmpeg 报告成功但没有产出文件', { exitCode: 5 })
  return { output, bytes: written.size, at }
}

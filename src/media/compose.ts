/**
 * 组合类操作：拼接、水印。
 *
 * 拼接的坑：`concat` 分两种模式。
 * - **demuxer（`-f concat`）**：文件流参数完全一致时可用，不重编码、快
 * - **filter（`concat` 滤镜）**：参数不一致（分辨率 / 编码不同）时必须重编码
 * 先探测所有输入的参数，一致就 demuxer，否则自动降级到 filter 并明确告知。
 *
 * 水印支持文字与图片两种。文字水印依赖 ffmpeg 的 drawtext（需要 libfreetype），
 * 字体必须显式给出 —— 不给就找一个系统常见的，找不到就报错，不静默失败。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AstraError, invalidInput } from '../core/errors.ts'
import { getConfig } from '../core/config.ts'
import { runFfmpeg } from './run.ts'
import { mediaInfo, type MediaInfo } from './tools.ts'

/** 找得到的中文字体。找不到就让调用方显式传 --font。 */
const CANDIDATE_FONTS = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/System/Library/Fonts/PingFang.ttc',
]

export function pickFont(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null
  return CANDIDATE_FONTS.find((f) => existsSync(f)) ?? null
}

function streamSignature(info: MediaInfo): string {
  return [info.videoCodec, info.width, info.height, info.audioCodec, info.sampleRate].join('|')
}

export interface ConcatOptions {
  inputs: string[]
  output?: string
  /** 强制重编码（输入不一致时会自动开启）。 */
  reencode?: boolean
  overwrite?: boolean
  signal?: AbortSignal
}

export interface ConcatResult {
  output: string
  info: MediaInfo
  /** 用了哪种模式。 */
  mode: 'copy' | 'reencode'
  warnings: string[]
}

/** 拼接多个文件（按顺序）。 */
export async function concat(options: ConcatOptions): Promise<ConcatResult> {
  const { inputs } = options
  if (inputs.length < 2) throw invalidInput('至少需要两个文件才能拼接')
  const warnings: string[] = []

  const infos: MediaInfo[] = []
  for (const file of inputs) infos.push(await mediaInfo(file, options.signal))

  const signatures = new Set(infos.map(streamSignature))
  const consistent = signatures.size === 1
  const needsReencode = options.reencode === true || !consistent
  if (!consistent) {
    const detail = [...signatures].join('  vs  ')
    warnings.push(`输入参数不一致（${detail}），必须重编码；这会慢很多且有一次质量损失`)
  }

  const first = infos[0]!
  const ext = path.extname(inputs[0]!) || '.mp4'
  const output = options.output ?? inputs[0]!.replace(new RegExp(`${ext.replace('.', '\\.')}$`), `.concat${ext}`)
  if (path.resolve(output) === path.resolve(inputs[0]!)) {
    throw new AstraError('OUTPUT_IS_INPUT', '输出路径和第一个输入相同', { exitCode: 2, hint: '换个 --out' })
  }
  if (!options.overwrite && existsSync(output)) {
    throw new AstraError('OUTPUT_EXISTS', `输出已存在：${output}`, { exitCode: 2, hint: '用 --overwrite 或换 --out' })
  }

  const configured = getConfig('music.ffmpeg')
  const args = ['-hide_banner', '-loglevel', 'error', '-y']

  if (!needsReencode) {
    // 参数一致：用 concat demuxer，不重编码
    const dir = mkdtempSync(path.join(tmpdir(), 'astra-concat-'))
    const listFile = path.join(dir, 'list.txt')
    // concat 列表里的单引号要转义成 '\''
    const lines = inputs.map((f) => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`)
    writeFileSync(listFile, lines.join('\n') + '\n', 'utf8')
    try {
      args.push('-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy')
      args.push('-movflags', '+faststart', output)
      const result = await runFfmpeg(configured, args, options.signal)
      if (result.code !== 0) throw new AstraError('FFMPEG_FAILED', `拼接失败：${result.stderr.trim().slice(0, 300)}`, { exitCode: 5 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } else {
    // 参数不一致：用 concat 滤镜。所有输入统一缩放到第一个的分辨率
    for (const file of inputs) args.push('-i', file)
    const width = first.width ?? 1280
    const height = first.height ?? 720
    // 每一路视频都要**统一到同一分辨率与 SAR**，否则 concat 滤镜会报
    // "parameters do not match"（实测踩过：定义了 scale 却没接进链路）。
    // 音频也统一采样率与声道，避免音画不同步。
    const audioRate = first.sampleRate ?? 48000
    const chains: string[] = []
    for (let i = 0; i < inputs.length; i += 1) {
      chains.push(`[${i}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}]`)
      chains.push(`[${i}:a:0]aresample=${audioRate},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`)
    }
    const concatInputs = inputs.map((_, i) => `[v${i}][a${i}]`).join('')
    args.push('-filter_complex', `${chains.join(';')};${concatInputs}concat=n=${inputs.length}:v=1:a=1[v][a]`)
    args.push('-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k')
    args.push(output)
    const result = await runFfmpeg(configured, args, options.signal)
    if (result.code !== 0) throw new AstraError('FFMPEG_FAILED', `拼接失败：${result.stderr.trim().slice(0, 300)}`, { exitCode: 5 })
  }

  return { output, info: await mediaInfo(output, options.signal), mode: needsReencode ? 'reencode' : 'copy', warnings }
}

export type WatermarkPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/**
 * 位置 → drawtext 的 x:y 表达式，留边距。
 *
 * **坑**：`w`/`h` 在 drawtext 里是"文字宽高"，但在通用滤镜表达式里 `w`/`h`
 * 是"画面宽高"，和 `W`/`H` 同义。写成 `W-w-20` 算出来等于 `-20`，水印被推到画面外
 * ——命令返回 0、日志没有任何警告，就是画面上看不见（实测踩过）。
 * 正确变量是 `text_w` / `text_h`。
 */
export function positionExpr(position: WatermarkPosition, margin = 20): string {
  switch (position) {
    case 'top-left': return `${margin}:${margin}`
    case 'top-right': return `W-text_w-${margin}:${margin}`
    case 'bottom-left': return `${margin}:H-text_h-${margin}`
    case 'bottom-right': return `W-text_w-${margin}:H-text_h-${margin}`
    default: return `${margin}:${margin}`
  }
}

export interface WatermarkOptions {
  input: string
  /** 文字水印内容。 */
  text?: string
  /** 图片水印路径（与 text 二选一）。 */
  image?: string
  position?: WatermarkPosition
  /** 透明度 0..1。 */
  opacity?: number
  fontSize?: number
  /** 字体路径；不给则自动找。 */
  font?: string
  output?: string
  overwrite?: boolean
  signal?: AbortSignal
}

/** 加文字或图片水印。 */
export async function watermark(options: WatermarkOptions): Promise<{ output: string; info: MediaInfo; warnings: string[] }> {
  const hasText = typeof options.text === 'string' && options.text.length > 0
  const hasImage = typeof options.image === 'string' && options.image.length > 0
  if (hasText === hasImage) throw invalidInput('文字水印和图片水印二选一：给 --text 或 --image')

  const source = await mediaInfo(options.input, options.signal)
  if (!source.hasVideo) throw new AstraError('NO_VIDEO_STREAM', '这个文件没有画面，加不了水印', { exitCode: 4 })

  const warnings: string[] = []
  const ext = path.extname(options.input) || '.mp4'
  const output = options.output ?? options.input.replace(new RegExp(`${ext.replace('.', '\\.')}$`), `.wm${ext}`)
  if (path.resolve(output) === path.resolve(options.input)) {
    throw new AstraError('OUTPUT_IS_INPUT', '输出路径和输入相同', { exitCode: 2, hint: '换个 --out' })
  }
  if (!options.overwrite && existsSync(output)) {
    throw new AstraError('OUTPUT_EXISTS', `输出已存在：${output}`, { exitCode: 2, hint: '用 --overwrite 或换 --out' })
  }

  const opacity = options.opacity ?? 0.8
  if (opacity < 0 || opacity > 1) throw invalidInput('--opacity 必须在 0..1 之间')
  const position = options.position ?? 'bottom-right'
  const configured = getConfig('music.ffmpeg')
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', options.input]

  if (hasText) {
    const font = pickFont(options.font)
    if (!font) {
      throw new AstraError('NO_FONT', '找不到可用的字体文件', {
        exitCode: 3,
        hint: '用 --font 指定一个 .ttf/.ttc 路径；中文字体推荐 msyh.ttc / Noto Sans CJK',
      })
    }
    const fontSize = options.fontSize ?? Math.max(16, Math.round((source.height ?? 720) / 24))
    // drawtext 的路径与文本都要转义：冒号、反斜杠、单引号是特殊字符
    const escapePath = font.replace(/\\/g, '/').replace(/:/g, '\\:')
    const escapeText = (options.text ?? '').replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
    args.push('-vf', `drawtext=fontfile='${escapePath}':text='${escapeText}':fontsize=${fontSize}:fontcolor=white@${opacity.toFixed(2)}:x=${positionExpr(position).split(':')[0]}:y=${positionExpr(position).split(':')[1]}:box=1:boxcolor=black@0.35:boxborderw=6`)
    warnings.push(`字体：${path.basename(font)}`)
  } else {
    args.push('-i', options.image!)
    const expr = positionExpr(position)
    // 图片水印：先按主画面高度缩放，再叠上去
    const scaleTo = Math.max(24, Math.round((source.height ?? 720) / 12))
    args.push('-filter_complex', `[1:v]scale=-1:${scaleTo},format=rgba,colorchannelmixer=aa=${opacity.toFixed(2)}[wm];[0:v][wm]overlay=${expr}`)
  }

  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'copy', output)
  const result = await runFfmpeg(configured, args, options.signal)
  if (result.code !== 0) throw new AstraError('FFMPEG_FAILED', `加水印失败：${result.stderr.trim().slice(0, 300)}`, { exitCode: 5 })
  return { output, info: await mediaInfo(output, options.signal), warnings }
}

/**
 * 图片竖条解混淆：算分割数 + 用 ffmpeg 重排竖条。
 *
 * 不引入 sharp 等原生依赖 —— Hermes 里只有单文件 astra.mjs，解混淆复用已有的 ffmpeg。
 */
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { AstraError } from '../core/errors.ts'
import { getConfig } from '../core/config.ts'
import { runFfmpeg, runFfprobe } from '../media/run.ts'
import { SCRAMBLE_268850, SCRAMBLE_421926 } from './constants.ts'

/** 与公开实现同一套分割数公式。 */
export function scrambleSliceCount(scrambleId: number, aid: number, filenameStem: string): number {
  if (aid < scrambleId) return 0
  if (aid < SCRAMBLE_268850) return 10
  const x = aid < SCRAMBLE_421926 ? 10 : 8
  const digest = createHash('md5').update(`${aid}${filenameStem}`, 'utf8').digest('hex')
  const num = digest.charCodeAt(digest.length - 1)! % x
  return num * 2 + 2
}

export function filenameStemOf(imgName: string): string {
  const base = imgName.split(/[\\/]/).pop() ?? imgName
  const q = base.indexOf('?')
  const clean = q >= 0 ? base.slice(0, q) : base
  const dot = clean.lastIndexOf('.')
  return dot > 0 ? clean.slice(0, dot) : clean
}

/** 源图竖条 → 目标图竖条的裁剪计划（与 PIL paste 顺序一致）。 */
export function slicePlan(height: number, num: number): { srcY: number; h: number }[] {
  if (num <= 0) return [{ srcY: 0, h: height }]
  const over = height % num
  const plans: { srcY: number; h: number }[] = []
  for (let i = 0; i < num; i += 1) {
    let move = Math.floor(height / num)
    const ySrc = height - move * (i + 1) - over
    if (i === 0) move += over
    plans.push({ srcY: ySrc, h: move })
  }
  return plans
}

async function imageSize(file: string, configured: string, signal?: AbortSignal): Promise<{ width: number; height: number }> {
  const result = await runFfprobe(
    configured,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file],
    signal,
    30_000,
  )
  if (result.code !== 0) {
    throw new AstraError('FFMPEG_FAILED', `ffprobe 读图片尺寸失败：${result.stderr.trim().slice(0, 200)}`, {
      exitCode: 5,
      hint: '漫画解混淆需要 ffmpeg / ffprobe',
    })
  }
  const parsed = JSON.parse(result.stdout) as { streams?: { width?: number; height?: number }[] }
  const stream = parsed.streams?.[0]
  const width = stream?.width
  const height = stream?.height
  if (!width || !height) throw new AstraError('COMIC_BAD_IMAGE', '图片没有有效尺寸', { exitCode: 5 })
  return { width, height }
}

/**
 * 把混淆图写成清晰图。
 *
 * `num === 0` 时直接落盘（不经 ffmpeg）。
 * 输出扩展名跟源文件名走；ffmpeg 按扩展名选编码器。
 */
/**
 * 把临时文件搬到最终路径。
 *
 * **`rename` 不能跨文件系统**：临时目录在容器根分区（`/tmp`），
 * 而落盘目录常是 NAS 挂载点（`/host-root/volume1/...`），
 * 直接 rename 会抛 `EXDEV: cross-device link not permitted`。
 * 这种情况退回「复制 + 删源」，代价是一次额外读写，但路径必须是用户配的那个。
 */
async function moveIntoPlace(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err
    await copyFile(from, to)
    await rm(from, { force: true })
  }
}

export async function descrambleToFile(options: {
  scrambled: Buffer
  scrambleId: number
  aid: number
  imgName: string
  outputPath: string
  signal?: AbortSignal
}): Promise<{ slices: number }> {
  const stem = filenameStemOf(options.imgName)
  const num = scrambleSliceCount(options.scrambleId, options.aid, stem)
  const configured = getConfig('music.ffmpeg')
  await mkdir(path.dirname(options.outputPath), { recursive: true })

  if (num === 0) {
    await writeFile(options.outputPath, options.scrambled)
    return { slices: 0 }
  }

  const work = path.join(tmpdir(), `astra-comic-${process.pid}-${randomBytes(4).toString('hex')}`)
  await mkdir(work, { recursive: true })
  const ext = path.extname(options.imgName).split('?')[0] || '.jpg'
  const src = path.join(work, `src${ext}`)
  const dst = path.join(work, `dst${ext}`)
  try {
    await writeFile(src, options.scrambled)
    const { width, height } = await imageSize(src, configured, options.signal)
    const plans = slicePlan(height, num)
    const splits = plans.map((_, i) => `[s${i}]`).join('')
    // 先转 rgb24 再裁：YUV 的色度抽样会在接缝处留一条亮线。
    const crops = plans
      .map((p, i) => `[s${i}]crop=${width}:${p.h}:0:${p.srcY}:exact=1[c${i}]`)
      .join(';')
    const stackInputs = plans.map((_, i) => `[c${i}]`).join('')
    const filter = `[0:v]format=rgb24,split=${num}${splits};${crops};${stackInputs}vstack=inputs=${num}[out]`
    const result = await runFfmpeg(
      configured,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', src,
        '-filter_complex', filter,
        '-map', '[out]',
        // 无损，避免二次压缩把接缝又压出来
        '-c:v', 'libwebp', '-lossless', '1',
        dst,
      ],
      options.signal,
      120_000,
    )
    if (result.code !== 0) {
      throw new AstraError('FFMPEG_FAILED', `解混淆失败：${result.stderr.trim().slice(0, 300)}`, {
        exitCode: 5,
        hint: '确认 ffmpeg 能解码 webp/jpg',
      })
    }
    await moveIntoPlace(dst, options.outputPath)
    return { slices: num }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

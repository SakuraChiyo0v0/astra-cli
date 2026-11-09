/**
 * ffmpeg / ffprobe 执行器（B 站、媒体处理、漫画、小说共用）。
 *
 * 0.53.0 从 media/run.ts 搬到 core：多个领域都在用，放在某个领域里会让领域之间互相依赖。
 *
 * 只做三件事：起进程、收输出、把失败变成带人话的 AstraError。
 * 不判断"成功与否的业务含义" —— 那是调用方的事（比如 ffmpeg 报 0 但没产出文件也算失败）。
 */
import { spawn } from 'node:child_process'
import { AstraError } from './errors.ts'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export function ffmpegPath(configured: string): string {
  return configured.trim() || 'ffmpeg'
}

/** 配了绝对路径时，ffprobe 通常和 ffmpeg 同目录。 */
export function ffprobePath(configured: string): string {
  const ffmpeg = ffmpegPath(configured)
  if (ffmpeg.includes('/') || ffmpeg.includes('\\')) return ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, 'ffprobe'))
  return 'ffprobe'
}

export function runBinary(bin: string, args: string[], signal?: AbortSignal, timeoutMs = 600_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL')
        reject(new AstraError('FFMPEG_TIMEOUT', `${bin} 超过 ${Math.round(timeoutMs / 1000)} 秒没结束`, { exitCode: 5, retryable: true }))
      })
    }, timeoutMs)
    const onAbort = (): void => {
      finish(() => {
        child.kill('SIGKILL')
        reject(new AstraError('CANCELLED', '已取消', { exitCode: 130 }))
      })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (err) => {
      finish(() => reject(new AstraError('FFMPEG_MISSING', `找不到 ${bin}：${err.message}`, {
        exitCode: 3,
        hint: '装 ffmpeg，或用 `astra config set music.ffmpeg <绝对路径>` 指定',
      })))
    })
    child.on('close', (code) => {
      finish(() => resolve({ code: code ?? -1, stdout, stderr }))
    })
  })
}

export function runFfmpeg(configured: string, args: string[], signal?: AbortSignal, timeoutMs?: number): Promise<RunResult> {
  return runBinary(ffmpegPath(configured), args, signal, timeoutMs)
}

export function runFfprobe(configured: string, args: string[], signal?: AbortSignal, timeoutMs = 60_000): Promise<RunResult> {
  return runBinary(ffprobePath(configured), args, signal, timeoutMs)
}

export interface ProbeResult {
  durationSec: number | null
  videoCodec: string | null
  audioCodec: string | null
  width: number | null
  height: number | null
}

/** 读实际时长与流信息，判断成品是不是正常。 */
export async function probe(file: string, configured: string, signal?: AbortSignal): Promise<ProbeResult> {
  const result = await runFfprobe(configured, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', file], signal, 60_000)
  if (result.code !== 0) {
    // ffprobe 不在时不让整个下载失败：返回空，调用方当作"未知"
    return { durationSec: null, videoCodec: null, audioCodec: null, width: null, height: null }
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      format?: { duration?: string }
      streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[]
    }
    const video = parsed.streams?.find((s) => s.codec_type === 'video')
    const audio = parsed.streams?.find((s) => s.codec_type === 'audio')
    return {
      durationSec: parsed.format?.duration ? Number(parsed.format.duration) : null,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      width: video?.width ?? null,
      height: video?.height ?? null,
    }
  } catch {
    return { durationSec: null, videoCodec: null, audioCodec: null, width: null, height: null }
  }
}

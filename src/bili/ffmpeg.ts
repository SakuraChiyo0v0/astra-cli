/**
 * ffmpeg 调用。
 *
 * B 站的 DASH 把视频流和音频流分开给，**必须合并**才能得到一个正常播放的文件。
 * 不合并的话得到的是只有画面没声音的 mp4，或者要用户自己装播放器折腾。
 *
 * 也用它读时长/编码做下载后的核验 —— 与音乐那边"只信实测"的原则一致。
 */
import { spawn } from 'node:child_process'
import { AstraError } from '../core/errors.ts'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export function ffmpegPath(configured: string): string {
  return configured.trim() || 'ffmpeg'
}

export function ffprobePath(configured: string): string {
  const ffmpeg = ffmpegPath(configured)
  // 配了绝对路径时，ffprobe 通常在同目录
  if (ffmpeg.includes('/') || ffmpeg.includes('\\')) return ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, 'ffprobe'))
  return 'ffprobe'
}

function run(bin: string, args: string[], signal?: AbortSignal, timeoutMs = 300_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new AstraError('FFMPEG_TIMEOUT', `${bin} 超过 ${Math.round(timeoutMs / 1000)} 秒没结束`, { exitCode: 5, retryable: true }))
    }, timeoutMs)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(new AstraError('CANCELLED', '已取消', { exitCode: 130 }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new AstraError('FFMPEG_MISSING', `找不到 ${bin}：${err.message}`, {
        exitCode: 3,
        hint: '装 ffmpeg，或用 `astra config set music.ffmpeg <绝对路径>` 指定',
      }))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** 把分轨的音视频合成一个文件。`-c copy` 不重编码，快且无损。 */
export async function mux(video: string, audio: string | null, output: string, configured: string, signal?: AbortSignal): Promise<void> {
  const bin = ffmpegPath(configured)
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  args.push('-i', video)
  if (audio) args.push('-i', audio)
  args.push('-c', 'copy', '-map', '0:v:0')
  if (audio) args.push('-map', '1:a:0')
  // mp4 里放不了某些 codec 的原生封装（例如 AV1 的某些 annexb），有明显兼容问题就转封装
  args.push('-movflags', '+faststart', output)
  const result = await run(bin, args, signal)
  if (result.code !== 0) {
    throw new AstraError('FFMPEG_FAILED', `ffmpeg 合并失败（退出码 ${result.code}）：${result.stderr.trim().slice(0, 300)}`, { exitCode: 5 })
  }
}

/** 只提取音轨（用于 --audio-only）。 */
export async function extractAudio(input: string, output: string, configured: string, signal?: AbortSignal): Promise<void> {
  const bin = ffmpegPath(configured)
  // 音频流本来就是 m4a(aac) 时直接 copy，不是就转 aac
  const result = await run(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-c:a', 'copy', output], signal)
  if (result.code === 0) return
  const transcode = await run(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-c:a', 'aac', '-b:a', '192k', output], signal)
  if (transcode.code !== 0) {
    throw new AstraError('FFMPEG_FAILED', `ffmpeg 提取音轨失败：${transcode.stderr.trim().slice(0, 300)}`, { exitCode: 5 })
  }
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
  const bin = ffprobePath(configured)
  const result = await run(bin, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', file], signal, 60_000)
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

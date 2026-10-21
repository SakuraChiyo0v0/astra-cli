/**
 * ffmpeg / ffprobe 执行器（B 站合并与媒体处理共用）。
 *
 * 只做三件事：起进程、收输出、把失败变成带人话的 AstraError。
 * 不判断"成功与否的业务含义" —— 那是调用方的事（比如 ffmpeg 报 0 但没产出文件也算失败）。
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

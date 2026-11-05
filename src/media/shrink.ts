/**
 * 按目标体积压视频（"压到 30MB 以内发得出去"），可选设备。
 *
 * 与 `media transcode` 的区别：那边是「改格式/分辨率」，这边是「给定体积上限，自己挑码率」，
 * 并且可以在别的设备上跑（PC 在线就用 PC，不在就用本机）。
 */
import { spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { AstraError, invalidInput } from '../core/errors.ts'
import { loadStore, mapPath, pickDevice } from '../device/store.ts'
import type { Device } from '../device/types.ts'
import { mediaInfo, type MediaInfo } from './tools.ts'

export interface ShrinkOptions {
  input: string
  output?: string
  /** 目标体积（MB），默认 28（飞书单条上限 30MB） */
  targetMb?: number
  /** auto / 设备名 */
  device?: string
  /** 起始高度，缺省按源视频高度（不超过 1080） */
  maxHeight?: number
  signal?: AbortSignal
}

interface ShrinkResult {
  output: string
  device: string
  fallback: boolean
  bytes: number
  height: number
  bitrateKbps: number
  info: MediaInfo
}

function run(argv: string[], timeoutMs = 900_000): Promise<{ code: number; out: string; err: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (b) => { out += String(b) })
    child.stderr.on('data', (b) => { err += String(b) })
    const finish = (code: number) => {
      clearTimeout(timer)
      resolve({ code, out, err, ms: Date.now() - started })
    }
    child.on('close', (code) => finish(code ?? -1))
    child.on('error', (exc) => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: String(exc), ms: Date.now() - started })
    })
  })
}

function sshTarget(device: Device): string {
  return device.user ? `${device.user}@${device.host}` : String(device.host)
}

function sshArgs(device: Device, timeoutConnect = 8): string[] {
  return ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeoutConnect}`, sshTarget(device)]
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** 算一档码率：目标体积留 8% 余量，扣掉音轨。 */
export function bitrateForTarget(targetMb: number, durationSec: number, audioKbps = 96): number {
  if (!(durationSec > 0)) return 1500          // 时长不明时给个保守默认，别算出天文数字
  const budgetKbps = (targetMb * 8 * 1024) / durationSec
  const kbps = Math.floor(budgetKbps * 0.92 - audioKbps)
  return Math.min(20000, Math.max(120, kbps))
}

/** 高度阶梯：从源高度往下退，最高 1080。 */
export function heightLadder(sourceHeight: number | null, maxHeight = 1080): number[] {
  const start = Math.min(sourceHeight && sourceHeight > 0 ? sourceHeight : maxHeight, maxHeight)
  const ladder = [start, 1080, 720, 480].filter((h) => h <= start && h >= 240)
  return [...new Set(ladder)].sort((a, b) => b - a)
}

function ffmpegArgs(input: string, output: string, height: number, bitrateKbps: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-vf', `scale=-2:${height}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${bitrateKbps}k`,
    '-maxrate', `${Math.floor(bitrateKbps * 1.3)}k`, '-bufsize', `${bitrateKbps * 2}k`,
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
    output,
  ]
}

async function runLocal(input: string, output: string, height: number, bitrate: number) {
  const r = await run(['ffmpeg', ...ffmpegArgs(input, output, height, bitrate)])
  if (r.code !== 0) throw new AstraError('FFMPEG_FAILED', `转码失败：${r.err.trim().slice(0, 300)}`, { exitCode: 5 })
}

async function runRemote(device: Device, input: string, output: string, height: number, bitrate: number) {
  const tmp = device.tmpDir ?? '/tmp'
  const stamp = `${Date.now()}`
  const remoteIn = mapPath(device, `${tmp}/astra-in-${stamp}${path.extname(input)}`)
  const remoteOut = mapPath(device, `${tmp}/astra-out-${stamp}.mp4`)

  // 1) 传过去
  const up = await run(['scp', input, `${sshTarget(device)}:${remoteIn}`], 600_000)
  if (up.code !== 0) throw new AstraError('DEVICE_TRANSFER_FAILED', `上传到 ${device.name} 失败：${up.err.trim().slice(0, 200)}`, { exitCode: 5 })

  // 2) 远端跑 ffmpeg（POSIX shell 引用；Windows 上需要设备装 bash 或改为 PowerShell 包装）
  const remoteCmd = ['ffmpeg', ...ffmpegArgs(remoteIn, remoteOut, height, bitrate)].map(shellQuote).join(' ')
  const enc = await run(['ssh', ...sshArgs(device), remoteCmd], 900_000)
  if (enc.code !== 0) {
    await run(['ssh', ...sshArgs(device), ['rm', '-f', shellQuote(remoteIn)].join(' ')], 30_000)
    throw new AstraError('FFMPEG_FAILED', `${device.name} 转码失败：${enc.err.trim().slice(0, 300)}`, { exitCode: 5 })
  }

  // 3) 取回来
  const down = await run(['scp', `${sshTarget(device)}:${remoteOut}`, output], 600_000)
  await run(['ssh', ...sshArgs(device), ['rm', '-f', shellQuote(remoteIn), shellQuote(remoteOut)].join(' ')], 30_000)
  if (down.code !== 0) throw new AstraError('DEVICE_TRANSFER_FAILED', `从 ${device.name} 取回失败：${down.err.trim().slice(0, 200)}`, { exitCode: 5 })
}

export async function shrink(options: ShrinkOptions, signal?: AbortSignal): Promise<ShrinkResult> {
  const targetMb = options.targetMb ?? 28
  if (!(targetMb > 1 && targetMb <= 2048)) throw invalidInput('--target-mb 应在 1..2048 之间')

  const source = await mediaInfo(options.input, signal)
  const duration = Number(source.durationSec ?? 0)
  if (!duration) throw invalidInput('读不到时长，没法按体积压', '换 --width/--bitrate 走 media transcode')

  const out = options.output ?? options.input.replace(/\.[^.]+$/, '.small.mp4')
  await mkdir(path.dirname(path.resolve(out)), { recursive: true })

  // 设备选择：auto 只挑装了 ffmpeg 的；具体失败再降级
  const store = loadStore()
  let device: Device | null = null
  const wanted = (options.device ?? 'auto').trim()
  if (wanted !== 'auto') {
    device = store.devices[wanted] ?? null
    if (!device) throw invalidInput(`没有这个设备：${wanted}`, `已登记：${Object.keys(store.devices).join(', ')}`)
  } else {
    const online: Record<string, boolean> = {}
    for (const d of Object.values(store.devices)) {
      if (d.kind === 'local') { online[d.name] = true; continue }
      const probe = d.probe || 'true'
      const r = await run(['ssh', ...sshArgs(d, 5), probe], 15_000)
      online[d.name] = r.code === 0
    }
    device = pickDevice(store, { requires: ['ffmpeg'], online }) ?? store.devices.nas ?? null
  }

  const targetBytes = targetMb * 1024 * 1024
  const heights = heightLadder(Number(source.height ?? 0) || null, options.maxHeight ?? 1080)
  let lastError: unknown = null
  let fallback = false

  for (const [idx, height] of heights.entries()) {
    for (const candidate of [device, store.devices.nas].filter((d): d is Device => Boolean(d))) {
      const bitrate = bitrateForTarget(targetMb, duration)
      try {
        if (candidate.kind === 'ssh') await runRemote(candidate, options.input, out, height, bitrate)
        else await runLocal(options.input, out, height, bitrate)
        const st = await stat(out)
        if (st.size <= targetBytes * 1.02) {
          return {
            output: out, device: candidate.name, fallback: fallback || idx > 0,
            bytes: st.size, height, bitrateKbps: bitrate, info: await mediaInfo(out, signal),
          }
        }
        fallback = true // 还是太大 → 降到下一档
      } catch (error) {
        lastError = error
        fallback = true
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new AstraError('SHRINK_FAILED', `压不到 ${targetMb}MB 以内`, { exitCode: 5 })
}

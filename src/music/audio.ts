/**
 * 音质实测：只信字节，不信档位名、URL 后缀、Content-Type。
 *
 * 实测（2026-10-21，qdy）：请求 flac / 24bit 时，对网易云普遍拿到 128k MP3；
 * 有的"直链"是 404 的 php 页面，内容是 HTML。所以拿到地址后必须先探测。
 */
import { open } from 'node:fs/promises'
import { httpRequest } from '../core/http.ts'

export type AudioFormat = 'flac' | 'mp3' | 'm4a' | 'ogg' | 'unknown'
export type Quality = '128k' | '320k' | 'flac' | '24bit'
export const QUALITY_ORDER: readonly Quality[] = ['24bit', 'flac', '320k', '128k']

export function isQuality(value: string): value is Quality {
  return (QUALITY_ORDER as readonly string[]).includes(value)
}

export function detectFormat(head: Buffer): AudioFormat {
  if (head.length < 4) return 'unknown'
  const magic = head.subarray(0, 4).toString('latin1')
  if (magic === 'fLaC') return 'flac'
  if (magic === 'OggS') return 'ogg'
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return 'm4a'
  if (magic.startsWith('ID3')) {
    // ID3 后面也可能包着 FLAC（少见但见过），跳过标签头再看一次
    const size = ((head[6]! & 0x7f) << 21) | ((head[7]! & 0x7f) << 14) | ((head[8]! & 0x7f) << 7) | (head[9]! & 0x7f)
    const after = head.subarray(10 + size, 14 + size).toString('latin1')
    if (after === 'fLaC') return 'flac'
    return 'mp3'
  }
  if (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return 'mp3'
  return 'unknown'
}

export interface FlacInfo { sampleRate: number; channels: number; bitsPerSample: number; totalSamples: number }

export function parseFlacStreamInfo(head: Buffer): FlacInfo | null {
  const start = head.indexOf('fLaC', 0, 'latin1')
  if (start < 0 || head.length < start + 8 + 34) return null
  if ((head[start + 4]! & 0x7f) !== 0) return null
  const p = head.subarray(start + 8, start + 8 + 34)
  const sampleRate = (p[10]! << 12) | (p[11]! << 4) | (p[12]! >> 4)
  const channels = ((p[12]! >> 1) & 0x07) + 1
  const bitsPerSample = (((p[12]! & 0x01) << 4) | (p[13]! >> 4)) + 1
  const totalSamples = (p[13]! & 0x0f) * 2 ** 32 + ((p[14]! << 24) >>> 0) + (p[15]! << 16) + (p[16]! << 8) + p[17]!
  return { sampleRate, channels, bitsPerSample, totalSamples }
}

/** 由实测反推档位。宁可低估：算不出码率时按 128k。 */
export function inferQuality(format: AudioFormat, bps: number | null, flac: FlacInfo | null): Quality {
  if (format === 'flac') return flac && (flac.bitsPerSample > 16 || flac.sampleRate > 48_000) ? '24bit' : 'flac'
  if (bps !== null && bps >= 250_000) return '320k'
  return '128k'
}

export function qualityRank(q: Quality): number {
  return QUALITY_ORDER.indexOf(q)
}

/** actual 是否达到 requested。 */
export function qualitySatisfied(requested: Quality, actual: Quality): boolean {
  return qualityRank(actual) <= qualityRank(requested)
}

export interface Probe {
  format: AudioFormat
  bytes: number | null
  bps: number | null
  quality: Quality
  flac: FlacInfo | null
  /** 不可用时的原因。 */
  problem: string | null
}

export function summarize(head: Buffer, totalBytes: number | null, durationMs: number | null): Probe {
  const format = detectFormat(head)
  const flac = format === 'flac' ? parseFlacStreamInfo(head) : null
  let seconds = durationMs && durationMs > 0 ? durationMs / 1000 : null
  if (flac && flac.totalSamples > 0 && flac.sampleRate > 0) seconds = flac.totalSamples / flac.sampleRate
  const bps = seconds && totalBytes && totalBytes > 0 ? Math.round((totalBytes * 8) / seconds) : null
  const problem = format === 'unknown' ? describeNonAudio(head) : null
  return { format, bytes: totalBytes, bps, quality: inferQuality(format, bps, flac), flac, problem }
}

function describeNonAudio(head: Buffer): string {
  const text = head.subarray(0, 200).toString('utf8').trim()
  if (/^<(!doctype|html|head)/i.test(text)) return '返回的是网页而不是音频'
  if (text.startsWith('{')) return `返回的是 JSON：${text.slice(0, 80)}`
  if (head.length === 0) return '返回内容为空'
  return '无法识别的音频格式'
}

/** 远程探测：只拉前 64KB（够放下 ID3 + 封面前的 FLAC 头）。 */
export async function probeUrl(url: string, durationMs: number | null, signal?: AbortSignal): Promise<Probe & { status: number }> {
  const options: Parameters<typeof httpRequest>[1] = { headers: { Range: 'bytes=0-65535' }, timeoutMs: 15_000, retries: 1 }
  if (signal) options.signal = signal
  const response = await httpRequest(url, options)
  const status = response.status
  if (status >= 400) {
    await response.body?.cancel()
    return { format: 'unknown', bytes: null, bps: null, quality: '128k', flac: null, problem: `直链返回 HTTP ${status}`, status }
  }
  const head = Buffer.from(await response.arrayBuffer()).subarray(0, 65536)
  const range = response.headers.get('content-range')
  const total = range?.match(/\/(\d+)$/)?.[1]
  const length = response.headers.get('content-length')
  const totalBytes = total ? Number(total) : status === 200 && length ? Number(length) : null
  return { ...summarize(head, totalBytes, durationMs), status }
}

export async function probeFile(file: string, durationMs: number | null): Promise<Probe> {
  const handle = await open(file, 'r')
  try {
    const head = Buffer.alloc(65536)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    const { size } = await handle.stat()
    return summarize(head.subarray(0, bytesRead), size, durationMs)
  } finally {
    await handle.close()
  }
}

export function extensionFor(format: AudioFormat): string {
  return format === 'unknown' ? 'bin' : format
}

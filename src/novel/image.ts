/**
 * 图片整理：按魔数认格式，JPEG / PNG 原样用，其它（WebP、AVIF、GIF…）交给 ffmpeg 转 JPEG。
 *
 * 不看扩展名和 Content-Type：站上常把 WebP 叫成 `.jpg`，老阅读器拿到会当坏图。
 * 下载回来的若是 HTML（图床返回的 404 页），直接丢掉。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getConfig } from '../core/config.ts'
import { runFfmpeg } from '../core/ffmpeg.ts'
import type { EpubImage } from './epub.ts'

export function sniff(data: Buffer): 'jpeg' | 'png' | 'gif' | 'webp' | 'html' | 'other' {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg'
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1'))) return 'gif'
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  const head = data.subarray(0, 64).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase()
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) return 'html'
  return 'other'
}

/** 转成阅读器都认的格式；转不了返回 null（调用方记 warning，不让整本失败）。 */
export async function toEpubImage(data: Buffer, signal?: AbortSignal): Promise<EpubImage | null> {
  const kind = sniff(data)
  if (kind === 'jpeg') return { data, mediaType: 'image/jpeg' }
  if (kind === 'png') return { data, mediaType: 'image/png' }
  if (kind === 'html') return null
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-novel-'))
  try {
    const input = path.join(dir, 'in')
    const output = path.join(dir, 'out.jpg')
    await writeFile(input, data)
    const result = await runFfmpeg(getConfig('music.ffmpeg'), ['-v', 'error', '-y', '-i', input, '-frames:v', '1', '-q:v', '3', output], signal, 60_000)
    if (result.code !== 0) return null
    const out = await readFile(output)
    return sniff(out) === 'jpeg' ? { data: out, mediaType: 'image/jpeg' } : null
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * 落盘：视频流式写 `.part` 再 rename，图文并发下原图。
 *
 * CDN 直链不需要 cookie，带 `Referer: https://www.douyin.com/` 就行（实测 206 + Range）。
 * 大文件绝不 `Buffer.concat`：容器只有 7GB，单个视频最高见过 500MB+。
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { httpRequest } from '../core/http.ts'
import { AstraError } from '../core/errors.ts'
import { progress } from '../core/output.ts'
import { DOUYIN_UA } from './sign.ts'
import { pickGear, type DouyinItem, type Gear, type Quality } from './model.ts'
import { findExisting, imageDir, imagePath, videoPath } from './paths.ts'

export interface DownloadOptions {
  root: string
  quality?: Quality
  force?: boolean
  concurrency?: number
  signal?: AbortSignal
}

export interface VideoOutcome {
  status: 'downloaded' | 'already_have'
  path: string
  bytes: number
  gear: string | null
  codec: 'h264' | 'h265' | null
  /** h265 档没有音轨，为了能看还是下了，但得告诉用户。 */
  audio: boolean
  warnings: string[]
}

export interface ImageOutcome {
  status: 'downloaded' | 'already_have'
  dir: string
  images: number
  bytes: number
  warnings: string[]
}

async function streamToFile(url: string, target: string, signal?: AbortSignal): Promise<number> {
  const response = await httpRequest(url, {
    headers: {
      'User-Agent': DOUYIN_UA,
      Accept: '*/*',
      Referer: 'https://www.douyin.com/',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    timeoutMs: 180_000,
    ...(signal ? { signal } : {}),
  })
  if (!response.ok || !response.body) {
    throw new AstraError('DOUYIN_MEDIA_FAILED', `下载失败：HTTP ${response.status}`, {
      exitCode: 5,
      retryable: response.status >= 500 || response.status === 403,
      hint: '直链有时效（几小时）；重新解析一次再下',
      details: { status: response.status },
    })
  }
  const part = `${target}.part`
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(part))
    const size = statSync(part).size
    const expected = Number(response.headers.get('content-length') ?? 0)
    if (expected > 0 && size !== expected) {
      throw new AstraError('DOUYIN_MEDIA_TRUNCATED', `下载不完整：${size}/${expected} 字节`, {
        exitCode: 5,
        retryable: true,
        hint: '重试一次；还短就是网络断了',
      })
    }
    renameSync(part, target)
    return size
  } catch (err) {
    rmSync(part, { force: true })
    throw err
  }
}

export async function downloadVideo(item: DouyinItem, options: DownloadOptions): Promise<VideoOutcome> {
  const warnings: string[] = []
  const existing = options.force ? null : findExisting(options.root, item.id)
  if (existing) {
    return { status: 'already_have', path: existing, bytes: statSync(existing).size, gear: null, codec: null, audio: true, warnings }
  }
  const gear = pickGear(item.gears, options.quality ?? 'best')
  if (!gear) {
    throw new AstraError('DOUYIN_NO_SOURCE', '这条作品没有可下载的视频流', {
      exitCode: 4,
      hint: '可能是图文作品（用 `astra douyin get` 会自动按图文下）或作品已不可见',
      details: { awemeId: item.id },
    })
  }
  if (gear.h265) {
    warnings.push('这条只有 h265 档：文件没有音轨（抖音的 h265 档是纯视频流），需要声音得另找 h264 版本')
  }
  const target = videoPath(options.root, item)
  mkdirSync(options.root, { recursive: true })
  progress('douyin.video', { id: item.id, gear: gear.name, height: gear.height, mb: Math.round(gear.bytes / 1048576) })
  const bytes = await streamToFile(gear.url, target, options.signal)
  return {
    status: 'downloaded',
    path: target,
    bytes,
    gear: gear.name,
    codec: gear.h265 ? 'h265' : 'h264',
    audio: !gear.h265,
    warnings,
  }
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}

export async function downloadImages(item: DouyinItem, options: DownloadOptions): Promise<ImageOutcome> {
  const dir = imageDir(options.root, item)
  const existingFiles = existsSync(dir) ? readdirSync(dir).filter((n) => /\.(jpe?g|png|webp|heic)$/i.test(n)).length : 0
  if (!options.force && existingFiles >= item.images.length && item.images.length > 0) {
    return { status: 'already_have', dir, images: existingFiles, bytes: 0, warnings: [] }
  }
  mkdirSync(dir, { recursive: true })
  const concurrency = Math.max(1, Math.min(6, options.concurrency ?? 3))
  let total = 0
  await mapPool(item.images, concurrency, async (image, index) => {
    options.signal?.throwIfAborted()
    const target = imagePath(dir, index, image.url)
    if (!options.force && existsSync(target)) {
      total += statSync(target).size
      return
    }
    progress('douyin.image', { id: item.id, page: index + 1, total: item.images.length })
    total += await streamToFile(image.url, target, options.signal)
  })
  return { status: 'downloaded', dir, images: item.images.length, bytes: total, warnings: [] }
}

export async function downloadItem(item: DouyinItem, options: DownloadOptions): Promise<VideoOutcome | ImageOutcome> {
  return item.kind === 'image' ? downloadImages(item, options) : downloadVideo(item, options)
}

/** 文案里给用户看的档位（`--quality` 之外想知道实际拿了什么）。 */
export function describeGear(gear: Gear): string {
  return `${gear.name} ${gear.height}p ${Math.round(gear.bitrate / 1000)}kbps`
}

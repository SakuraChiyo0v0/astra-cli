/**
 * 把抖音的原始响应拍平成我们自己用的形状，并挑档。
 *
 * 两条实测出来的规矩：
 * 1. **h265 档只有视频流、没有音轨**（ffprobe 实测：`1080_1_1` 只有 hevc 一路）；
 *    `normal_1080_0` 这类 h264 才是 aac+h264 合并好的单文件。所以默认只选 h264。
 * 2. **图文的原图在 `url_list` 最后一个**（前两个是 `q75.webp`），
 *    `download_url_list` 是 `tplv-dy-water-v2` 的带水印版，不能用。
 */
import type { RawAweme } from './api.ts'

export type Quality = 'best' | '1080p' | '720p' | '540p' | 'small'

export interface Gear {
  name: string
  bitrate: number
  bytes: number
  url: string
  width: number
  height: number
  h265: boolean
  fps: number | null
}

export interface ImageAsset {
  url: string
  width: number
  height: number
}

export interface DouyinItem {
  id: string
  kind: 'video' | 'image'
  title: string
  author: string
  authorId: string
  createTime: number | null
  durationSec: number | null
  cover: string | null
  gears: Gear[]
  images: ImageAsset[]
  /** 背景音乐（图文作品的 `video.play_addr` 其实就是这首 mp3）。 */
  music: { title: string; url: string } | null
  stats: Record<string, number>
}

function firstUrl(list: string[] | undefined): string | null {
  for (const url of list ?? []) {
    if (url && !url.startsWith('http://')) return url
  }
  return (list ?? [])[0] ?? null
}

/** 图文原图：最后一个 url 才是无水印 jpeg，前面都是 webp 缩略。 */
export function originalImageUrl(urls: string[] | undefined): string | null {
  const usable = (urls ?? []).filter((u) => typeof u === 'string' && u.length > 0)
  return usable.length > 0 ? usable[usable.length - 1]! : null
}

export function normalizeAweme(raw: RawAweme): DouyinItem {
  const video = raw.video ?? {}
  const gears: Gear[] = []
  for (const entry of video.bit_rate ?? []) {
    const addr = entry.play_addr ?? {}
    const url = firstUrl(addr.url_list)
    if (!url) continue
    gears.push({
      name: entry.gear_name ?? 'unknown',
      bitrate: Number(entry.bit_rate ?? 0),
      bytes: Number(addr.data_size ?? 0),
      url,
      width: Number(addr.width ?? video.width ?? 0),
      height: Number(addr.height ?? video.height ?? 0),
      h265: Number(entry.is_h265 ?? 0) === 1,
      fps: entry.FPS === undefined ? null : Number(entry.FPS),
    })
  }
  // 没有档位表时退回默认 play_addr（实测也是无水印，但编码未知）
  if (gears.length === 0) {
    const url = firstUrl(video.play_addr?.url_list)
    if (url) {
      gears.push({
        name: 'default',
        bitrate: 0,
        bytes: Number(video.play_addr?.data_size ?? 0),
        url,
        width: Number(video.width ?? 0),
        height: Number(video.height ?? 0),
        h265: false,
        fps: null,
      })
    }
  }

  const images: ImageAsset[] = []
  for (const img of raw.images ?? []) {
    const url = originalImageUrl(img.url_list)
    if (!url) continue
    images.push({ url, width: Number(img.width ?? 0), height: Number(img.height ?? 0) })
  }

  const musicUrl = firstUrl(raw.music?.play_url?.url_list)
  const id = String(raw.aweme_id ?? '')

  return {
    id,
    kind: images.length > 0 ? 'image' : 'video',
    title: (raw.desc ?? '').trim(),
    author: raw.author?.nickname ?? '',
    authorId: raw.author?.sec_uid ?? raw.author?.unique_id ?? '',
    createTime: raw.create_time ?? null,
    durationSec: video.duration ? Math.round(video.duration / 1000) : null,
    cover: firstUrl(video.origin_cover?.url_list) ?? firstUrl(video.cover?.url_list),
    gears,
    images,
    music: raw.music && musicUrl ? { title: raw.music.title ?? '', url: musicUrl } : null,
    stats: raw.statistics ?? {},
  }
}

const QUALITY_CAP: Record<Quality, number> = {
  best: Number.POSITIVE_INFINITY,
  '1080p': 1080,
  '720p': 720,
  '540p': 576,
  small: 360,
}

/**
 * 挑档：只要 h264（有音轨），按高度降序、码率降序取第一个。
 *
 * `small` 取最低档（省流量）。没有 h264 档时退回 h265 并靠调用方给 warning ——
 * 那种文件没有声音，值得提醒，但比“什么都没有”强。
 */
export function pickGear(gears: Gear[], quality: Quality = 'best'): Gear | null {
  if (gears.length === 0) return null
  const cap = QUALITY_CAP[quality] ?? Number.POSITIVE_INFINITY
  const muxed = gears.filter((g) => !g.h265 && g.height > 0 && g.height <= cap)
  const pool = muxed.length > 0 ? muxed : gears.filter((g) => g.height > 0 && g.height <= cap)
  const candidates = pool.length > 0 ? pool : gears
  const sorted = [...candidates].sort((a, b) => (b.height - a.height) || (b.bitrate - a.bitrate))
  if (quality === 'small') {
    const bySize = [...candidates].sort((a, b) => (a.height - b.height) || (a.bitrate - b.bitrate))
    return bySize.find((g) => g.bytes > 0) ?? bySize[0] ?? null
  }
  return sorted.find((g) => g.bytes > 0) ?? sorted[0] ?? null
}

/** 给用户看的档位摘要（去重同名档）。 */
export function summarizeGears(gears: Gear[]): { name: string; height: number; bitrate: number; mb: number; codec: 'h264' | 'h265'; audio: boolean }[] {
  const seen = new Set<string>()
  const out: { name: string; height: number; bitrate: number; mb: number; codec: 'h264' | 'h265'; audio: boolean }[] = []
  for (const gear of [...gears].sort((a, b) => (b.height - a.height) || (b.bitrate - a.bitrate))) {
    const key = `${gear.name}:${gear.bitrate}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name: gear.name,
      height: gear.height,
      bitrate: gear.bitrate,
      mb: Math.round((gear.bytes / 1024 / 1024) * 10) / 10,
      codec: gear.h265 ? 'h265' : 'h264',
      audio: !gear.h265,
    })
  }
  return out
}

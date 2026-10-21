/**
 * 取一首歌的可下载直链：路线（网易云 → 酷我同曲）× 音源 × 档位从高到低，每个结果都实测。
 *
 * 规则：
 * - 档位名不可信，返回的是**实测**档位；请求的档位没达到就标 `downgraded`
 * - 拿到的地址先探测：HTTP 错误 / 网页 / 空 → 这一次失败，换下一个
 * - 同一个源对不同档位给的是**同一个文件**时（实测 qdy 对网易云常这样），不再往下试
 * - 第一个"达到请求档位"的结果立刻返回；都达不到时返回实测最好的那个
 * - 酷我只在网易云路线没达到请求档位时才去找，且必须是同一首歌（见 kuwo.ts 的匹配规则）
 *
 * 实测（2026-10-21，qdy）：网易云路线普遍只有 128k，周杰伦等直接 404；
 * 酷我路线请求 flac 能拿到真 FLAC。所以默认请求 flac 时两条路线都会走到。
 */
import { AstraError } from '../core/errors.ts'
import { progress } from '../core/output.ts'
import { loadEnabledSources } from '../lx/store.ts'
import type { LoadedLxSource, LxMusicInfo } from '../lx/host.ts'
import type { LxSourceRecord } from '../lx/store.ts'
import { probeUrl, qualityRank, qualitySatisfied, type Probe, type Quality } from './audio.ts'
import { findOnKuwo } from './kuwo.ts'
import type { Track } from './netease.ts'

export interface ResolvedUrl {
  url: string
  sourceId: string
  /** 音频走的是哪个平台：wy 网易云 / kw 酷我（同曲）。 */
  route: 'wy' | 'kw'
  requested: Quality
  probe: Probe
  downgraded: boolean
}

/** 档位 → 各音源常见的写法。`24bit` 有的脚本叫 `flac24bit`。 */
function qualityAliases(q: Quality, declared: string[]): string[] {
  const wanted = q === '24bit' ? ['24bit', 'flac24bit', 'hires'] : [q]
  const hit = wanted.filter((w) => declared.includes(w))
  return hit.length > 0 ? hit : declared.length === 0 ? wanted : []
}

export function ladder(requested: Quality): Quality[] {
  const order: Quality[] = ['24bit', 'flac', '320k', '128k']
  return order.slice(order.indexOf(requested))
}

export function musicInfoOf(track: Track): LxMusicInfo {
  return {
    source: 'wy',
    name: track.title,
    singer: track.artists.join('、'),
    albumName: track.album ?? '',
    songmid: track.id,
    hash: track.id,
    id: track.id,
    interval: Math.round((track.durationMs ?? 0) / 1000),
  }
}

/** a 是否比 b 好：先比档位，同档位比码率。 */
export function better(a: Probe, b: Probe | undefined): boolean {
  if (!b) return true
  const ra = qualityRank(a.quality)
  const rb = qualityRank(b.quality)
  if (ra !== rb) return ra < rb
  return (a.bps ?? 0) > (b.bps ?? 0)
}

interface Route {
  platform: 'wy' | 'kw'
  info: LxMusicInfo
}

type Loaded = { record: LxSourceRecord; source: LoadedLxSource }

async function tryRoute(
  route: Route,
  sources: Loaded[],
  requested: Quality,
  track: Track,
  attempts: string[],
  state: { best: ResolvedUrl | null },
  signal?: AbortSignal,
): Promise<ResolvedUrl | null> {
  for (const { record, source } of sources) {
    const declared = source.sources[route.platform]?.qualitys
    if (!declared) continue
    // 只有"能用的"地址才记下来去重：坏地址（404 等）换档位后可能指向别的东西，不能据此提前放弃
    const seenUrls = new Set<string>()
    for (const q of ladder(requested)) {
      if (state.best && qualityRank(q) > qualityRank(state.best.probe.quality)) break
      for (const alias of qualityAliases(q, declared)) {
        if (signal?.aborted) throw new AstraError('CANCELLED', '已取消', { exitCode: 130 })
        const tag = `${route.platform}/${record.id}/${alias}`
        let url: string
        try {
          url = await source.musicUrl(route.platform, alias, route.info)
        } catch (err) {
          attempts.push(`${tag}: ${(err as Error).message.slice(0, 160)}`)
          continue
        }
        // CDN 直链的路径就是文件身份；带 level 参数的 php 网关要连 query 一起比
        const key = /\.php$/i.test(url.split('?')[0]!) ? url : url.split('?')[0]!
        if (seenUrls.has(key)) {
          attempts.push(`${tag}: 与更高档位是同一个文件`)
          break
        }
        let probe: Probe & { status: number }
        try {
          probe = await probeUrl(url, track.durationMs, signal)
        } catch (err) {
          attempts.push(`${tag}: 探测失败 ${(err as Error).message}`)
          continue
        }
        if (probe.problem) {
          attempts.push(`${tag}: ${probe.problem}`)
          continue
        }
        seenUrls.add(key)
        attempts.push(`${tag}: ${probe.format} ${probe.quality}${probe.bps ? ` ${Math.round(probe.bps / 1000)}kbps` : ''}`)
        progress('music.url', { route: route.platform, source: record.id, asked: alias, got: probe.quality, format: probe.format, bytes: probe.bytes })
        const candidate: ResolvedUrl = {
          url, sourceId: record.id, route: route.platform, requested, probe, downgraded: !qualitySatisfied(requested, probe.quality),
        }
        if (!candidate.downgraded) return candidate
        if (better(probe, state.best?.probe)) state.best = candidate
        break
      }
    }
  }
  return null
}

export async function resolveUrl(track: Track, requested: Quality, signal?: AbortSignal): Promise<ResolvedUrl> {
  const { loaded, failed } = await loadEnabledSources()
  if (loaded.length === 0) {
    const why = failed.length > 0 ? `：${failed.map((f) => `${f.id} ${f.error}`).join('；')}` : ''
    throw new AstraError('NO_SOURCE', `没有可用的音源${why}`, {
      exitCode: 3,
      hint: '让用户提供洛雪音源脚本（.js），用 `astra music source add <文件>` 导入',
    })
  }
  const attempts: string[] = []
  const state: { best: ResolvedUrl | null } = { best: null }

  const wy = await tryRoute({ platform: 'wy', info: musicInfoOf(track) }, loaded, requested, track, attempts, state, signal)
  if (wy) return wy

  if (loaded.some((l) => l.source.sources.kw)) {
    let hit = null
    try {
      hit = await findOnKuwo(track, signal)
    } catch (err) {
      attempts.push(`kw: 搜索失败 ${(err as Error).message}`)
    }
    if (hit) {
      const info: LxMusicInfo = {
        source: 'kw', name: track.title, singer: track.artists.join('、'), albumName: hit.album ?? '',
        songmid: hit.rid, hash: hit.rid, id: hit.rid, interval: hit.durationSec ?? Math.round((track.durationMs ?? 0) / 1000),
      }
      const kw = await tryRoute({ platform: 'kw', info }, loaded, requested, track, attempts, state, signal)
      if (kw) return kw
    } else {
      attempts.push('kw: 没找到确定是同一首的歌')
    }
  }

  if (state.best) return state.best
  throw new AstraError('NO_PLAYABLE_URL', `所有音源都没拿到「${track.title}」的可用音频`, {
    exitCode: 5,
    retryable: true,
    hint: '可能是版权受限或音源接口失效。可以稍后重试、换一个版本（专辑 / 单曲），或导入别的音源',
    details: { attempts, failedSources: failed },
  })
}

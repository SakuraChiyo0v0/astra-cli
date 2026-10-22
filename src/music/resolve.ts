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
import { normalize } from './match.ts'
import type { Track } from './netease.ts'
import { officialUrl } from './official.ts'

export interface ResolvedUrl {
  url: string
  sourceId: string
  /** 音频走的是哪个平台：wy 网易云 / kw 酷我（同曲）。 */
  route: 'wy' | 'kw'
  requested: Quality
  probe: Probe
  downgraded: boolean
  /** 官方取链时，官方声明的档位（可能比实测高）。 */
  officialLevel?: Quality | null
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

/**
 * 探测出的真实时长与网易云记录差多少秒（只有 FLAC 能从头部精确算出；其它格式返回 null 表示不知道）。
 *
 * 实测（2026-10-21，NAS 上）：アイドル 的酷我"同曲"FLAC 是 261 秒，网易云记录 213 秒 —— 酷我搜索结果里
 * 写的 DURATION 是 213，但直链指向的是另一个版本。只信搜索结果的时长不够，要在拿到文件头后再核一次。
 */
export function durationGap(probe: Probe, track: Track): number | null {
  if (!probe.flac || probe.flac.sampleRate <= 0 || probe.flac.totalSamples <= 0 || !track.durationMs) return null
  return Math.abs(probe.flac.totalSamples / probe.flac.sampleRate - track.durationMs / 1000)
}

export const MAX_DURATION_GAP_SECONDS = 10

/**
 * 文件自带标题和要的歌明显不是一首时返回自带标题，否则 null。
 * 去掉附注后互不包含才判不同，并且也和网易云的别名 / 译名比一遍（自带标签可能用的是中文译名）。
 */
export function identityMismatch(probe: Probe, track: Track): string | null {
  const title = probe.embedded?.title
  // 读不到标题时判「没问题」。两种情况读不到：文件本来就没标签，或者只探测了前 64KB
  // 而大封面（B 站的实测 148KB）把 TIT2 挤到了后面 —— 后者意味着我们对这首歌的身份
  // **一无所知**。一无所知时必须放行：这道关是拦「明显是另一首歌」用的，
  // 不是「不能证明是这首就拒」—— 反过来会把大量正常音源挡掉。
  if (!title) return null
  const got = normalize(title.replace(/[(（[【].*?[)）\]】]/g, ''))
  const candidates = [track.title, ...track.aliases, ...track.translations].map((t) => normalize(t.replace(/[(（[【].*?[)）\]】]/g, ''))).filter(Boolean)
  if (!got || candidates.length === 0) return null
  if (candidates.some((want) => got.includes(want) || want.includes(got))) return null
  // 歌手对得上也不放过：实测的错链就是同一歌手的另一首歌
  return title
}

/**
 * a 是否比 b 好。排序依据（从重要到次要）：
 *   1. 档位（24bit > flac > 320k > 128k）
 *   2. 同为无损时看**母带规格**：采样率高的优先，再看位深（96k/24 > 48k/24 > 44.1k/16）
 *   3. 码率高的
 *   4. FLAC 优先于其它格式
 *
 * 只看码率会选错：44.1kHz 的一首 FLAC 平均码率可能比 48kHz 的高，但规格更低。
 */
export function better(a: Probe, b: Probe | undefined): boolean {
  if (!b) return true
  const ra = qualityRank(a.quality)
  const rb = qualityRank(b.quality)
  if (ra !== rb) return ra < rb
  const sa = a.flac?.sampleRate ?? 0
  const sb = b.flac?.sampleRate ?? 0
  if (sa !== sb) return sa > sb
  const ba = a.flac?.bitsPerSample ?? 0
  const bb = b.flac?.bitsPerSample ?? 0
  if (ba !== bb) return ba > bb
  const pa = a.bps ?? 0
  const pb = b.bps ?? 0
  if (pa !== pb) return pa > pb
  return a.format === 'flac' && b.format !== 'flac'
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
  // 音源路线同样往最高档问：只要比现有的好就收，跑不过现有档位就停
  for (const { record, source } of sources) {
    const declared = source.sources[route.platform]?.qualitys
    if (!declared) continue
    // 只有"能用的"地址才记下来去重：坏地址（404 等）换档位后可能指向别的东西，不能据此提前放弃
    const seenUrls = new Set<string>()
    let rejected = false
    for (const q of ladder('24bit')) {
      if (rejected) break
      // 现有的已经比这一档还高，再问没意义
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
        const otherSong = identityMismatch(probe, track)
        if (otherSong !== null) {
          attempts.push(`${tag}: 文件自带标题是「${otherSong}」，不是这首歌，放弃这条路线`)
          progress('music.url.rejected', { route: route.platform, source: record.id, reason: 'identity', embeddedTitle: otherSong })
          rejected = true
          break
        }
        const gap = durationGap(probe, track)
        if (gap !== null && gap > MAX_DURATION_GAP_SECONDS) {
          // 不是同一个版本。同一个音源对同一个 id 的其它档位也是这个版本（实测 320k MP3 同样 261 秒），
          // 整条路线放弃，换下一个音源 / 路线
          attempts.push(`${tag}: 时长差 ${Math.round(gap)} 秒，不是同一版本，放弃这条路线`)
          progress('music.url.rejected', { route: route.platform, source: record.id, reason: 'duration', gapSeconds: Math.round(gap) })
          rejected = true
          break
        }
        seenUrls.add(key)
        attempts.push(`${tag}: ${probe.format} ${probe.quality}${probe.bps ? ` ${Math.round(probe.bps / 1000)}kbps` : ''}`)
        progress('music.url', { route: route.platform, source: record.id, asked: alias, got: probe.quality, format: probe.format, bytes: probe.bytes })
        const candidate: ResolvedUrl = {
          url, sourceId: record.id, route: route.platform, requested, probe, downgraded: !qualitySatisfied(requested, probe.quality),
        }
        if (better(probe, state.best?.probe)) state.best = candidate
        break
      }
    }
  }
  return null
}

export async function resolveUrl(track: Track, requested: Quality, signal?: AbortSignal): Promise<ResolvedUrl> {
  const attempts: string[] = []
  const state: { best: ResolvedUrl | null } = { best: null }

  // 1) 官方取链（用户自己的账号）。拿到就最干净，VIP 还能给无损
  try {
    const official = await officialUrl(track, requested, signal)
    if ('skip' in official) {
      attempts.push(`official: ${official.skip}`)
    } else {
      const candidate: ResolvedUrl = {
        url: official.url,
        // 标签里直接写清楚"这是官方给的"，用户在结果里一眼能看出来
        sourceId: 'official',
        route: 'wy',
        requested,
        probe: official.probe,
        downgraded: !qualitySatisfied(requested, official.probe.quality),
        officialLevel: official.level,
      }
      if (better(candidate.probe, state.best?.probe)) state.best = candidate
      // 官方已经给到 24bit 就是天花板了，不用再问音源
      if (official.probe.quality === '24bit') return candidate
    }
  } catch (err) {
    attempts.push(`official: ${(err as Error).message.slice(0, 160)}`)
  }

  // 2) 洛雪音源：网易云路线，再酷我同曲路线
  const { loaded, failed } = await loadEnabledSources()
  if (loaded.length === 0) {
    if (state.best) return state.best
    const why = failed.length > 0 ? `：${failed.map((f) => `${f.id} ${f.error}`).join('；')}` : ''
    throw new AstraError('NO_SOURCE', `没有可用的音源${why}`, {
      exitCode: 3,
      hint: '让用户提供洛雪音源脚本（.js），用 `astra music source add <文件>` 导入；或在 `astra music login start` 登录后走官方通道',
    })
  }

  await tryRoute({ platform: 'wy', info: musicInfoOf(track) }, loaded, requested, track, attempts, state, signal)

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
      await tryRoute({ platform: 'kw', info }, loaded, requested, track, attempts, state, signal)
    } else {
      attempts.push('kw: 没找到确定是同一首的歌')
    }
  }

  if (state.best) return state.best
  throw new AstraError('NO_PLAYABLE_URL', `所有音源都没拿到「${track.title}」的可用音频`, {
    exitCode: 5,
    retryable: true,
    hint: '官方账号和音源都给不出地址（版权下架 / 地区限制最常见）。可以稍后重试、换用同曲的其它专辑版本（get 结果里的 otherVersions），或导入别的音源',
    details: { attempts, failedSources: failed },
  })
}

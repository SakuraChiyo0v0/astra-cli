/**
 * 官方取链（用用户自己的账号）。取链路线的第一优先。
 *
 * 为什么优先：这是网易云官方给这个账号签发的地址，比第三方音源干净，VIP 账号能拿到无损 / Hi-Res。
 * 实测（2026-10-21，VIP 账号）：
 * - `GET /api/song/enhance/player/url?ids=[id]&br=999000` 带会话 cookie → `data[0].url` 有值，
 *   `level` 为 lossless、`type` 为 flac、`size` 86MB
 * - **刚签发的地址立刻请求可能 403**，隔一会儿再请求就正常（测了两轮：第一次全 403，第二次全 200）
 * - 匿名时同一端点 `url` 恒为 null、`code` 仍 200 —— 所以"有 code 200"不代表拿得到，必须看 url
 * - 未登录 / 无版权 / 已下架的曲目 `url` 也是 null，这不是错误，是"这条路走不通"
 *
 * 账号不给地址时不算失败，只是这条路线跳过，交给洛雪音源。
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { loadSession, type Session } from './auth.ts'
import { probeUrl, qualityRank, qualitySatisfied, type Probe, type Quality } from './audio.ts'
import type { Track } from './netease.ts'
import { progress } from '../core/output.ts'

const ORIGIN = 'https://music.163.com'
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) NeteaseMusicDesktop/2.3.17.1034'

/** 请求档位 → 官方 `br` 参数。 */
const QUALITY_TO_BR: Record<Quality, number> = { '24bit': 1999000, flac: 999000, '320k': 320000, '128k': 128000 }

/** 官方 `level` → 我们的档位。判不准时交给实测。 */
const LEVEL_TO_QUALITY: Record<string, Quality> = {
  standard: '128k',
  higher: '128k',
  exhigh: '320k',
  lossless: 'flac',
  hires: '24bit',
  jyeffect: '320k',
  sky: '320k',
  jymaster: '24bit',
}

interface OfficialRow {
  id?: number
  url?: string | null
  br?: number
  size?: number
  type?: string | null
  level?: string | null
  fee?: number
  code?: number
  freeTrialInfo?: unknown
  message?: string | null
}

export interface OfficialUrl {
  url: string
  probe: Probe
  /** 官方声明的档位（实测优先）。 */
  level: Quality
  size: number | null
}

function sessionOrNull(): Session | null {
  return loadSession()
}

/** 官方接口给一句人话，说明为什么没地址。 */
function reasonFor(row: OfficialRow): string {
  if (row.freeTrialInfo) return '只有试听片段（会员 / 购买限制）'
  if (row.fee === 1) return 'VIP 曲目，当前账号拿不到完整地址'
  if (row.fee === 4) return '需要购买专辑'
  if (row.message) return row.message
  return '没给播放地址（可能下架 / 地区限制 / 会话失效）'
}

/**
 * 向官方要一次地址，并一路往最高档位找。
 *
 * 实测（2026-10-21）：同一首歌请求 320k 与请求 flac 拿到的是**不同文件**，
 * 所以不能"拿到就收"：要按 24bit → flac 的顺序问，官方给什么就是最高给什么。
 * 请求档位只在**用户明确要低档**时才限制上限。
 *
 * 返回 `{skip}` 表示这条路走不通（无版权 / 未登录 / 下架），不是错误。
 */
export async function officialUrl(track: Track, requested: Quality, signal?: AbortSignal): Promise<OfficialUrl | { skip: string }> {
  const session = sessionOrNull()
  if (!session) return { skip: '未登录' }
  // 从最高档问起：官方按 br 给不同的文件，问低了只会拿到低档。
  // 第一次拿到地址就是官方能给的最高档（再往下只会更低），直接返回。
  const ladder: Quality[] = (['24bit', 'flac', '320k', '128k'] as Quality[]).filter((q) => qualityRank(q) >= qualityRank(requested))
  let firstSkip: string | null = null
  for (const q of ladder) {
    const result = await askOfficial(track, q, signal)
    if ('skip' in result) {
      firstSkip ??= result.skip
      continue
    }
    return result
  }
  return { skip: firstSkip ?? '官方没有可用地址' }
}

/** 问一个具体档位。 */
async function askOfficial(track: Track, requested: Quality, signal?: AbortSignal): Promise<OfficialUrl | { skip: string }> {
  const session = sessionOrNull()
  if (!session) return { skip: '未登录' }
  const br = QUALITY_TO_BR[requested]
  const options: Parameters<typeof httpRequest>[1] = {
    headers: { 'user-agent': DESKTOP_UA, referer: `${ORIGIN}/`, cookie: session.cookie },
    timeoutMs: 12_000,
    retries: 1,
  }
  if (signal) options.signal = signal
  const response = await httpRequest(`${ORIGIN}/api/song/enhance/player/url?ids=${encodeURIComponent(`[${track.id}]`)}&br=${br}`, options)
  if (!response.ok) throw new AstraError('OFFICIAL_HTTP', `官方取链返回 HTTP ${response.status}`, { exitCode: 5, retryable: true })
  const body = (await response.json()) as { code?: number; data?: OfficialRow[] }
  const row = body.data?.[0]
  if (!row) return { skip: '官方接口没有返回数据' }
  if (!row.url) return { skip: reasonFor(row) }

  // 刚签发的地址立刻请求容易 403，退避重试几次；仍不行就当作这条路暂时不通
  const url = row.url.replace(/^http:/, 'https:')
  let probe: Probe | null = null
  let lastProblem = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
    try {
      const result = await probeUrl(url, track.durationMs, signal)
      if (result.problem === null) {
        probe = result
        break
      }
      lastProblem = result.problem
    } catch (err) {
      lastProblem = (err as Error).message
    }
  }
  if (!probe) return { skip: `官方地址取不到内容（${lastProblem}）` }

  const declared = row.level && LEVEL_TO_QUALITY[row.level] ? LEVEL_TO_QUALITY[row.level] : null
  // 官方说无损但实测只有 128k 时，以实测为准
  const level = declared && qualitySatisfied(declared, probe.quality) ? declared : probe.quality
  progress('music.official', { id: track.id, asked: requested, declared: row.level ?? null, actual: probe.quality, format: probe.format, bytes: probe.bytes })
  return { url, probe, level, size: row.size ?? probe.bytes }
}

/**
 * UP 主空间：列出他的合集与系列，以及**全部投稿**。
 *
 * ## 为什么不是"全量投稿"
 *
 * 真正的全量投稿接口 `/x/space/wbi/arc/search` **做不了**。实测（2026-10-21）：
 * - wbi 签名 + 基础头 → `-352 风控校验失败`
 * - 加完整浏览器头（origin / accept / referer 指向空间页）→ `-412 request was banned`
 * - 加设备指纹 `buvid3`/`buvid4` + `dm_img_*` 参数 → 仍然 `-412`
 * - 冷却后用最小参数 → `-352`；加 `platform=web` → 直接返回风控 HTML
 * - 移动端 `app.bilibili.com/x/v2/space/archive/cursor` → `-400`（需要 appkey 签名）
 *
 * 参数越齐全反而封得更狠，说明它校验的东西我们模拟不出来。**没有硬啃**。
 *
 * ## 真正的解法：`series/recArchivesByKeywords`
 *
 * 从社区文档（SocialSisterYi/bilibili-API-collect 的存档）里翻到：
 * ```
 * GET /x/series/recArchivesByKeywords?mid=<mid>&keywords=&ps=100&pn=1
 * ```
 * `keywords` **留空就是该 UP 的全部投稿**，而且**免签名、免登录**。
 * 实测「老番茄」mid=546195 返回 `total: 682`，分页正常；带关键词还能按标题筛选。
 * 这个接口文档原话是"功能基本相同，暂未发现风控校验" —— 和投稿接口形成鲜明对比。
 *
 * ## 备选方案（也是实测可用的）
 *
 * `seasons_series_list` **免签名**就能列出某个 UP 的全部合集与系列：
 * ```json
 * GET /x/polymer/web-space/seasons_series_list?mid=546195&page_num=1&page_size=20
 * → { items_lists: { seasons_list: [...], series_list: [...] } }
 * ```
 * 而 UP 主的视频绝大多数本来就按合集/系列组织，所以"列合集 → 逐个下载"
 * 已经覆盖了大部分真实需求。单独发的散装视频只能靠搜索或手给链接。
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { cookieHeader, loadBiliSession } from './auth.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

export interface SpaceSeason {
  /** 合集 id（给 seasons_archives_list 用）。 */
  seasonId: string
  title: string
  /** 合集里的视频数。 */
  count: number | null
  cover: string | null
  description: string | null
}

export interface SpaceSeries {
  seriesId: string
  title: string
  count: number | null
  cover: string | null
  description: string | null
}

export interface SpaceOverview {
  mid: string
  /** UP 名（从合集的 meta 里带出来，拿不到就是 null）。 */
  name: string | null
  seasons: SpaceSeason[]
  series: SpaceSeries[]
  /** 每类是否还有更多页。 */
  truncated: boolean
}

interface RawList {
  meta?: {
    name?: string
    title?: string
    season_id?: number
    series_id?: number
    total?: number
    cover?: string
    description?: string
    mid?: number
  }
  archives?: unknown[]
}

async function getJson<T>(url: string, what: string, signal?: AbortSignal): Promise<T> {
  const session = loadBiliSession()
  const options: Parameters<typeof httpRequest>[1] = {
    headers: {
      'user-agent': UA,
      referer: 'https://space.bilibili.com/',
      ...(session ? { cookie: cookieHeader(session) } : {}),
    },
    timeoutMs: 15_000,
    retries: 1,
  }
  if (signal) options.signal = signal
  const response = await httpRequest(url, options)
  if (!response.ok) throw new AstraError('BILI_HTTP', `${what}返回 HTTP ${response.status}`, { exitCode: 5, retryable: response.status >= 500 })
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new AstraError('BILI_RISK_CONTROL', `${what}返回了网页而不是数据（可能被风控）`, { exitCode: 5, retryable: true })
  }
}

/** `https://space.bilibili.com/546195` 或 `mid:546195` → "546195"。 */
export function parseMid(input: string): string | null {
  const text = input.trim()
  const explicit = text.match(/^mid:(\d+)$/i)
  if (explicit) return explicit[1]!
  const fromUrl = text.match(/space\.bilibili\.com\/(\d+)/)
  if (fromUrl) return fromUrl[1]!
  if (/^\d+$/.test(text)) return text
  return null
}

function toCover(url: string | undefined): string | null {
  if (!url) return null
  return url.startsWith('//') ? `https:${url}` : url.replace(/^http:/, 'https:')
}

/** 列某个 UP 的合集与系列。免签名，实测稳定。 */
export async function spaceOverview(mid: string, maxPages = 5, signal?: AbortSignal): Promise<SpaceOverview> {
  const seasons: SpaceSeason[] = []
  const series: SpaceSeries[] = []
  let name: string | null = null
  let truncated = false

  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const data = await getJson<{
      code: number
      message?: string
      data?: { items_lists?: { seasons_list?: RawList[]; series_list?: RawList[]; page?: { page_num?: number; page_size?: number; total?: number } } }
    }>(
      `https://api.bilibili.com/x/polymer/web-space/seasons_series_list?mid=${encodeURIComponent(mid)}&page_num=${pageNum}&page_size=20`,
      'UP 合集列表',
      signal,
    )
    if (data.code !== 0) {
      throw new AstraError('BILI_SPACE_ERROR', `UP 合集列表读取失败（code=${data.code}${data.message ? `：${data.message}` : ''}）`, {
        exitCode: data.code === -404 ? 4 : 5,
      })
    }
    const lists = data.data?.items_lists
    if (!lists) break
    for (const item of lists.seasons_list ?? []) {
      const meta = item.meta
      if (!meta?.season_id) continue
      seasons.push({
        seasonId: String(meta.season_id),
        title: meta.name ?? meta.title ?? `合集 ${meta.season_id}`,
        count: typeof meta.total === 'number' ? meta.total : null,
        cover: toCover(meta.cover),
        description: meta.description?.trim() || null,
      })
    }
    for (const item of lists.series_list ?? []) {
      const meta = item.meta
      if (!meta?.series_id) continue
      series.push({
        seriesId: String(meta.series_id),
        title: meta.name ?? meta.title ?? `系列 ${meta.series_id}`,
        count: typeof meta.total === 'number' ? meta.total : null,
        cover: toCover(meta.cover),
        description: meta.description?.trim() || null,
      })
    }
    const both = (lists.seasons_list?.length ?? 0) + (lists.series_list?.length ?? 0)
    if (both === 0) break
    const total = lists.page?.total
    if (total !== undefined && pageNum * 20 >= total) break
    if (pageNum === maxPages) truncated = true
  }

  // UP 名单独查（合集 meta 里的 name 是**合集名**，不是 UP 名）。
  // `/x/web-interface/card` 免签名可用；拿不到就返回 null，不编造
  if (name === null) {
    try {
      const card = await getJson<{ code: number; data?: { card?: { name?: string } } }>(
        `https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(mid)}`,
        'UP 信息',
        signal,
      )
      name = card.data?.card?.name ?? null
    } catch {
      name = null
    }
  }
  return { mid, name, seasons, series, truncated }
}

/** UP 的一个投稿视频。 */
export interface SpaceVideo {
  bvid: string
  title: string
  durationSec: number | null
  views: number | null
  pubdate: string | null
  cover: string | null
}

export interface SpaceVideos {
  mid: string
  total: number | null
  videos: SpaceVideo[]
  /** 是否还有下一页没取。 */
  hasMore: boolean
}

/**
 * 列某个 UP 的投稿视频。
 *
 * `keywords` 留空 = 全部投稿；给了就按标题模糊筛（B 站那侧做的筛选，不是本地过滤）。
 * `limit` 控制最多取多少条，内部自动翻页。
 */
export async function spaceVideos(mid: string, keywords: string, limit: number, signal?: AbortSignal): Promise<SpaceVideos> {
  const pageSize = Math.min(100, Math.max(1, limit))
  const videos: SpaceVideo[] = []
  let total: number | null = null
  let hasMore = false
  for (let pn = 1; videos.length < limit && pn <= 50; pn += 1) {
    const url =
      `https://api.bilibili.com/x/series/recArchivesByKeywords?mid=${encodeURIComponent(mid)}` +
      `&keywords=${encodeURIComponent(keywords)}&ps=${pageSize}&pn=${pn}`
    const data = await getJson<{
      code: number
      message?: string
      data?: { archives?: { bvid?: string; title?: string; duration?: number; pubdate?: number; pic?: string; stat?: { view?: number } }[]; page?: { total?: number } }
    }>(url, 'UP 投稿', signal)
    if (data.code !== 0) {
      throw new AstraError('BILI_SPACE_VIDEOS_ERROR', `UP 投稿读取失败（code=${data.code}${data.message ? `：${data.message}` : ''}）`, {
        exitCode: codeExit(data.code),
      })
    }
    total = data.data?.page?.total ?? total
    const batch = data.data?.archives ?? []
    for (const a of batch) {
      if (!a.bvid) continue
      videos.push({
        bvid: a.bvid,
        title: a.title ?? a.bvid,
        durationSec: typeof a.duration === 'number' ? a.duration : null,
        views: typeof a.stat?.view === 'number' ? a.stat.view : null,
        pubdate: typeof a.pubdate === 'number' ? new Date(a.pubdate * 1000).toISOString().slice(0, 10) : null,
        cover: toCover(a.pic),
      })
      if (videos.length >= limit) break
    }
    if (batch.length === 0) break
    if (total !== null) {
      if (videos.length >= total) break
      hasMore = videos.length < total
    }
  }
  return { mid, total, videos, hasMore }
}

function codeExit(code: number): 4 | 5 {
  return code === -404 ? 4 : 5
}

/** 从 UP 空间页的合集页面 URL 里抽 mid（用于 `astra bili space <url>`）。 */
export function spaceFromUrl(input: string): string | null {
  return parseMid(input)
}

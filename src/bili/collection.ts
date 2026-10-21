/**
 * B 站的"一组视频"：收藏夹、视频合集。
 *
 * 实测（2026-10-21）：
 * - 收藏夹 `/x/v3/fav/resource/list` 免签可用（code 0），但要登录才看得到私密收藏夹
 * - 视频合集在视频详情的 `ugc_season` 里，**同一个接口带出来**，不需要额外请求
 * - **UP 主投稿列表 `/x/space/wbi/arc/search` 会返回风控 HTML**，不做。想批量下载某个 UP
 *   的视频，让用户给合集链接或收藏夹，不要硬啃这个接口
 */
import { AstraError, invalidInput } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { cookieHeader, loadBiliSession } from './auth.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

export interface CollectionItem {
  bvid: string
  title: string
  /** 合集里的分集标题；收藏夹里为空。 */
  part: string | null
  durationSec: number | null
  /** 已经在本地（如果知道）。 */
  downloaded: boolean
}

export interface Collection {
  kind: 'fav' | 'season'
  id: string
  title: string
  items: CollectionItem[]
  /** 平台报告的总数（可能大于本次返回的条数）。 */
  total: number | null
}

function headers(): Record<string, string> {
  const session = loadBiliSession()
  return { 'user-agent': UA, referer: REFERER, ...(session ? { cookie: cookieHeader(session) } : {}) }
}

async function getJson<T>(url: string, what: string, signal?: AbortSignal): Promise<T> {
  const options: Parameters<typeof httpRequest>[1] = { headers: headers(), timeoutMs: 15_000, retries: 1 }
  if (signal) options.signal = signal
  const response = await httpRequest(url, options)
  if (!response.ok) throw new AstraError('BILI_HTTP', `${what}返回 HTTP ${response.status}`, { exitCode: 5, retryable: response.status >= 500 })
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    // 风控页是 HTML，直接说出来比抛"不是 JSON"有用
    throw new AstraError('BILI_RISK_CONTROL', `${what}返回了网页而不是数据（可能被风控）`, {
      exitCode: 5,
      retryable: true,
      hint: '冷却一会儿再试；频繁请求同一个 UP 的列表容易被拦',
    })
  }
}

/** 收藏夹。mid 为 0 / 缺省时看自己的（需要登录）。 */
export async function fetchFavorite(mediaId: string, limit: number, signal?: AbortSignal): Promise<Collection> {
  const session = loadBiliSession()
  if (!session) {
    throw new AstraError('NOT_LOGGED_IN', '看收藏夹需要登录 B 站', { exitCode: 3, hint: '`astra bili login start`，让用户扫码' })
  }
  const pageSize = Math.min(20, Math.max(1, limit))
  const items: CollectionItem[] = []
  let title = ''
  let total: number | null = null
  for (let pn = 1; items.length < limit && pn <= 50; pn += 1) {
    const data = await getJson<{
      code: number
      message?: string
      data?: { info?: { title?: string; media_count?: number }; medias?: { bvid?: string; title?: string; duration?: number; attr?: number }[]; has_more?: boolean }
    }>(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${encodeURIComponent(mediaId)}&ps=${pageSize}&pn=${pn}&platform=web`, '收藏夹', signal)
    if (data.code !== 0) {
      // -403 = 私密 / 无权访问
      throw new AstraError('BILI_FAV_ERROR', `收藏夹读取失败（code=${data.code}${data.message ? `：${data.message}` : ''}）`, {
        exitCode: data.code === -403 ? 4 : 5,
        ...(data.code === -403 ? { hint: '私密收藏夹需要登录自己的账号' } : {}),
      })
    }
    title ||= data.data?.info?.title ?? ''
    total = data.data?.info?.media_count ?? total
    const medias = data.data?.medias ?? []
    for (const m of medias) {
      // attr 表示条目状态：0 正常；非 0 的是已失效视频
      if (!m.bvid || (m.attr !== undefined && m.attr !== 0)) continue
      items.push({ bvid: m.bvid, title: m.title ?? m.bvid, part: null, durationSec: m.duration ?? null, downloaded: false })
      if (items.length >= limit) break
    }
    if (data.data?.has_more !== true || medias.length === 0) break
  }
  return { kind: 'fav', id: mediaId, title: title || `收藏夹 ${mediaId}`, items, total }
}

/** 视频合集：从视频详情的 ugc_season 里取。 */
export interface SeasonInfo {
  title: string
  items: CollectionItem[]
}

export function readSeason(viewData: {
  ugc_season?: { id?: number; title?: string; sections?: { episodes?: { bvid?: string; title?: string; arc?: { title?: string; duration?: number } }[] }[] }
}): SeasonInfo | null {
  const season = viewData.ugc_season
  if (!season) return null
  const items: CollectionItem[] = []
  for (const section of season.sections ?? []) {
    for (const episode of section.episodes ?? []) {
      if (!episode.bvid) continue
      items.push({
        bvid: episode.bvid,
        title: episode.arc?.title ?? episode.title ?? episode.bvid,
        part: episode.title ?? null,
        durationSec: episode.arc?.duration ?? null,
        downloaded: false,
      })
    }
  }
  if (items.length === 0) return null
  return { title: season.title ?? '合集', items }
}

/**
 * 解析"一组视频"的输入。
 *
 * 支持的全部写法：
 * - 收藏夹：`fav:<id>`、`space.bilibili.com/<mid>/favlist?fid=<id>`
 * - 合集：`collectiondetail?sid=<id>` 链接、`lists/<id>?type=season` 链接、
 *         `season:<sid>`、`season:<mid>/<sid>`、`collection:<sid>`
 * - 系列：`seriesdetail?sid=<id>` 链接、`series:<sid>`
 *
 * **mid 是可选的**：`seasons_archives_list` 只给 season_id 也能返回（实测 2026-10-21 复核）。
 * 之前以为必须两个参数，是因为当时用的 sid 本身不存在，404 被误读成"缺 mid"。
 */
export type CollectionRef =
  | { kind: 'fav'; id: string }
  | { kind: 'season'; mid: string | null; seasonId: string }
  | { kind: 'series'; mid: string | null; seriesId: string }
  | { kind: null; raw: string }

export function parseCollectionRef(input: string): CollectionRef {
  const text = input.trim()

  // —— 收藏夹 ——
  const fav = text.match(/^fav:(\d+)$/i)
  if (fav) return { kind: 'fav', id: fav[1]! }
  const favUrl = text.match(/favlist\?[^#]*?fid=(\d+)/)
  if (favUrl) return { kind: 'fav', id: favUrl[1]! }

  // —— 系列（series）—— 先于合集判断：seriesdetail 与 collectiondetail 是两套接口
  const seriesUrl = text.match(/space\.bilibili\.com\/(\d+)\/channel\/seriesdetail\?[^#]*?sid=(\d+)/)
  if (seriesUrl) return { kind: 'series', mid: seriesUrl[1]!, seriesId: seriesUrl[2]! }
  const seriesRef = text.match(/^series:(?:(\d+)\/)?(\d+)$/i)
  if (seriesRef) return { kind: 'series', mid: seriesRef[1] ?? null, seriesId: seriesRef[2]! }

  // —— 合集（season）——
  const collectionUrl = text.match(/space\.bilibili\.com\/(\d+)\/channel\/collectiondetail\?[^#]*?sid=(\d+)/)
  if (collectionUrl) return { kind: 'season', mid: collectionUrl[1]!, seasonId: collectionUrl[2]! }
  const listsUrl = text.match(/space\.bilibili\.com\/(\d+)\/lists\/(\d+)/)
  if (listsUrl) return { kind: 'season', mid: listsUrl[1]!, seasonId: listsUrl[2]! }
  // `season:<sid>` / `season:<mid>/<sid>` / `collection:<sid>`
  const seasonRef = text.match(/^(?:season|collection):(?:(\d+)\/)?(\d+)$/i)
  if (seasonRef) return { kind: 'season', mid: seasonRef[1] ?? null, seasonId: seasonRef[2]! }

  return { kind: null, raw: text }
}

export function assertCollectionRef(input: string): void {
  if (parseCollectionRef(input).kind === null) {
    throw invalidInput(`认不出这是哪个收藏夹 / 合集 / 系列：${input.slice(0, 40)}`, [
      '收藏夹：`fav:<id>` 或 favlist 链接',
      '合集：collectiondetail?sid=<id> 链接，或 `season:<sid>` / `collection:<sid>`',
      '系列：seriesdetail?sid=<id> 链接，或 `series:<sid>`',
    ].join('；'))
  }
}

/**
 * 拉合集里的视频。
 *
 * `mid` 可以省略 —— 实测只给 season_id 也能返回（2026-10-21 复核）。
 * 之前以为必须两个参数，是因为那次用的 sid 不存在，404 被误读成"缺 mid"。
 */
export async function fetchSeasonArchives(mid: string | null, seasonId: string, limit: number, signal?: AbortSignal): Promise<Collection> {
  const pageSize = Math.min(30, Math.max(1, limit))
  const items: CollectionItem[] = []
  let title = ''
  let total: number | null = null
  for (let pageNum = 1; items.length < limit && pageNum <= 50; pageNum += 1) {
    const params = new URLSearchParams({
      season_id: seasonId, sort_reverse: 'false', page_num: String(pageNum), page_size: String(pageSize),
    })
    if (mid) params.set('mid', mid)
    const url = `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?${params}`
    const data = await getJson<{
      code: number
      message?: string
      data?: {
        archives?: { bvid?: string; title?: string; duration?: number }[]
        meta?: { name?: string; title?: string; total?: number }
        page?: { total?: number }
      }
    }>(url, '合集', signal)
    if (data.code !== 0) {
      throw new AstraError('BILI_SEASON_ERROR', `合集读取失败（code=${data.code}${data.message ? `：${data.message}` : ''}）`, {
        exitCode: data.code === -404 ? 4 : 5,
        ...(data.code === -404 ? { hint: '确认 sid 正确且这个合集公开可见' } : {}),
      })
    }
    title ||= data.data?.meta?.name ?? data.data?.meta?.title ?? ''
    total = data.data?.meta?.total ?? data.data?.page?.total ?? total
    const archives = data.data?.archives ?? []
    for (const a of archives) {
      if (!a.bvid) continue
      items.push({ bvid: a.bvid, title: a.title ?? a.bvid, part: null, durationSec: a.duration ?? null, downloaded: false })
      if (items.length >= limit) break
    }
    if (archives.length === 0 || items.length >= limit) break
    if (total !== null && items.length >= total) break
  }
  return { kind: 'season', id: seasonId, title: title || `合集 ${seasonId}`, items, total }
}

/**
 * 拉系列里的视频。
 *
 * 系列（series）与合集（season）是**两套独立接口**：
 * 系列走 `/x/series/archives`，合集走 `seasons_archives_list`。
 * 系列比合集少见（实测几个大 UP 都只有合集没有系列），实现按官方文档写，拿不到就给明确错误。
 */
export async function fetchSeriesArchives(mid: string | null, seriesId: string, limit: number, signal?: AbortSignal): Promise<Collection> {
  if (!mid) {
    throw new AstraError('SERIES_NEED_MID', '系列需要 mid（B 站系列接口必须带作者 id）', {
      exitCode: 2,
      hint: `用完整链接，或 \`series:<mid>/${seriesId}\``,
    })
  }
  const pageSize = Math.min(30, Math.max(1, limit))
  const items: CollectionItem[] = []
  let title = ''
  let total: number | null = null
  for (let pn = 1; items.length < limit && pn <= 50; pn += 1) {
    const url = `https://api.bilibili.com/x/series/archives?mid=${encodeURIComponent(mid)}&series_id=${encodeURIComponent(seriesId)}&only_normal=true&sort=desc&pn=${pn}&ps=${pageSize}`
    const data = await getJson<{
      code: number
      message?: string
      data?: { archives?: { bvid?: string; title?: string; duration?: number }[]; page?: { total?: number } }
    }>(url, '系列', signal)
    if (data.code !== 0) {
      throw new AstraError('BILI_SERIES_ERROR', `系列读取失败（code=${data.code}${data.message ? `：${data.message}` : ''}）`, {
        exitCode: data.code === -404 ? 4 : 5,
        ...(data.code === -404 ? { hint: '确认 mid 与 sid 对应同一个 UP，且系列公开可见' } : {}),
      })
    }
    total = data.data?.page?.total ?? total
    const archives = data.data?.archives ?? []
    for (const a of archives) {
      if (!a.bvid) continue
      items.push({ bvid: a.bvid, title: a.title ?? a.bvid, part: null, durationSec: a.duration ?? null, downloaded: false })
      if (items.length >= limit) break
    }
    if (archives.length === 0 || items.length >= limit) break
    if (total !== null && items.length >= total) break
  }
  return { kind: 'season', id: seriesId, title: title || `系列 ${seriesId}`, items, total }
}

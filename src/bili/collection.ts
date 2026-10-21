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

/** 解析 `fav:123456` 这类 ref。 */
export function parseCollectionRef(input: string): { kind: 'fav' | 'season' | null; id: string } {
  const fav = input.match(/^fav:(\d+)$/i)
  if (fav) return { kind: 'fav', id: fav[1]! }
  // 收藏夹链接：space.bilibili.com/<mid>/favlist?fid=<id>
  const favUrl = input.match(/favlist\?.*?\bfid=(\d+)/)
  if (favUrl) return { kind: 'fav', id: favUrl[1]! }
  return { kind: null, id: input }
}

export function assertCollectionRef(input: string): void {
  if (!/^fav:\d+$/i.test(input) && !/favlist\?.*\bfid=\d+/.test(input)) {
    throw invalidInput(`认不出这是哪个收藏夹：${input.slice(0, 40)}`, '用 `fav:<收藏夹id>` 或 space.bilibili.com 的收藏夹链接')
  }
}

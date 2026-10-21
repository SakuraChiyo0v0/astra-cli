/**
 * B 站的"发现"类接口：综合热门、每周必看。
 *
 * 实测（2026-10-21，均免登录）：
 * - 热门 `/x/web-interface/popular?ps=&pn=` → `data.list[]`，每项有 bvid / title / owner / duration
 * - 每周必看清单 `/x/web-interface/popular/series/list` → `data.list[]`（394 期）
 * - 某一期详情 `/x/web-interface/popular/series/one?number=` → `data.list[]`
 *
 * 这些接口的价值在于**喂给下载流程**：AI 能回答"这周有什么值得看的"，你点一个就下。
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

export interface DiscoverItem {
  bvid: string
  title: string
  uploader: string
  /** 秒。 */
  durationSec: number | null
  /** 播放量（热门有，必看可能没有）。 */
  views: number | null
  /** 分区名。 */
  category: string | null
  cover: string | null
}

interface RawVideo {
  bvid?: string
  title?: string
  owner?: { name?: string }
  duration?: number
  stat?: { view?: number }
  tname?: string
  pic?: string
}

async function getJson<T>(url: string, what: string, signal?: AbortSignal): Promise<T> {
  const options: Parameters<typeof httpRequest>[1] = { headers: { 'user-agent': UA, referer: REFERER }, timeoutMs: 15_000, retries: 1 }
  if (signal) options.signal = signal
  const response = await httpRequest(url, options)
  if (!response.ok) throw new AstraError('BILI_HTTP', `${what}返回 HTTP ${response.status}`, { exitCode: 5, retryable: true })
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new AstraError('BILI_RISK_CONTROL', `${what}返回了网页而不是数据（可能被风控）`, { exitCode: 5, retryable: true })
  }
}

function toItem(raw: RawVideo): DiscoverItem | null {
  if (!raw.bvid) return null
  return {
    bvid: raw.bvid,
    title: raw.title ?? raw.bvid,
    uploader: raw.owner?.name ?? '',
    durationSec: typeof raw.duration === 'number' ? raw.duration : null,
    views: typeof raw.stat?.view === 'number' ? raw.stat.view : null,
    category: raw.tname ?? null,
    cover: raw.pic ? raw.pic.replace(/^http:/, 'https:') : null,
  }
}

/** 综合热门。limit 上限 50（官方一页最多 20，内部翻页）。 */
export async function popular(limit: number, signal?: AbortSignal): Promise<DiscoverItem[]> {
  const items: DiscoverItem[] = []
  for (let pn = 1; items.length < limit && pn <= 5; pn += 1) {
    const body = await getJson<{ code: number; message?: string; data?: { list?: RawVideo[]; no_more?: boolean } }>(
      `https://api.bilibili.com/x/web-interface/popular?ps=20&pn=${pn}`,
      '热门',
      signal,
    )
    if (body.code !== 0) throw new AstraError('BILI_API_ERROR', `热门接口失败（code=${body.code}）`, { exitCode: 5, details: { code: body.code } })
    const list = body.data?.list ?? []
    for (const raw of list) {
      const item = toItem(raw)
      if (item) items.push(item)
      if (items.length >= limit) break
    }
    if (body.data?.no_more === true || list.length === 0) break
  }
  return items
}

export interface WeeklyIssue {
  number: number
  subject: string
  name: string
}

/** 每周必看的期数列表（不含具体视频）。 */
export async function weeklyIssues(signal?: AbortSignal): Promise<WeeklyIssue[]> {
  const body = await getJson<{ code: number; data?: { list?: { number?: number; subject?: string; name?: string }[] } }>(
    'https://api.bilibili.com/x/web-interface/popular/series/list',
    '每周必看',
    signal,
  )
  if (body.code !== 0) throw new AstraError('BILI_API_ERROR', `每周必看列表失败（code=${body.code}）`, { exitCode: 5 })
  return (body.data?.list ?? []).map((x) => ({ number: x.number ?? 0, subject: x.subject ?? '', name: x.name ?? '' }))
}

/** 某一期的视频。number 省略时取最新一期。 */
export async function weeklyOne(number: number | null, signal?: AbortSignal): Promise<{ issue: WeeklyIssue; items: DiscoverItem[] }> {
  let target = number
  if (target === null) {
    const issues = await weeklyIssues(signal)
    if (issues.length === 0) throw new AstraError('BILI_NO_WEEKLY', '每周必看没有可用期数', { exitCode: 4 })
    // 列表按新到旧，第一条就是最新一期
    target = issues[0]!.number
  }
  const body = await getJson<{ code: number; data?: { number?: number; subject?: string; name?: string; list?: RawVideo[] } }>(
    `https://api.bilibili.com/x/web-interface/popular/series/one?number=${target}`,
    '每周必看期数',
    signal,
  )
  if (body.code !== 0) throw new AstraError('BILI_API_ERROR', `第 ${target} 期读取失败（code=${body.code}）`, { exitCode: body.code === -404 ? 4 : 5 })
  return {
    issue: { number: body.data?.number ?? target, subject: body.data?.subject ?? '', name: body.data?.name ?? '' },
    items: (body.data?.list ?? []).map(toItem).filter((x): x is DiscoverItem => x !== null),
  }
}

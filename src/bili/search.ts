/**
 * B 站搜索：视频 / UP 主。
 *
 * 实测（2026-10-21）：
 * - 视频搜索 `/x/web-interface/wbi/search/type?search_type=video` **需要 wbi 签名**，可用
 * - 用户搜索 `search_type=bili_user` 同样可用
 * - **UP 主视频列表 `/x/space/wbi/arc/search` 即使带签名也返回 -352 风控**，
 *   所以不给"列出某 UP 的全部投稿"，只给搜索。这也印证了 astra-hub 文档里的结论
 *
 * 搜索结果是给下载流程喂料的：每项带 bvid，能直接 `bili get <bvid>`。
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { cookieHeader, loadBiliSession } from './auth.ts'
import { signParams, type WbiKeys } from './sign.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

function headers(): Record<string, string> {
  const session = loadBiliSession()
  return { 'user-agent': UA, referer: REFERER, ...(session ? { cookie: cookieHeader(session) } : {}) }
}

let cachedKeys: WbiKeys | null = null

async function wbiKeys(signal?: AbortSignal): Promise<WbiKeys> {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < 5 * 60 * 1000) return cachedKeys
  const options: Parameters<typeof httpRequest>[1] = { headers: headers(), timeoutMs: 12_000, retries: 1 }
  if (signal) options.signal = signal
  const response = await httpRequest('https://api.bilibili.com/x/web-interface/nav', options)
  const body = (await response.json()) as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } }
  const img = body.data?.wbi_img?.img_url
  const sub = body.data?.wbi_img?.sub_url
  if (!img || !sub) throw new AstraError('BILI_NO_WBI', '拿不到 wbi 签名密钥', { exitCode: 5, retryable: true })
  cachedKeys = { imgUrl: img, subUrl: sub, fetchedAt: Date.now() }
  return cachedKeys
}

interface RawVideoResult {
  bvid?: string
  title?: string
  author?: string
  duration?: string | number
  play?: number
  video_review?: number
  pubdate?: number
  pic?: string
  typename?: string
}

export interface VideoHit {
  bvid: string
  title: string
  uploader: string
  /** 秒。搜索接口给的是 "12:34" 字符串，统一转成秒。 */
  durationSec: number | null
  views: number | null
  danmaku: number | null
  pubdate: string | null
  cover: string | null
  category: string | null
}

export interface UserHit {
  mid: string
  name: string
  sign: string | null
  fans: number | null
  videos: number | null
  avatar: string | null
}

/** 搜索结果里的时长有两种形态："12:34" 或纯秒数。 */
export function parseSearchDuration(value: string | number | undefined): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = value.trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text)
  const parts = text.split(':').map(Number)
  if (parts.some((x) => !Number.isFinite(x))) return null
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
  return null
}

function stripEm(text: string | undefined): string {
  return (text ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim()
}

async function searchRaw(
  searchType: 'video' | 'bili_user',
  keyword: string,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const keys = await wbiKeys(signal)
  const query = signParams({ search_type: searchType, keyword, page, page_size: pageSize }, keys)
  const options: Parameters<typeof httpRequest>[1] = { headers: headers(), timeoutMs: 15_000, retries: 1 }
  if (signal) options.signal = signal
  const response = await httpRequest(`https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`, options)
  const text = await response.text()
  let body: { code?: number; message?: string; data?: { result?: unknown[] } }
  try {
    body = JSON.parse(text) as typeof body
  } catch {
    throw new AstraError('BILI_RISK_CONTROL', '搜索返回了网页而不是数据（可能被风控）', { exitCode: 5, retryable: true, hint: '冷却一会儿再试' })
  }
  if (body.code === -352) {
    throw new AstraError('BILI_RISK_CONTROL', 'B 站风控拒绝了这次搜索（-352）', {
      exitCode: 5, retryable: true, hint: '过几分钟再试；频繁搜索容易被拦',
    })
  }
  if (body.code !== 0) {
    throw new AstraError('BILI_SEARCH_ERROR', `搜索失败（code=${String(body.code)}${body.message ? `：${body.message}` : ''}）`, { exitCode: 5 })
  }
  return body.data?.result ?? []
}

export async function searchVideos(keyword: string, limit: number, page = 1, signal?: AbortSignal): Promise<VideoHit[]> {
  const raw = (await searchRaw('video', keyword, page, Math.min(50, Math.max(1, limit)), signal)) as RawVideoResult[]
  return raw
    .filter((r) => typeof r.bvid === 'string' && r.bvid.length > 0)
    .map((r) => ({
      bvid: r.bvid!,
      title: stripEm(r.title),
      uploader: stripEm(r.author),
      durationSec: parseSearchDuration(r.duration),
      views: typeof r.play === 'number' ? r.play : null,
      danmaku: typeof r.video_review === 'number' ? r.video_review : null,
      pubdate: typeof r.pubdate === 'number' ? new Date(r.pubdate * 1000).toISOString().slice(0, 10) : null,
      cover: r.pic ? (r.pic.startsWith('//') ? `https:${r.pic}` : r.pic.replace(/^http:/, 'https:')) : null,
      category: r.typename ?? null,
    }))
}

export async function searchUsers(keyword: string, limit: number, page = 1, signal?: AbortSignal): Promise<UserHit[]> {
  const raw = (await searchRaw('bili_user', keyword, page, Math.min(50, Math.max(1, limit)), signal)) as {
    mid?: number; uname?: string; usign?: string; fans?: number; videos?: number; upic?: string
  }[]
  return raw
    .filter((r) => typeof r.mid === 'number')
    .map((r) => ({
      mid: String(r.mid),
      name: stripEm(r.uname),
      sign: r.usign ? stripEm(r.usign) : null,
      fans: typeof r.fans === 'number' ? r.fans : null,
      videos: typeof r.videos === 'number' ? r.videos : null,
      avatar: r.upic ? (r.upic.startsWith('//') ? `https:${r.upic}` : r.upic) : null,
    }))
}

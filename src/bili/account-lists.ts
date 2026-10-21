/**
 * 需要登录的 B 站"我的列表"：稍后再看、观看历史。
 *
 * 实测（2026-10-21，大会员账号）：
 * - 稍后再看 `/x/v2/history/toview` → `data.list[]`，44 条，`progress` 是看到第几秒（-1 = 没开始）
 * - 观看历史 `/x/web-interface/history/cursor?ps=&type=archive` → `data.list[]`，
 *   游标在 `data.cursor.max`/`view_at`，`history.bvid` 才是视频号
 *
 * 这两个的核心价值是**喂给批量下载**：你在 B 站点一下"稍后再看"，AI 就能一次下完。
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { cookieHeader, loadBiliSession } from './auth.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

export interface AccountVideo {
  bvid: string
  title: string
  uploader: string
  durationSec: number | null
  /** 看到第几秒；-1 表示没开始看。 */
  progressSec: number | null
  /** 观看时间（epoch 秒），历史才有。 */
  viewedAt: number | null
  cover: string | null
}

function headers(): Record<string, string> {
  const session = loadBiliSession()
  if (!session) {
    throw new AstraError('NOT_LOGGED_IN', '这个功能需要登录 B 站', { exitCode: 3, hint: '`astra bili login start`，让用户扫码' })
  }
  return { 'user-agent': UA, referer: REFERER, cookie: cookieHeader(session) }
}

async function getJson<T>(url: string, what: string, signal?: AbortSignal): Promise<T> {
  const options: Parameters<typeof httpRequest>[1] = { headers: headers(), timeoutMs: 15_000, retries: 1 }
  if (signal) options.signal = signal
  const response = await httpRequest(url, options)
  if (!response.ok) throw new AstraError('BILI_HTTP', `${what}返回 HTTP ${response.status}`, { exitCode: 5, retryable: true })
  const body = (await response.json()) as T & { code?: number; message?: string }
  if (body.code === -101) {
    throw new AstraError('NOT_LOGGED_IN', `${what}需要登录（会话可能已失效）`, { exitCode: 3, hint: '`astra bili login start` 重新扫码' })
  }
  if (body.code !== 0) {
    throw new AstraError('BILI_API_ERROR', `${what}失败（code=${String(body.code)}${body.message ? `：${body.message}` : ''}）`, { exitCode: 5 })
  }
  return body
}

interface RawToview {
  bvid?: string
  title?: string
  owner?: { name?: string }
  duration?: number
  progress?: number
  pic?: string
}

/** 稍后再看。一次返回全部（实测 44 条）。 */
export async function watchLater(signal?: AbortSignal): Promise<AccountVideo[]> {
  const body = await getJson<{ data?: { list?: RawToview[]; count?: number } }>('https://api.bilibili.com/x/v2/history/toview', '稍后再看', signal)
  return (body.data?.list ?? [])
    .filter((v) => v.bvid)
    .map((v) => ({
      bvid: v.bvid!,
      title: v.title ?? v.bvid!,
      uploader: v.owner?.name ?? '',
      durationSec: typeof v.duration === 'number' ? v.duration : null,
      progressSec: typeof v.progress === 'number' ? v.progress : null,
      viewedAt: null,
      cover: v.pic ? v.pic.replace(/^http:/, 'https:') : null,
    }))
}

interface RawHistory {
  title?: string
  duration?: number
  view_at?: number
  cover?: string
  author_name?: string
  history?: { bvid?: string; oid?: number; business?: string }
}

/**
 * 观看历史（只要视频，不含直播/专栏）。
 *
 * 分页用游标而不是页码：每次把上一页的 `view_at` 与 `max` 带上。
 */
export async function watchHistory(limit: number, signal?: AbortSignal): Promise<AccountVideo[]> {
  const items: AccountVideo[] = []
  let max = ''
  let viewAt = ''
  for (let page = 0; items.length < limit && page < 20; page += 1) {
    const url =
      'https://api.bilibili.com/x/web-interface/history/cursor?ps=30&type=archive' +
      (max ? `&max=${max}&view_at=${viewAt}` : '')
    const body = await getJson<{ data?: { list?: RawHistory[]; cursor?: { max?: number; view_at?: number } } }>(url, '观看历史', signal)
    const list = body.data?.list ?? []
    for (const raw of list) {
      const bvid = raw.history?.bvid
      // business 为 archive 才是视频；直播/专栏/文章跳过
      if (!bvid || (raw.history?.business !== undefined && raw.history.business !== 'archive')) continue
      items.push({
        bvid,
        title: raw.title ?? bvid,
        uploader: raw.author_name ?? '',
        durationSec: typeof raw.duration === 'number' ? raw.duration : null,
        progressSec: null,
        viewedAt: typeof raw.view_at === 'number' ? raw.view_at : null,
        cover: raw.cover ? raw.cover.replace(/^http:/, 'https:') : null,
      })
      if (items.length >= limit) break
    }
    const cursor = body.data?.cursor
    if (!cursor?.max || list.length === 0) break
    max = String(cursor.max)
    viewAt = String(cursor.view_at ?? 0)
  }
  return items
}

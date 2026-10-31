/**
 * 视频评论区。
 *
 * 接口：`/x/v2/reply/wbi/main`（**必须 wbi 签名**，无签名版本已废弃）。
 * - mode=3 热门、mode=2 时间倒序
 * - `ps` 单页最多 49 条；`pn` 从 1 开始
 * - 未登录也能看，但看到的条数较少；带 cookie 才完整
 * - 一条一级评论的二级回复只给前 3 条（`replies`），完整要另拉 `reply/reply`
 *
 * 实测（2026-11-01）：aid + 签名后稳定返回；`data.cursor.all_count` 是总数。
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { cookieHeader, loadBiliSession } from './auth.ts'
import { signParams } from './sign.ts'
import { wbiKeys } from './api.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

export type CommentSort = 'hot' | 'time'

export interface CommentItem {
  rpid: string
  user: string
  uid: number
  like: number
  /** unix 秒 */
  ctime: number
  message: string
  replyCount: number
  replies: { user: string; message: string }[]
}

export interface CommentPage {
  total: number
  sort: CommentSort
  items: CommentItem[]
}

export interface RawReply {
  rpid?: number | string
  like?: number
  ctime?: number
  member?: { uname?: string; mid?: number | string }
  content?: { message?: string }
  rcount?: number
  replies?: { member?: { uname?: string }; content?: { message?: string } }[]
}

/** 把接口原始结构拍平成 CommentItem（纯函数，方便单测）。 */
export function mapReply(row: RawReply, withReplies: boolean): CommentItem {
  return {
    rpid: String(row.rpid ?? ''),
    user: row.member?.uname ?? '',
    uid: Number(row.member?.mid ?? 0),
    like: row.like ?? 0,
    ctime: row.ctime ?? 0,
    message: (row.content?.message ?? '').replace(/\s+/g, ' ').trim(),
    replyCount: row.rcount ?? 0,
    replies: withReplies
      ? (row.replies ?? []).map((r) => ({
          user: r.member?.uname ?? '',
          message: (r.content?.message ?? '').replace(/\s+/g, ' ').trim(),
        }))
      : [],
  }
}

async function fetchPage(aid: number, sort: CommentSort, pn: number, ps: number, signal?: AbortSignal) {
  const keys = await wbiKeys(signal)
  const query = signParams({ oid: aid, type: 1, mode: sort === 'time' ? 2 : 3, plat: 1, ps, pn }, keys)
  const session = loadBiliSession()
  const options: Parameters<typeof httpRequest>[1] = {
    headers: {
      'user-agent': UA,
      referer: 'https://www.bilibili.com/',
      ...(session ? { cookie: cookieHeader(session) } : {}),
    },
    timeoutMs: 15_000,
    retries: 1,
  }
  if (signal) options.signal = signal
  const response = await httpRequest(`https://api.bilibili.com/x/v2/reply/wbi/main?${query}`, options)
  if (!response.ok) throw new AstraError('BILI_HTTP', `B 站评论返回 HTTP ${response.status}`, { exitCode: 5, retryable: response.status >= 500 })
  const body = (await response.json()) as {
    code: number
    message?: string
    data?: { cursor?: { is_end?: boolean; all_count?: number }; replies?: RawReply[] | null }
  }
  if (body.code !== 0) {
    throw new AstraError('BILI_API_ERROR', `B 站评论失败（code=${body.code}${body.message ? `：${body.message}` : ''}）`, {
      exitCode: body.code === -404 ? 4 : 5,
      details: { code: body.code },
    })
  }
  return body.data ?? {}
}

/** 拉视频评论。limit 上限 100，按页取到够数为止。 */
export async function fetchComments(
  aid: number,
  opts: { sort?: CommentSort; limit?: number; withReplies?: boolean } = {},
  signal?: AbortSignal,
): Promise<CommentPage> {
  const sort = opts.sort ?? 'hot'
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100))
  const ps = Math.min(49, Math.max(20, limit))
  const items: CommentItem[] = []
  let total = 0

  for (let pn = 1; pn <= 6; pn += 1) {
    const data = await fetchPage(aid, sort, pn, ps, signal)
    total = data.cursor?.all_count ?? total
    for (const row of data.replies ?? []) {
      items.push(mapReply(row, opts.withReplies === true))
      if (items.length >= limit) break
    }
    if (items.length >= limit || data.cursor?.is_end) break
  }

  return { total, sort, items }
}

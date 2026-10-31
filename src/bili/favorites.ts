/**
 * 收藏夹写入（加 / 移）。
 *
 * 这是**写操作**，和只读接口比有两处硬要求：
 * 1. 必须登录（cookie 里的 SESSDATA）
 * 2. 必须带 csrf，值就是 cookie 里的 `bili_jct`
 *
 * 接口：
 * - 列收藏夹：`/x/v3/fav/folder/created/list-all?up_mid=<uid>`
 * - 加/移：`POST /x/v3/fav/resource/deal`，form: rid=收藏夹id, type=2(视频),
 *   add_media_ids / del_media_ids（逗号分隔的 aid）, csrf
 *
 * 实测（2026-11-01）：带齐 cookie + csrf 时返回 code 0；缺 csrf 返回 -111，
 * 未登录返回 -101。写操作有频率限制，批量加要自己控速（默认单条，不批量）。
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { cookieHeader, loadBiliSession, type BiliSession } from './auth.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

/** 从 cookie 串里取 csrf（bili_jct）。没有就是没登录干净。 */
export function csrfFromCookie(cookie: string): string | null {
  const match = /(?:^|;\s*)bili_jct=([^;]+)/.exec(cookie ?? '')
  return match ? match[1]!.trim() : null
}

function requireSession(): { session: BiliSession; csrf: string } {
  const session = loadBiliSession()
  if (!session) {
    throw new AstraError('BILI_NOT_LOGGED_IN', '收藏夹是写操作，需要登录', {
      exitCode: 3,
      hint: '先 `astra bili login start` 扫码登录',
    })
  }
  const csrf = csrfFromCookie(session.cookie)
  if (!csrf) {
    throw new AstraError('BILI_NO_CSRF', '登录会话里没有 bili_jct，不能做写操作', {
      exitCode: 3,
      hint: '重新 `astra bili login start` 扫码登录一次',
    })
  }
  return { session, csrf }
}

async function call<T>(url: string, what: string, init: { method?: string; body?: string } = {}, signal?: AbortSignal): Promise<T> {
  const { session } = requireSession()
  const options: Parameters<typeof httpRequest>[1] = {
    headers: {
      'user-agent': UA,
      referer: REFERER,
      cookie: cookieHeader(session),
      ...(init.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(init.method ? { method: init.method } : {}),
    ...(init.body ? { body: init.body } : {}),
    timeoutMs: 15_000,
    retries: 0,
  }
  if (signal) options.signal = signal
  const response = await httpRequest(url, options)
  if (!response.ok) throw new AstraError('BILI_HTTP', `B 站${what}返回 HTTP ${response.status}`, { exitCode: 5 })
  const body = (await response.json()) as { code: number; message?: string; data?: T }
  if (body.code !== 0) {
    const hint =
      body.code === -101 ? '登录已失效：重新 `astra bili login start`'
        : body.code === -111 ? 'csrf 校验失败：重新登录'
          : body.code === -403 ? '没有权限（不是自己的收藏夹？）'
            : null
    throw new AstraError('BILI_API_ERROR', `B 站${what}失败（code=${body.code}${body.message ? `：${body.message}` : ''}）`, {
      exitCode: 5,
      ...(hint ? { hint } : {}),
      details: { code: body.code },
    })
  }
  return (body.data ?? ({} as T)) as T
}

export interface FavFolder {
  id: number
  title: string
  mediaCount: number
}

/** 列出自己创建的收藏夹。 */
export async function listFavFolders(signal?: AbortSignal): Promise<FavFolder[]> {
  const { session } = requireSession()
  if (!session.uid) {
    throw new AstraError('BILI_NO_UID', '登录会话里没有 uid', { exitCode: 3, hint: '重新登录一次' })
  }
  const data = await call<{ list?: { id?: number; title?: string; media_count?: number }[] | null }>(
    `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(session.uid)}`,
    '收藏夹列表',
    {},
    signal,
  )
  return (data.list ?? []).map((row) => ({
    id: row.id ?? 0,
    title: (row.title ?? '').trim(),
    mediaCount: row.media_count ?? 0,
  }))
}

/** 把视频加入 / 移出某个收藏夹。aid 是视频的 av 号。 */
export async function dealFavorite(
  aid: number,
  opts: { folder: number; action: 'add' | 'remove' },
  signal?: AbortSignal,
): Promise<{ ok: true; folder: number; action: 'add' | 'remove'; aid: number }> {
  const { csrf } = requireSession()
  if (!Number.isFinite(aid) || aid <= 0) throw new AstraError('BILI_BAD_AID', 'aid 不合法', { exitCode: 2 })
  if (!Number.isFinite(opts.folder) || opts.folder <= 0) throw new AstraError('BILI_BAD_FOLDER', '收藏夹 id 不合法', { exitCode: 2 })
  const form = new URLSearchParams({
    rid: String(opts.folder),
    type: '2',
    add_media_ids: opts.action === 'add' ? String(aid) : '',
    del_media_ids: opts.action === 'remove' ? String(aid) : '',
    csrf,
  }).toString()
  await call<unknown>('https://api.bilibili.com/x/v3/fav/resource/deal', '收藏夹写入', { method: 'POST', body: form }, signal)
  return { ok: true, folder: opts.folder, action: opts.action, aid }
}

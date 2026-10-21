/**
 * 需要登录的账号接口：每日推荐、我喜欢的音乐、喜欢状态。
 *
 * 端点与返回形状都实测过（2026-10-21，登录态）：
 * - 每日推荐 `POST /weapi/v1/discovery/recommend/songs` → `recommend[]`（当天 33 首）
 * - 喜欢列表 `POST /weapi/song/like/get` { uid } → `ids`（实测 101 个，与"我喜欢的音乐"歌单数一致）
 * - 喜欢状态 `POST /weapi/song/like/check` { trackIds: JSON 数组字符串 } → `ids` 是**已红心的子集**，
 *   **不是**网络上流传的"与请求等长的 0/1 数组"。按集合包含判断，长度不等是正常的。
 * - 业务码 301 = 会话失效
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { weapiEncrypt } from './crypto.ts'
import { loadSession, type Session } from './auth.ts'

const ORIGIN = 'https://music.163.com'
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) NeteaseMusicDesktop/2.3.17.1034'

export interface AccountSession {
  session: Session
  userId: string
}

/** 取会话并确保有 userId；没登录就给出明确的下一步。 */
export function requireSession(userId: string | null, signal?: AbortSignal): AccountSession {
  void signal
  const session = loadSession()
  if (!session) {
    throw new AstraError('NOT_LOGGED_IN', '还没登录网易云', { exitCode: 3, hint: '先 `astra music login start`，让用户扫码' })
  }
  if (!userId) {
    throw new AstraError('NO_USER_ID', '会话里没有账号 id', { exitCode: 3, hint: '`astra music login start` 重新扫码' })
  }
  return { session, userId }
}

export async function weapiPost<T extends { code?: number }>(apiPath: string, payload: Record<string, unknown>, session: Session, signal?: AbortSignal): Promise<T> {
  const { params, encSecKey } = weapiEncrypt(payload)
  const options: Parameters<typeof httpRequest>[1] = {
    method: 'POST',
    headers: {
      'user-agent': DESKTOP_UA,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      referer: `${ORIGIN}/`,
      origin: ORIGIN,
      cookie: session.cookie,
    },
    body: new URLSearchParams({ params, encSecKey }).toString(),
    timeoutMs: 15_000,
    retries: 1,
  }
  if (signal) options.signal = signal
  const response = await httpRequest(`${ORIGIN}${apiPath}`, options)
  if (!response.ok) {
    throw new AstraError('NETEASE_HTTP_ERROR', `网易云账号接口返回 HTTP ${response.status}`, { exitCode: 5, retryable: response.status >= 500 })
  }
  const body = (await response.json()) as T
  if (body.code === 301) {
    throw new AstraError('NOT_LOGGED_IN', '网易云返回 301：会话已失效', { exitCode: 3, hint: '`astra music login start` 重新扫码' })
  }
  if (body.code !== undefined && body.code !== 200) {
    throw new AstraError('NETEASE_UPSTREAM_ERROR', `网易云账号接口返回 code=${body.code}`, { exitCode: 5, details: { code: body.code } })
  }
  return body
}

interface RawSong {
  id: number
  name: string
  ar?: { name?: string }[]
  artists?: { name?: string }[]
  al?: { id?: number; name?: string; picUrl?: string }
  album?: { id?: number; name?: string; picUrl?: string }
  dt?: number
  duration?: number
  alia?: string[]
  tns?: string[]
  no?: number
  cd?: string
  fee?: number
}

/** 每日推荐：返回条目原样交给 netease.ts 的 toTrack 归一化，reason 是"为什么推给你"。 */
export async function recommendDaily(session: Session, signal?: AbortSignal): Promise<{ tracks: RawSong[]; reasons: (string | null)[] }> {
  const body = await weapiPost<{ code?: number; recommend?: (RawSong & { reason?: string })[] }>('/weapi/v1/discovery/recommend/songs', {}, session, signal)
  const raw = body.recommend ?? []
  return { tracks: raw, reasons: raw.map((r) => r.reason ?? null) }
}

export async function likedIds(session: Session, userId: string, signal?: AbortSignal): Promise<string[]> {
  const body = await weapiPost<{ code?: number; ids?: unknown[] }>('/weapi/song/like/get', { uid: Number(userId) }, session, signal)
  const raw = body.ids ?? []
  if (!Array.isArray(raw)) throw new AstraError('NETEASE_BAD_RESPONSE', '喜欢列表的 ids 不是数组', { exitCode: 5 })
  return raw.map((x) => String(x)).filter((x) => /^\d+$/.test(x))
}

/**
 * 批量查喜欢状态。返回的 ids 是**已红心的子集**，没返回的就是没红心。
 * 一次最多 200 个，内部自动分批。
 */
export async function likedStatus(session: Session, trackIds: string[], signal?: AbortSignal): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  for (let i = 0; i < trackIds.length; i += 200) {
    const batch = trackIds.slice(i, i + 200)
    const body = await weapiPost<{ code?: number; ids?: unknown[] }>(
      '/weapi/song/like/check',
      { trackIds: JSON.stringify(batch.map(Number)) },
      session,
      signal,
    )
    const hit = new Set((body.ids ?? []).map((x) => String(x)))
    for (const id of batch) out.set(id, hit.has(id))
  }
  return out
}

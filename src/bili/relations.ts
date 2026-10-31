/**
 * B 站「我的关系」：关注 / 粉丝 / 关系统计。
 *
 * 实测（2026-11-01，大会员账号）：
 * - `/x/relation/stat?vmid=<mid>`  → `data.following` / `follower` / `black` / `whisper`，免登录也准
 * - `/x/relation/followings?vmid=<mid>&pn=&ps=50&order=desc` → `data.list[]` + `data.total`
 * - `/x/relation/fans?vmid=<mid>&pn=&ps=50&order=desc` → 同上，但**对方设了隐私就回 `-403`**
 *
 * 两个列表都必须带自己账号的 cookie：匿名访问别人的粉丝列表会被挡，
 * 访问自己的一样要给 `SESSDATA`（否则只能拿到公开账号的一小部分）。
 * 限速：连续翻页要间隔 2–3 秒，实测 434 个关注分 9 页拉完没触发风控。
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { cookieHeader, loadBiliSession } from './auth.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const PAGE_SIZE = 50

export interface RelationStat {
  mid: string
  following: number
  follower: number
  black: number
  whisper: number
}

export interface RelationUser {
  mid: number
  name: string
  sign: string
  /** 排序用：B 站没给关注时间，列表顺序即「最近关注在前」。 */
  index: number
}

export interface RelationPage {
  total: number
  items: RelationUser[]
}

interface RawRelationUser {
  mid?: number
  uname?: string
  sign?: string | null
}

/** 把接口原始条目拍平；`uname` 缺失（注销/封禁）时退回 mid 字符串。 */
export function mapRelationUser(raw: RawRelationUser, index: number): RelationUser {
  const mid = typeof raw.mid === 'number' ? raw.mid : 0
  const name = (raw.uname ?? '').trim()
  return { mid, name: name || `mid${mid}`, sign: (raw.sign ?? '').trim(), index }
}

export function selfMid(): string {
  const session = loadBiliSession()
  if (!session?.uid) {
    throw new AstraError('NOT_LOGGED_IN', '这个功能需要登录 B 站', { exitCode: 3, hint: '`astra bili login start`，让用户扫码' })
  }
  return session.uid
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
  if (body.code === -403) {
    throw new AstraError('BILI_PRIVATE', `${what}不可见：对方设置了隐私保护`, { exitCode: 4, hint: '只有本人登录才能看自己的完整列表' })
  }
  if (body.code === -352 || body.code === -412) {
    throw new AstraError('BILI_RATE_LIMITED', `${what}被风控（code=${String(body.code)}）`, {
      exitCode: 5,
      retryable: true,
      hint: '等几分钟再试，翻页间隔别小于 2 秒',
    })
  }
  if (body.code !== 0) {
    throw new AstraError('BILI_API_ERROR', `${what}失败（code=${String(body.code)}${body.message ? `：${body.message}` : ''}）`, { exitCode: 5 })
  }
  return body
}

/** 关系统计：关注数 / 粉丝数 / 黑名单。免登录也准。 */
export async function relationStat(mid?: string, signal?: AbortSignal): Promise<RelationStat> {
  const who = mid ?? selfMid()
  const body = await getJson<{ data?: { mid?: number; following?: number; follower?: number; black?: number; whisper?: number } }>(
    `https://api.bilibili.com/x/relation/stat?vmid=${encodeURIComponent(who)}`,
    '关系统计',
    signal,
  )
  const d = body.data ?? {}
  return {
    mid: String(d.mid ?? who),
    following: d.following ?? 0,
    follower: d.follower ?? 0,
    black: d.black ?? 0,
    whisper: d.whisper ?? 0,
  }
}

async function fetchList(kind: 'followings' | 'fans', mid: string, limit: number, signal?: AbortSignal): Promise<RelationPage> {
  const what = kind === 'followings' ? '关注列表' : '粉丝列表'
  const items: RelationUser[] = []
  let total = 0
  for (let page = 1; items.length < limit && page <= 40; page += 1) {
    const url =
      `https://api.bilibili.com/x/relation/${kind}?vmid=${encodeURIComponent(mid)}` +
      `&pn=${page}&ps=${PAGE_SIZE}&order=desc`
    const body = await getJson<{ data?: { list?: RawRelationUser[]; total?: number } }>(url, what, signal)
    const list = body.data?.list ?? []
    total = body.data?.total ?? total
    if (list.length === 0) break
    for (const raw of list) {
      items.push(mapRelationUser(raw, items.length))
      if (items.length >= limit) break
    }
  }
  return { total: total || items.length, items }
}

export function following(mid: string | undefined, limit: number, signal?: AbortSignal): Promise<RelationPage> {
  return fetchList('followings', mid ?? selfMid(), limit, signal)
}

export function fans(mid: string | undefined, limit: number, signal?: AbortSignal): Promise<RelationPage> {
  return fetchList('fans', mid ?? selfMid(), limit, signal)
}

// ---------------------------------------------------------------------------
// 关注分组（B 站叫「分组」，接口是 tag）
// ---------------------------------------------------------------------------

export interface FollowGroup {
  tagid: number
  name: string
  count: number
  tip: string
}

/** 关注分组列表。`tagid -10` = 特别关注，`0` = 默认分组，都是系统内置的。 */
export async function followGroups(signal?: AbortSignal): Promise<FollowGroup[]> {
  const body = await getJson<{ data?: { tagid?: number; name?: string; count?: number; tip?: string }[] }>(
    'https://api.bilibili.com/x/relation/tags',
    '关注分组',
    signal,
  )
  return (body.data ?? []).map((t) => ({
    tagid: typeof t.tagid === 'number' ? t.tagid : 0,
    name: (t.name ?? '').trim() || `tag${String(t.tagid)}`,
    count: typeof t.count === 'number' ? t.count : 0,
    tip: (t.tip ?? '').trim(),
  }))
}

/**
 * 按名字或 tagid 找分组。
 *
 * 优先精确匹配名字，其次唯一前缀匹配；都匹配不上就报错并列出可用名字
 * （不要静默退回第一个分组——用户会以为看到的是自己要的那组）。
 */
export function resolveGroup(groups: FollowGroup[], input: string): FollowGroup {
  const q = input.trim()
  if (!q) throw new AstraError('INVALID_INPUT', '分组名不能为空', { exitCode: 2 })
  if (/^-?\d+$/.test(q)) {
    const byId = groups.find((g) => g.tagid === Number(q))
    if (byId) return byId
  }
  const exact = groups.find((g) => g.name === q)
  if (exact) return exact
  const fuzzy = groups.filter((g) => g.name.includes(q))
  if (fuzzy.length === 1) {
    const [only] = fuzzy
    if (only) return only
  }
  if (fuzzy.length > 1) {
    throw new AstraError('AMBIGUOUS_GROUP', `「${q}」匹配到多个分组：${fuzzy.map((g) => g.name).join(' / ')}`, {
      exitCode: 2,
      hint: '换一个更完整的名字，或者直接用 tagid',
    })
  }
  throw new AstraError('GROUP_NOT_FOUND', `没有叫「${q}」的分组`, {
    exitCode: 4,
    hint: `可用分组：${groups.map((g) => g.name).join(' / ')}`,
  })
}

/**
 * 分组内的关注者。
 *
 * 注意 `/x/relation/tag` 的 `data` 是**扁平数组**（没有 total，也没有 cursor），
 * 总数得从 `/x/relation/tags` 的 `count` 拿；翻到空页即止。
 */
export async function groupMembers(tagid: number, limit: number, signal?: AbortSignal): Promise<RelationUser[]> {
  const items: RelationUser[] = []
  for (let page = 1; items.length < limit && page <= 40; page += 1) {
    const url = `https://api.bilibili.com/x/relation/tag?tagid=${tagid}&pn=${page}&ps=${PAGE_SIZE}&order=desc`
    const body = await getJson<{ data?: RawRelationUser[] | { list?: RawRelationUser[] } }>(url, '分组成员', signal)
    const raw = body.data
    const list = Array.isArray(raw) ? raw : (raw?.list ?? [])
    if (list.length === 0) break
    for (const r of list) {
      items.push(mapRelationUser(r, items.length))
      if (items.length >= limit) break
    }
  }
  return items
}

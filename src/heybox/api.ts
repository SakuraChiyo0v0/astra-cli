/**
 * 小黑盒只读接口（匿名）。
 *
 * 现状（2026-11 实测）：
 *  - `/bbs/app/feeds`、`/bbs/app/api/general/search/v1` 不带 cookie 就能拿数据；
 *  - `/bbs/app/link/tree`（帖子详情+评论）匿名请求会回 `show_captcha`，必须登录态，v1 不接。
 *
 * 所以这一层只做两条只读命令，别急着铺写接口：写接口要账号全权 + 验证码熔断。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { signPath } from './sign.ts'
import { AstraError } from '../core/errors.ts'
import { homePath } from '../core/paths.ts'

const API_ORIGIN = 'https://api.xiaoheihe.cn'
/**
 * 验证码冷却：小黑盒对**同一 cookie 的详情类接口**限得很死（实测连续两次就 show_captcha，
 * 冷却约 5 分钟）。命中后把到期时间落盘，冷却期内的调用直接失败，不再去撞接口——
 * 越撞冷却越长。
 */
const COOLDOWN_FILE = 'heybox-cooldown.json'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export interface HeyboxQuery {
  [key: string]: string | number | undefined
}

function baseParams(webVersion: string, heyboxId: string): Record<string, string> {
  return {
    os_type: 'web',
    app: 'heybox',
    client_type: 'web',
    version: '999.0.4',
    web_version: webVersion,
    x_client_type: 'web',
    x_app: 'heybox_website',
    heybox_id: heyboxId,
    x_os_type: 'Windows',
    device_info: 'Chrome',
  }
}

/** 发一条签名后的 GET，返回解析后的 JSON（`result` 部分由调用方取）。 */
export async function heyboxGet<T = Record<string, unknown>>(
  path: string,
  query: HeyboxQuery = {},
  options: {
    webVersion?: '2.5' | '3.0'
    heyboxId?: string
    /** 登录态（读详情用）；没有就走匿名，只读接口会回 show_captcha。 */
    credential?: { cookie: string; heyboxId: string } | null
    /** link/tree 要求 link_id 之前插一个裸标记 `h_src`。 */
    insertHSrc?: boolean
  } = {},
): Promise<T> {
  assertNotCooling(options.credential)

  const signed = signPath(path)
  const params = new URLSearchParams({
    ...baseParams(
      options.webVersion ?? '2.5',
      options.heyboxId ?? options.credential?.heyboxId ?? '',
    ),
    hkey: signed.hkey,
    _time: String(signed._time),
    nonce: signed.nonce,
  })
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }

  let qs = params.toString()
  if (options.insertHSrc) qs = qs.replace('&link_id=', '&h_src&link_id=')

  const headers: Record<string, string> = {
    'user-agent': UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    origin: 'https://www.xiaoheihe.cn',
    referer: 'https://www.xiaoheihe.cn/',
  }
  if (options.credential?.cookie) headers.cookie = options.credential.cookie

  let response: Response
  try {
    response = await fetch(`${API_ORIGIN}${path}?${qs}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new AstraError('NETWORK_ERROR', `请求小黑盒失败：${message}`, { retryable: true })
  }

  const text = await response.text()
  if (!response.ok) {
    throw new AstraError('HTTP_ERROR', `小黑盒返回 HTTP ${response.status}`, {
      retryable: response.status >= 500,
      details: { path, body: text.slice(0, 200) },
    })
  }

  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new AstraError('PARSE_ERROR', '小黑盒返回的不是 JSON', {
      details: { path, body: text.slice(0, 200) },
    })
  }

  const status = String(data.status ?? '')
  if (status === 'show_captcha') {
    markCooling(options.credential)
    throw new AstraError('CAPTCHA_REQUIRED', '小黑盒要求人机验证（详情接口对同一账号限得很死）', {
      hint: '等 5 分钟再试；频繁重试会延长冷却，必要时先在浏览器过一次验证',
      retryable: true,
      details: { cooldownSeconds: 300 },
    })
  }
  if (status && status !== 'ok') {
    throw new AstraError('UPSTREAM_ERROR', `小黑盒接口返回 status=${status}`, {
      details: { path, msg: data.msg ?? '' },
    })
  }
  return data as T
}

function cooldownPath(): string {
  return homePath(COOLDOWN_FILE)
}

function assertNotCooling(credential: { cookie: string; heyboxId: string } | null | undefined): void {
  if (!credential) return
  try {
    const data = JSON.parse(readFileSync(cooldownPath(), 'utf8')) as { until?: number }
    const left = Math.ceil(((data.until ?? 0) - Date.now()) / 1000)
    if (left > 0) {
      throw new AstraError('CAPTCHA_COOLDOWN', `验证码冷却中，还需 ${left} 秒`, {
        hint: '冷却结束后再试；期间不要重复请求，会延长冷却',
        retryable: true,
        details: { cooldownSeconds: left },
      })
    }
  } catch (error) {
    if (error instanceof AstraError) throw error
  }
}

function markCooling(credential: { cookie: string; heyboxId: string } | null | undefined): void {
  if (!credential) return
  try {
    writeFileSync(cooldownPath(), JSON.stringify({ until: Date.now() + 300_000 }))
  } catch {
    // 写不了就退化成「每次都会真的撞接口」，不影响主流程
  }
}

export interface HeyboxLink {
  linkid?: number
  title?: string
  description?: string
  userid?: number
  up?: number
  down?: number
  comment_num?: number
  create_at?: number
  imgs?: string[]
  topics?: Array<{ name?: string; app_id?: number }>
  [key: string]: unknown
}

/** 首页信息流。 */
export async function listFeeds(limit = 20, offset = 0): Promise<HeyboxLink[]> {
  const data = await heyboxGet<{ result?: { links?: HeyboxLink[] } }>('/bbs/app/feeds', {
    offset,
    pull: 0,
    limit,
  })
  return data.result?.links ?? []
}

/** 全站搜索，只保留帖子类结果（过滤掉「相关游戏」「筛选器」这些占位块）。 */
export async function searchLinks(keyword: string, limit = 20, offset = 0): Promise<HeyboxLink[]> {
  const data = await heyboxGet<{ result?: { items?: Array<{ type?: string; info?: HeyboxLink }> } }>(
    '/bbs/app/api/general/search/v1',
    { q: keyword, search_type: 'general', is_pull_down: 0, offset, limit, dw: 628 },
    { webVersion: '3.0' },
  )
  const items = data.result?.items ?? []
  return items.filter((item) => item.type === 'link' && item.info?.linkid).map((item) => item.info!)
}

const clean = (s: string): string => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

/** 帖子详情 + 首屏评论（必须登录态，匿名会 show_captcha）。 */
export async function getLinkTree(
  linkId: string | number,
  options: { page?: number; limit?: number; credential?: { cookie: string; heyboxId: string } | null } = {},
): Promise<{ link: Record<string, unknown> | null; comments: Array<Record<string, unknown>> }> {
  const page = options.page ?? 1
  const data = await heyboxGet<{
    result?: { link?: Record<string, unknown>; comments?: Array<Record<string, unknown>> }
  }>(
    '/bbs/app/link/tree',
    {
      link_id: String(linkId),
      is_first: page === 1 ? '1' : '0',
      page,
      index: 1,
      limit: options.limit ?? 20,
      owner_only: 0,
    },
    { credential: options.credential ?? null, insertHSrc: true },
  )
  return { link: data.result?.link ?? null, comments: data.result?.comments ?? [] }
}

/** 用一条最轻的接口验证登录态；返回 heybox_id（cookie 里没有时靠它补）。 */
export async function fetchSession(
  credential: { cookie: string; heyboxId: string },
): Promise<{ loggedIn: boolean; heyboxId: string }> {
  const data = await heyboxGet<{ result?: { messages?: unknown[] } }>(
    '/bbs/app/user/message',
    { list_type: 0, offset: 0, limit: 1, no_more: 'false' },
    { credential },
  )
  return { loggedIn: Array.isArray(data.result?.messages) || Boolean(data.result), heyboxId: credential.heyboxId }
}

/** 游戏搜索：返回候选（name / appid / 价格）。 */
export async function searchGames(keyword: string, limit = 5): Promise<Array<Record<string, unknown>>> {
  const data = await heyboxGet<{ result?: { games?: Array<Record<string, unknown>> } }>('/game/search', {
    q: keyword,
    offset: 0,
    limit,
  })
  return data.result?.games ?? []
}

/** 游戏详情：评分、价格（现价/史低）、关注数、平台、简介。 */
export async function getGameDetail(appid: number | string): Promise<Record<string, unknown> | null> {
  const data = await heyboxGet<{ result?: Record<string, unknown> }>('/game/get_game_detail', { appid: String(appid) })
  return data.result ?? null
}

/** 统一拍平成命令层用的形状。 */
export function mapLink(link: HeyboxLink): Record<string, unknown> {
  const created = link.create_at ? new Date(link.create_at * 1000) : null
  return {
    linkId: link.linkid ?? null,
    title: clean(link.title ?? '').slice(0, 80),
    summary: clean(link.description ?? '').slice(0, 120),
    userId: link.userid ?? null,
    topic: link.topics?.[0]?.name ?? null,
    // 信息流里的 up 恒为 0，真正的「赞」在 link_award_num
    up: Number(link.up || link.link_award_num || 0),
    down: link.down ?? 0,
    comments: link.comment_num ?? 0,
    images: (link.imgs ?? []).length,
    createdAt: created ? created.toISOString().slice(0, 16).replace('T', ' ') : null,
    url: link.linkid ? `https://www.xiaoheihe.cn/app/bbs/link/${link.linkid}` : null,
  }
}

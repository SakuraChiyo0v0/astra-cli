/**
 * 小黑盒只读接口（匿名）。
 *
 * 现状（2026-11 实测）：
 *  - `/bbs/app/feeds`、`/bbs/app/api/general/search/v1` 不带 cookie 就能拿数据；
 *  - `/bbs/app/link/tree`（帖子详情+评论）匿名请求会回 `show_captcha`，必须登录态，v1 不接。
 *
 * 所以这一层只做两条只读命令，别急着铺写接口：写接口要账号全权 + 验证码熔断。
 */
import { signPath } from './sign.ts'
import { AstraError } from '../core/errors.ts'

const API_ORIGIN = 'https://api.xiaoheihe.cn'
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
  options: { webVersion?: '2.5' | '3.0'; heyboxId?: string } = {},
): Promise<T> {
  const signed = signPath(path)
  const params = new URLSearchParams({
    ...baseParams(options.webVersion ?? '2.5', options.heyboxId ?? ''),
    hkey: signed.hkey,
    _time: String(signed._time),
    nonce: signed.nonce,
  })
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }

  let response: Response
  try {
    response = await fetch(`${API_ORIGIN}${path}?${params.toString()}`, {
      headers: {
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        origin: 'https://www.xiaoheihe.cn',
        referer: 'https://www.xiaoheihe.cn/',
      },
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
    throw new AstraError('CAPTCHA_REQUIRED', '小黑盒要求人机验证（这个接口通常需要登录态）', {
      hint: '等 5 分钟再试，或先在浏览器打开 https://www.xiaoheihe.cn 手动过验证',
      retryable: true,
    })
  }
  if (status && status !== 'ok') {
    throw new AstraError('UPSTREAM_ERROR', `小黑盒接口返回 status=${status}`, {
      details: { path, msg: data.msg ?? '' },
    })
  }
  return data as T
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

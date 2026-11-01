/**
 * 抖音 Web 接口的薄封装。
 *
 * 两种通道：
 * - **免签**（热榜、相似推荐）：什么都不用带，直接 GET。
 * - **签名保护**（详情 / 收藏 / 收藏夹）：要 `ttwid` + 自编 `uifid` + `x-secsdk-web-signature`。
 *   `ttwid` 可以从 ttwid.bytedance.com 白领，不需要登录。
 *
 * 未知一律按“风控”处理：200 + 空 body 在抖音这里是“被挡了”，不是“没有数据”。
 */
import { httpRequest } from '../core/http.ts'
import { AstraError, invalidInput } from '../core/errors.ts'
import { progress } from '../core/output.ts'
import {
  DOUYIN_UA, cookieHeader, parseCookies, randomUifid, signHeaders, signQuery, uifidFromCookie, type Pair,
} from './sign.ts'

const WEB_BASE: Pair[] = [
  ['device_platform', 'webapp'],
  ['aid', '6383'],
  ['channel', 'channel_pc_web'],
  ['pc_client_type', '1'],
  ['version_code', '190500'],
  ['version_name', '19.5.0'],
  ['cookie_enabled', 'true'],
  ['screen_width', '1920'],
  ['screen_height', '1080'],
  ['browser_language', 'zh-CN'],
  ['browser_platform', 'Win32'],
  ['browser_name', 'Chrome'],
  ['browser_version', '131.0.0.0'],
  ['browser_online', 'true'],
  ['engine_name', 'Blink'],
  ['engine_version', '131.0.0.0'],
  ['os_name', 'Windows'],
  ['os_version', '10'],
  ['cpu_core_num', '8'],
  ['device_memory', '8'],
  ['platform', 'PC'],
  ['downlink', '10'],
  ['effective_type', '4g'],
  ['round_trip_time', '50'],
]

let cachedTtwid: string | null = null

/** 领一个游客 ttwid（不需要登录，也不需要签名）。 */
export async function mintTtwid(): Promise<string> {
  if (cachedTtwid) return cachedTtwid
  const response = await httpRequest('https://ttwid.bytedance.com/ttwid/union/register/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': DOUYIN_UA },
    body: JSON.stringify({ region: 'cn', aid: 6383, need_t: 1, service: 'www.douyin.com', domain: '.douyin.com' }),
    timeoutMs: 15_000,
  })
  const raw = response.headers.get('set-cookie') ?? ''
  const match = /ttwid=([^;]+)/.exec(raw)
  if (!match) {
    throw new AstraError('DOUYIN_TTWID_FAILED', '拿不到 ttwid', {
      exitCode: 5,
      retryable: true,
      hint: 'ttwid.bytedance.com 没回 Set-Cookie；重试一次，仍然失败就是上游变了',
    })
  }
  cachedTtwid = match[1]!
  return cachedTtwid
}

export interface ApiOptions {
  /** 登录态 cookie 串；不传 = 游客（只有免签接口能用）。 */
  cookie?: string | null
  signal?: AbortSignal
}

async function send(url: string, init: { method?: string; headers: Record<string, string> }, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  const response = await httpRequest(url, {
    ...init,
    ...(signal ? { signal } : {}),
    timeoutMs: 25_000,
  })
  return { status: response.status, text: await response.text() }
}

/** 免签 GET。 */
export async function unsignedGet(path: string, pairs: Pair[], options: ApiOptions = {}): Promise<unknown> {
  const url = `https://www.douyin.com${path}?${new URLSearchParams(pairs).toString()}`
  const headers: Record<string, string> = {
    'User-Agent': DOUYIN_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: 'https://www.douyin.com/',
  }
  if (options.cookie) headers.Cookie = options.cookie
  const { status, text } = await send(url, { headers }, options.signal)
  return parseBody(path, status, text)
}

/**
 * 签名 GET。`ttwid` 用登录态里带的那个，没有就现领一个。
 */
export async function signedGet(path: string, extra: Pair[], options: ApiOptions = {}): Promise<unknown> {
  const jar = parseCookies(options.cookie ?? '')
  const ttwid = jar.ttwid ?? (await mintTtwid())
  const uifid = uifidFromCookie(options.cookie ?? '') ?? randomUifid()
  const timestamp = Math.floor(Date.now() / 1000)
  const { query, signature } = signQuery([...WEB_BASE, ...extra], uifid, timestamp)

  const headers: Record<string, string> = {
    'User-Agent': DOUYIN_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: 'https://www.douyin.com/',
    ...signHeaders(uifid, signature, timestamp),
  }
  const cookieParts = [cookieHeader(jar)]
  if (!jar.ttwid) cookieParts.push(`ttwid=${ttwid}`)
  if (!uifidFromCookie(options.cookie ?? '')) cookieParts.push(`uifid=${uifid}`)
  headers.Cookie = cookieParts.filter(Boolean).join('; ')

  const url = `https://www.douyin.com${path}?${query}&x-secsdk-web-signature=${signature}`
  progress('douyin.request', { path })
  const { status, text } = await send(url, { headers }, options.signal)
  return parseBody(path, status, text)
}

function parseBody(path: string, status: number, text: string): unknown {
  if (status === 403) {
    throw new AstraError('DOUYIN_SIGNATURE_REJECTED', `抖音拒绝了签名（${path}）`, {
      exitCode: 5,
      hint: '签名盐值可能变了（WEB_SIGN_SALT），或该接口改了保护策略；先跑 `astra douyin doctor`',
      details: { status, preview: text.slice(0, 160) },
    })
  }
  if (status >= 400) {
    throw new AstraError('DOUYIN_HTTP_ERROR', `抖音返回 HTTP ${status}`, {
      exitCode: 5,
      retryable: status >= 500,
      details: { status, preview: text.slice(0, 160) },
    })
  }
  // 200 + 空 body：抖音的“被挡了”，不是“没有数据”。踩过：把它当成空列表会静默少下。
  if (!text.trim()) {
    throw new AstraError('DOUYIN_BLOCKED', `请求被抖音挡住了（${path} 返回空）`, {
      exitCode: 5,
      retryable: true,
      hint: '多半是风控：等几分钟重试；登录态过期的话先 `astra douyin login`',
      details: { path },
    })
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AstraError('DOUYIN_BAD_RESPONSE', `返回的不是 JSON（${path}）`, {
      exitCode: 5,
      details: { preview: text.slice(0, 160) },
    })
  }
}

// ——————————————————— 具体接口 ———————————————————

export interface RawAweme {
  aweme_id?: string
  desc?: string
  create_time?: number
  aweme_type?: number
  author?: { nickname?: string; sec_uid?: string; unique_id?: string }
  video?: {
    duration?: number
    width?: number
    height?: number
    cover?: { url_list?: string[] }
    origin_cover?: { url_list?: string[] }
    play_addr?: { uri?: string; url_list?: string[]; data_size?: number }
    download_addr?: { uri?: string; url_list?: string[]; data_size?: number }
    bit_rate?: {
      gear_name?: string
      bit_rate?: number
      is_h265?: number
      quality_type?: number
      FPS?: number
      /** `mp4` = 音视频合一，`dash` = 纯视频轨（没有音轨）。 */
      format?: string
      play_addr?: { url_list?: string[]; data_size?: number; width?: number; height?: number }
    }[]
  }
  images?: {
    uri?: string
    width?: number
    height?: number
    url_list?: string[]
    download_url_list?: string[]
    video?: unknown
  }[]
  music?: { title?: string; play_url?: { uri?: string; url_list?: string[] } }
  statistics?: Record<string, number>
  filter_detail?: { detail_msg?: string; filter_reason?: string }
}

interface DetailEnvelope {
  status_code?: number
  status_msg?: string
  aweme_detail?: RawAweme | null
  filter_detail?: { detail_msg?: string; filter_reason?: string }
}

export async function fetchAwemeDetail(awemeId: string, options: ApiOptions = {}): Promise<RawAweme> {
  const body = (await signedGet('/aweme/v1/web/aweme/detail/', [['aweme_id', awemeId]], options)) as DetailEnvelope
  if (body.aweme_detail && body.aweme_detail.aweme_id) return body.aweme_detail
  const filter = body.filter_detail
  if (filter) {
    throw new AstraError('DOUYIN_UNAVAILABLE', filter.detail_msg ?? '这条作品看不到', {
      exitCode: 4,
      hint: '作品被删 / 仅作者可见 / 有年龄或地区限制，重试没用',
      details: { awemeId, reason: filter.filter_reason ?? null },
    })
  }
  throw new AstraError('DOUYIN_BLOCKED', '详情接口没给作品数据', {
    exitCode: 5,
    retryable: true,
    hint: '通常是风控，等几分钟再试',
    details: { awemeId, statusCode: body.status_code ?? null },
  })
}

export async function fetchRelated(awemeId: string, options: ApiOptions = {}): Promise<RawAweme[]> {
  // 这个接口只认固定档位的 count：实测 count=10 正常（约 950KB），count=12 直接回空 body。
  // 所以固定 10，需要更多由调用方自己再翻。
  const body = (await unsignedGet('/aweme/v1/web/aweme/related/', [
    ...WEB_BASE,
    ['aweme_id', awemeId],
    ['count', '10'],
  ], options)) as { aweme_list?: RawAweme[] }
  return body.aweme_list ?? []
}

export interface HotWord {
  word: string
  hotValue: number | null
  position: number | null
  sentenceId: string | null
}

export async function fetchHotSearch(options: ApiOptions = {}): Promise<HotWord[]> {
  const body = (await unsignedGet('/aweme/v1/web/hot/search/list/', [
    ['device_platform', 'webapp'],
    ['aid', '6383'],
    ['detail_list', '1'],
  ], options)) as { data?: { word_list?: { word?: string; hot_value?: number; position?: number; sentence_id?: string }[] } }
  return (body.data?.word_list ?? []).map((w) => ({
    word: w.word ?? '',
    hotValue: w.hot_value ?? null,
    position: w.position ?? null,
    sentenceId: w.sentence_id ?? null,
  }))
}

export interface FavoritePage {
  items: RawAweme[]
  hasMore: boolean
  maxCursor: string | null
}

/** 「收藏」（点赞旁边那个星标）。**必须登录**。 */
export async function fetchFavorites(cursor: string | number, count: number, options: ApiOptions = {}): Promise<FavoritePage> {
  if (!options.cookie) {
    throw new AstraError('DOUYIN_NOT_LOGGED_IN', '取收藏需要登录态', {
      exitCode: 3,
      hint: '先 `astra douyin login` 粘贴浏览器里的 cookie（Copy as cURL）',
    })
  }
  const body = (await signedGet('/aweme/v1/web/aweme/favorite/', [
    ['count', String(count)],
    ['max_cursor', String(cursor)],
  ], options)) as { status_code?: number; aweme_list?: RawAweme[]; has_more?: number | boolean; max_cursor?: number | string }
  if (body.status_code === 8) {
    throw new AstraError('DOUYIN_NOT_LOGGED_IN', '登录态无效或已过期', {
      exitCode: 3,
      hint: '重新 `astra douyin login` 粘贴一份新的 cookie',
    })
  }
  return {
    items: body.aweme_list ?? [],
    hasMore: body.has_more === 1 || body.has_more === true,
    maxCursor: body.max_cursor === undefined ? null : String(body.max_cursor),
  }
}

/** 收藏夹（用户自己建的夹子）列表。 */
export async function fetchCollects(options: ApiOptions = {}): Promise<{ id: string; name: string; count: number | null }[]> {
  const body = (await signedGet('/aweme/v1/web/collects/list/', [
    ['count', '20'],
    ['cursor', '0'],
  ], options)) as { collects_list?: { collects_id?: string; collects_name?: string; total_number?: number }[]; status_code?: number }
  if (body.status_code === 8) {
    throw new AstraError('DOUYIN_NOT_LOGGED_IN', '登录态无效或已过期', {
      exitCode: 3,
      hint: '重新 `astra douyin login`',
    })
  }
  return (body.collects_list ?? []).map((c) => ({
    id: String(c.collects_id ?? ''),
    name: c.collects_name ?? '',
    count: c.total_number ?? null,
  }))
}

export interface WhoAmI {
  loggedIn: boolean
  nickname: string | null
  uid: string | null
  statusCode: number | null
}

export async function whoAmI(cookie: string, signal?: AbortSignal): Promise<WhoAmI> {
  const url = 'https://www.douyin.com/webcast/user/me/?aid=6383'
  const { status, text } = await send(url, {
    headers: {
      'User-Agent': DOUYIN_UA,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.douyin.com/',
      Cookie: cookie,
    },
  }, signal)
  if (!text.trim()) return { loggedIn: false, nickname: null, uid: null, statusCode: status }
  const body = JSON.parse(text) as {
    status_code?: number
    data?: { user?: { nickname?: string; uid?: string }; nickname?: string; uid?: string }
  }
  const user = body.data?.user ?? body.data ?? {}
  return {
    loggedIn: body.status_code === 0,
    nickname: user.nickname ?? null,
    uid: user.uid ?? null,
    statusCode: body.status_code ?? null,
  }
}

/** 从 19 位 id / 视频链接 / 图文链接 / 分享口令里取 aweme_id；短链走一次 302。 */
export async function resolveAwemeId(input: string, signal?: AbortSignal): Promise<string> {
  const text = input.trim()
  const byId = /^\d{15,20}$/.exec(text)
  if (byId) return byId[0]

  const direct = /(?:video|note|share\/video|share\/note)\/(\d{15,20})/.exec(text)
  if (direct) return direct[1]!

  const short = /https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/.exec(text)
  if (!short) {
    throw invalidInput(`看不出这是哪个作品：${text.slice(0, 60)}`, '给 19 位作品 id、`https://v.douyin.com/xxx/` 或 `https://www.douyin.com/video/<id>`')
  }
  const response = await httpRequest(short[0], {
    headers: { 'User-Agent': DOUYIN_UA, Referer: 'https://www.douyin.com/' },
    ...(signal ? { signal } : {}),
  })
  const finalUrl = response.url || ''
  await response.body?.cancel()
  const followed = /(?:video|note|share\/video|share\/note)\/(\d{15,20})/.exec(finalUrl)
  if (followed) return followed[1]!
  if (finalUrl.includes('webcast')) {
    throw new AstraError('DOUYIN_LIVE_UNSUPPORTED', '这是直播间的短链，不是作品', {
      exitCode: 4,
      hint: '直播流还没做；作品链接形如 `https://www.douyin.com/video/<id>`',
    })
  }
  throw new AstraError('DOUYIN_BAD_TARGET', `短链没解析出作品 id：${finalUrl.slice(0, 80)}`, {
    exitCode: 4,
    hint: '把浏览器里视频页的完整链接直接给过来',
  })
}

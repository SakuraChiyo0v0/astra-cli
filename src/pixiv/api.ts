/**
 * Pixiv web/ajax 接口客户端。
 *
 * ## 为什么不用 App API / gallery-dl
 *
 * Pixiv 的 App API 要 refresh-token（30 秒窗口的 OAuth，在聊天里基本拿不到），
 * 而 **web/ajax 接口匿名就能用**：作品详情、画师作品列表、排行榜、搜索都通，
 * 原图在 `i.pximg.net` 上也只要带 `Referer` 就能直下（2026-10 实测）。
 * 所以这里直接走 ajax，cookie 是**可选**的——有就用（能看更多），没有也能跑。
 *
 * ## 两个必须带的东西
 *
 * - `Referer: https://www.pixiv.net/`：图片 CDN 没有它直接 403。
 * - 浏览器 UA：不带会被 Cloudflare 拦（和 Civitai 那次 1010 是同一类问题）。
 *
 * ## 代理
 *
 * 容器直连 pixiv.net 超时，必须走 `proxy.url`（mihomo）。这里不自己处理代理，
 * 统一交给 `core/http.ts`——但**域名必须先进 `proxy.include`**，否则连接超时，
 * 表现像"站点挂了"。
 */
import { existsSync, readFileSync, rmSync, chmodSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { AstraError } from '../core/errors.ts'
import { getConfig } from '../core/config.ts'
import { httpJson, httpRequest } from '../core/http.ts'
import { proxyConfig, shouldProxy } from '../core/proxy.ts'
import { ensureDir, homePath } from '../core/paths.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://www.pixiv.net'

export const COOKIE_FILE = () => homePath('pixiv-cookie.txt')

/** cookie 是可选增强，不是必需项：读不到就当匿名。 */
export function loadCookie(): string {
  const file = COOKIE_FILE()
  if (!existsSync(file)) return ''
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

export function saveCookie(raw: string): void {
  ensureDir(homePath())
  const file = COOKIE_FILE()
  writeFileSync(file, raw.trim())
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows 上 chmod 无效，忽略
  }
}

export function clearCookie(): boolean {
  const file = COOKIE_FILE()
  const existed = existsSync(file)
  if (existed) rmSync(file, { force: true })
  return existed
}

/** cookie 里只回显 `PHPSESSID` 是否存在，绝不回显值。 */
export function cookieDigest(raw: string): { has: boolean; keys: number } {
  if (!raw) return { has: false, keys: 0 }
  const keys = raw.split(';').map((p) => p.split('=')[0]?.trim()).filter(Boolean)
  return { has: keys.includes('PHPSESSID'), keys: keys.length }
}

function headers(extra: Record<string, string> = {}, noCookie = false): Record<string, string> {
  const cookie = noCookie ? '' : loadCookie()
  return {
    'User-Agent': UA,
    Referer: `${BASE}/`,
    Accept: 'application/json',
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  }
}

/**
 * curl 的调用参数（纯函数，方便单测）。
 *
 * 为什么要 curl：Cloudflare 按 TLS/HTTP 指纹判定。Node 的 undici **带 cookie** 请求
 * www.pixiv.net 会被 403；同一个 cookie 换成 curl 就是 200（2026-10-28 实测，
 * 当时日报 50 张只下到 16 张，34 条 403 就是它造成的）。
 */
export function curlArgs(url: string, cookie: string, proxyUrl: string | null): string[] {
  const args = [
    '-sS', // 静默但保留错误
    '--max-time', '30',
    '--compressed',
    '-H', `User-Agent: ${UA}`,
    '-H', `Referer: ${BASE}/`,
    '-H', 'Accept: application/json',
  ]
  if (cookie) args.push('-H', `Cookie: ${cookie}`)
  if (proxyUrl) args.push('-x', proxyUrl)
  args.push(url)
  return args
}

/** 走 curl 子进程拿 JSON。只在需要带 cookie 时用（匿名用 fetch 更快）。 */
async function curlJson<T>(url: string, cookie: string): Promise<T> {
  const host = new URL(url).host
  const proxyUrl = shouldProxy(host) ? (proxyConfig()?.url ?? null) : null
  const args = curlArgs(url, cookie, proxyUrl)
  const { code, stdout, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      err += String(chunk)
    })
    child.on('error', (error) => reject(new AstraError('NETWORK_ERROR', `curl 起不来：${error.message}`, { exitCode: 5 })))
    child.on('close', (exitCode) => resolve({ code: exitCode ?? 1, stdout: out, stderr: err }))
  })
  if (code !== 0) {
    // curl 的 22 = HTTP >= 400（配合 -f 才有）；这里没用 -f，所以非 0 基本都是网络/代理问题
    throw new AstraError('NETWORK_ERROR', `curl 请求 ${host} 失败（退出码 ${code}）：${stderr.trim().slice(0, 200)}`, {
      exitCode: 5,
      retryable: true,
    })
  }
  // curl 不带 -w 拿不到状态码，用 -w 会污染 body；这里靠 body 是不是 JSON 判断，
  // 4xx 的 body 通常不是 JSON，会落到下面的 BAD_RESPONSE。
  try {
    return JSON.parse(stdout) as T
  } catch {
    throw new AstraError('HTTP_ERROR', `${host} 返回的不是 JSON（可能被拦或登录态失效）`, {
      exitCode: 5,
      details: { preview: stdout.slice(0, 120) },
    })
  }
}

/** 该用哪条通道：有 cookie 且没被强制 fetch 时走 curl。 */
export function pickTransport(cookie: string): 'curl' | 'fetch' {
  const mode = (getConfig('pixiv.transport') || 'auto').trim()
  if (mode === 'curl') return 'curl'
  if (mode === 'fetch') return 'fetch'
  return cookie ? 'curl' : 'fetch'
}

/** 统一出口：按 `pixiv.transport` 决定走 curl 还是 fetch（ranking 这类非 ajax 接口也要走它）。 */
async function getJson<T>(url: string, accept = 'application/json'): Promise<T> {
  const cookie = loadCookie()
  if (pickTransport(cookie) === 'curl') return curlJson<T>(url, cookie)
  return httpJson<T>(url, { headers: headers({ Accept: accept }), timeoutMs: 20_000 })
}

async function ajax<T>(path: string, opts: { noCookie?: boolean } = {}): Promise<T> {
  const url = `${BASE}${path}`
  const raw = opts.noCookie === true
    // 故意匿名的那条路（cookie check 要拿它做对照），必须走 fetch 且不带 cookie
    ? await httpJson<{ error: boolean; message?: string; body: T }>(url, {
        headers: headers({}, true),
        timeoutMs: 20_000,
      })
    : await getJson<{ error: boolean; message?: string; body: T }>(url)
  if (raw.error) {
    throw new AstraError('PIXIV_ERROR', `pixiv 返回错误：${raw.message ?? '未知'}`, {
      exitCode: 4,
      details: { path },
    })
  }
  return raw.body
}

export interface IllustDetail {
  id: string
  title: string
  userId: string
  userName: string
  pageCount: number
  xRestrict: number
  /** 安全等级：2 = 一般，4 = 轻度，6 = 有性表现。匿名访客拿不到 >=4 的图。 */
  sl: number
  illustType: number
  width: number
  height: number
  tags: string[]
  urls: { original: string; regular: string; small: string }
}

interface RawIllust {
  illustId?: string
  illustTitle?: string
  userId?: string
  userName?: string
  pageCount?: number
  xRestrict?: number
  sl?: number
  illustType?: number
  width?: number
  height?: number
  tags?: { tags?: { tag?: string }[] }
  urls?: { original?: string; regular?: string; small?: string }
}

export async function illustDetail(illustId: number): Promise<IllustDetail> {
  const body = await ajax<RawIllust>(`/ajax/illust/${illustId}`)
  const urls = body.urls ?? {}
  if (!urls.original) {
    throw new AstraError('PIXIV_ERROR', '拿不到原图地址（作品可能已删除或仅登录可见）', {
      exitCode: 4,
      details: { illustId },
    })
  }
  return {
    id: String(body.illustId ?? illustId),
    title: body.illustTitle ?? '',
    userId: String(body.userId ?? ''),
    userName: body.userName ?? '',
    pageCount: body.pageCount ?? 1,
    xRestrict: body.xRestrict ?? 0,
    sl: body.sl ?? 0,
    illustType: body.illustType ?? 0,
    width: body.width ?? 0,
    height: body.height ?? 0,
    tags: (body.tags?.tags ?? []).map((t) => t.tag ?? '').filter(Boolean),
    urls: {
      original: urls.original,
      regular: urls.regular ?? urls.original,
      small: urls.small ?? urls.regular ?? urls.original,
    },
  }
}

/** 画师全部作品 id（插画 + 漫画），按 id 倒序（新的在前）。
 *
 *  **过期 cookie 会让 pixiv 静默返回空列表**（不报错、HTTP 200），订阅会因此永远「没有新作品」。
 *  所以带 cookie 拿到空结果时，无 cookie 重试一次——匿名能看的部分照样能拿到。 */
export async function userWorks(userId: number): Promise<number[]> {
  const ids = await userWorksOnce(userId, false)
  if (ids.length || !loadCookie()) return ids
  return userWorksOnce(userId, true)
}

async function userWorksOnce(userId: number, noCookie: boolean): Promise<number[]> {
  const body = await ajax<{ illusts?: Record<string, unknown>; manga?: Record<string, unknown> }>(
    `/ajax/user/${userId}/profile/all`,
    { noCookie },
  )
  const ids = [...Object.keys(body.illusts ?? {}), ...Object.keys(body.manga ?? {})]
  return [...new Set(ids.map(Number).filter((n) => Number.isFinite(n)))].sort((a, b) => b - a)
}

export type RankMode = 'daily' | 'weekly' | 'monthly' | 'rookie' | 'original' | 'male' | 'female'

export async function ranking(mode: RankMode, pages = 1): Promise<number[]> {
  const out: number[] = []
  for (let p = 1; p <= pages; p += 1) {
    const url = `${BASE}/ranking.php?mode=${mode}&content=illust&format=json&p=${p}`
    const data = await getJson<{ contents?: { illust_id?: number }[] }>(url)
    out.push(...(data.contents ?? []).map((c) => Number(c.illust_id)).filter((n) => Number.isFinite(n)))
  }
  return out
}

/** 作品的互动数据。`bookmarkCount` 匿名也能拿到——`人気順` 排序是会员功能，
 *  但「按收藏数本地排序」不用会员，这是 `pixiv top` 的基础。 */
export interface IllustStats {
  id: number
  bookmarkCount: number
  likeCount: number
  viewCount: number
}

export async function illustStats(illustId: number): Promise<IllustStats> {
  const body = await ajax<{ bookmarkCount?: number; likeCount?: number; viewCount?: number }>(
    `/ajax/illust/${illustId}`,
  )
  return {
    id: illustId,
    bookmarkCount: body.bookmarkCount ?? 0,
    likeCount: body.likeCount ?? 0,
    viewCount: body.viewCount ?? 0,
  }
}

export interface SearchHit {
  id: number
  title: string
  userName: string
  userId: number
  pageCount: number
  xRestrict: number
  /** 安全等级：2=一般 / 4=轻度 / 6=敏感。搜索结果自带，不用额外请求。 */
  sl: number
  /** 0=插画 1=漫画 2=动图。pixiv 的 `type` 参数在 ajax 搜索里被忽略（实测
   *  `type=illust` 和 `type=manga` 返回完全相同的数据），所以分类只能拿这个字段本地过滤。 */
  illustType: number
}

/** pixiv 的 tag 匹配方式：`s_tag_full` 完全一致 / `s_tag` 部分一致 / `s_tc` 标题与说明。 */
export type SearchMode = 's_tag_full' | 's_tag' | 's_tc'

export interface SearchPage {
  hits: SearchHit[]
  total: number
  /** 这个关键词在 pixiv 上真正被用的标签（别名的主要来源，如 绝区零 凯撒 → キング・シーザー）。 */
  relatedTags: string[]
}

interface RawSearch {
  illustManga?: {
    data?: {
      id?: string
      title?: string
      userName?: string
      userId?: string
      pageCount?: number
      xRestrict?: number
      sl?: number
      illustType?: number
    }[]
    total?: number
  }
  relatedTags?: (string | { tag?: string })[]
}

export async function searchPage(keyword: string, page: number, sMode: SearchMode, noCookie = false): Promise<SearchPage> {
  const q = new URLSearchParams({
    word: keyword,
    order: 'date_d',
    mode: 'all',
    p: String(page),
    s_mode: sMode,
    type: 'all',
    lang: 'zh',
  })
  const body = await ajax<RawSearch>(`/ajax/search/artworks/${encodeURIComponent(keyword)}?${q.toString()}`, { noCookie })
  const hits = (body.illustManga?.data ?? [])
    .map((d) => ({
      id: Number(d.id),
      title: d.title ?? '',
      userName: d.userName ?? '',
      userId: Number(d.userId ?? 0),
      pageCount: d.pageCount ?? 1,
      xRestrict: d.xRestrict ?? 0,
      sl: d.sl ?? 0,
      illustType: d.illustType ?? 0,
    }))
    .filter((d) => Number.isFinite(d.id))
  const relatedTags = (body.relatedTags ?? [])
    .map((t) => (typeof t === 'string' ? t : (t.tag ?? '')))
    .filter(Boolean)
  return { hits, total: body.illustManga?.total ?? hits.length, relatedTags }
}

export async function searchHits(keyword: string, page = 1): Promise<SearchHit[]> {
  return (await searchPage(keyword, page, 's_tag_full')).hits
}

export async function searchWorks(keyword: string, page = 1): Promise<number[]> {
  return (await searchHits(keyword, page)).map((h) => h.id)
}

/** 把关键词拆成候选片段：`カエサル・キング` → `['カエサル','キング']`。
 *  单片段返回空数组（没什么可拆的，别让回退退化成重查自己）。 */
export function searchTokens(keyword: string): string[] {
  const parts = keyword
    .split(/[・･·/／,，、+＋\s]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  const uniq = [...new Set(parts)]
  return uniq.length > 1 ? uniq : []
}

export type MatchKind = 'tag' | 'tag_partial' | 'caption' | 'token'

export interface SearchAttempt {
  keyword: string
  sMode: SearchMode
  matchedBy: MatchKind
}

/** 搜索回退顺序（纯函数，方便测）：精确 tag → 部分 tag → 标题/说明 → 分词逐个查。
 *
 *  为什么要回退：pixiv 的角色 tag 常常不是角色全名（绝区零凯撒是 `キング・シーザー`，
 *  不是 `カエサル・キング`），`s_tag_full` 是全词精确匹配，写错一个字就是 0 条。
 *  实测 `カエサル・キング` 在 pixiv 上 total=0，而 `绝区零 凯撒` 有 44 条。 */
export function searchPlan(keyword: string, page = 1): SearchAttempt[] {
  const plan: SearchAttempt[] = [
    { keyword, sMode: 's_tag_full', matchedBy: 'tag' },
    { keyword, sMode: 's_tag', matchedBy: 'tag_partial' },
    { keyword, sMode: 's_tc', matchedBy: 'caption' },
  ]
  // 分词只在第一页有意义：翻页时换关键词会让页数语义彻底乱掉。
  if (page <= 1) {
    for (const t of searchTokens(keyword)) plan.push({ keyword: t, sMode: 's_tag_full', matchedBy: 'token' })
  }
  return plan
}

export interface ResolvedSearch extends SearchPage {
  /** 用户输入的原关键词。 */
  keyword: string
  /** 真正命中结果的词（回退时可能和 keyword 不同）。 */
  matchedKeyword: string
  matchedBy: MatchKind
  sMode: SearchMode
  /** true = 带 cookie 全空、去掉 cookie 才搜到，说明存的 cookie 已过期。 */
  cookieStale: boolean
}

async function runPlan(
  keyword: string,
  page: number,
  noCookie: boolean,
): Promise<{ r: SearchPage; a: SearchAttempt } | null> {
  let last: { a: SearchAttempt; r: SearchPage } | null = null
  for (const a of searchPlan(keyword, page)) {
    let r: SearchPage
    try {
      r = await searchPage(a.keyword, page, a.sMode, noCookie)
    } catch {
      continue
    }
    last = { a, r }
    if (r.hits.length) return { r, a }
  }
  return last
}

/** 按 `searchPlan` 逐级放宽，返回第一个有结果的尝试；全空则回最后一次的结果。
 *
 *  **过期 cookie 是最大的坑**：pixiv 对失效的 `PHPSESSID` 不报错，而是静默返回空结果
 *  （HTTP 200 + `total:0`）。表现就像「这个词查不到」，还会触发一整套回退重试。
 *  所以带 cookie 全空时，无 cookie 再来一轮，命中了就用匿名结果并标 `cookieStale`。 */
export async function resolveSearch(keyword: string, page = 1): Promise<ResolvedSearch> {
  const withCookie = await runPlan(keyword, page, false)
  if (withCookie?.r.hits.length || !loadCookie()) {
    const hit = withCookie
    if (!hit) {
      return { hits: [], total: 0, relatedTags: [], keyword, matchedKeyword: keyword, matchedBy: 'tag', sMode: 's_tag_full', cookieStale: false }
    }
    return {
      ...hit.r,
      keyword,
      matchedKeyword: hit.a.keyword,
      matchedBy: hit.a.matchedBy,
      sMode: hit.a.sMode,
      cookieStale: false,
    }
  }
  const anonymous = await runPlan(keyword, page, true)
  if (anonymous?.r.hits.length) {
    return {
      ...anonymous.r,
      keyword,
      matchedKeyword: anonymous.a.keyword,
      matchedBy: anonymous.a.matchedBy,
      sMode: anonymous.a.sMode,
      cookieStale: true,
    }
  }
  const fallback = anonymous ?? withCookie
  if (!fallback) {
    return { hits: [], total: 0, relatedTags: [], keyword, matchedKeyword: keyword, matchedBy: 'tag', sMode: 's_tag_full', cookieStale: false }
  }
  return {
    ...fallback.r,
    keyword,
    matchedKeyword: fallback.a.keyword,
    matchedBy: fallback.a.matchedBy,
    sMode: fallback.a.sMode,
    cookieStale: false,
  }
}

/** 多页作品的原图地址要把 `_p0` 换成对应页号。 */
export function pageUrls(detail: IllustDetail): { original: string; regular: string; page: number; ext: string }[] {
  const out: { original: string; regular: string; page: number; ext: string }[] = []
  for (let p = 0; p < Math.max(1, detail.pageCount); p += 1) {
    // `_p0.jpg`（原图）和 `_p0_master1200.jpg`（1200px）两种都要换，
    // 所以看的是 `_p<数字>` 后面紧跟 `.` 或 `_`，不能只匹配 `_p0.`。
    const swap = (url: string) => url.replace(/_p\d+(?=[._])/, `_p${p}`)
    const original = detail.pageCount === 1 ? detail.urls.original : swap(detail.urls.original)
    const regular = detail.pageCount === 1 ? detail.urls.regular : swap(detail.urls.regular)
    const ext = original.match(/\.(jpg|jpeg|png|gif|webp)(?:\?|$)/i)?.[1]?.toLowerCase() ?? 'jpg'
    out.push({ original, regular, page: p, ext })
  }
  return out
}

/** 下载一张图。CDN 必须带 Referer，否则 403。 */
export async function downloadImage(url: string): Promise<Buffer> {
  const res = await httpRequest(url, {
    headers: { 'User-Agent': UA, Referer: `${BASE}/`, Accept: 'image/*,*/*' },
    timeoutMs: 60_000,
    retries: 1,
  })
  if (!res.ok) {
    throw new AstraError('HTTP_ERROR', `图片下载失败：HTTP ${res.status}`, {
      exitCode: 5,
      details: { url: url.replace('https://i.pximg.net', ''), status: res.status },
    })
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength === 0) throw new AstraError('EMPTY_BODY', '图片下载回来是空的', { exitCode: 5 })
  return buf
}

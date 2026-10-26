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
import { AstraError } from '../core/errors.ts'
import { httpJson, httpRequest } from '../core/http.ts'
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

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const cookie = loadCookie()
  return {
    'User-Agent': UA,
    Referer: `${BASE}/`,
    Accept: 'application/json',
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  }
}

async function ajax<T>(path: string): Promise<T> {
  const raw = await httpJson<{ error: boolean; message?: string; body: T }>(`${BASE}${path}`, {
    headers: headers(),
    timeoutMs: 20_000,
  })
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

/** 画师全部作品 id（插画 + 漫画），按 id 倒序（新的在前）。 */
export async function userWorks(userId: number): Promise<number[]> {
  const body = await ajax<{ illusts?: Record<string, unknown>; manga?: Record<string, unknown> }>(
    `/ajax/user/${userId}/profile/all`,
  )
  const ids = [...Object.keys(body.illusts ?? {}), ...Object.keys(body.manga ?? {})]
  return [...new Set(ids.map(Number).filter((n) => Number.isFinite(n)))].sort((a, b) => b - a)
}

export type RankMode = 'daily' | 'weekly' | 'monthly' | 'rookie' | 'original' | 'male' | 'female'

export async function ranking(mode: RankMode, pages = 1): Promise<number[]> {
  const out: number[] = []
  for (let p = 1; p <= pages; p += 1) {
    const url = `${BASE}/ranking.php?mode=${mode}&content=illust&format=json&p=${p}`
    const data = await httpJson<{ contents?: { illust_id?: number }[] }>(url, {
      headers: headers({ Accept: 'application/json' }),
      timeoutMs: 20_000,
    })
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
}

export async function searchHits(keyword: string, page = 1): Promise<SearchHit[]> {
  const q = new URLSearchParams({
    word: keyword,
    order: 'date_d',
    mode: 'all',
    p: String(page),
    s_mode: 's_tag_full',
    type: 'all',
    lang: 'zh',
  })
  const body = await ajax<{
    illustManga?: { data?: { id?: string; title?: string; userName?: string; userId?: string; pageCount?: number; xRestrict?: number }[] }
  }>(`/ajax/search/artworks/${encodeURIComponent(keyword)}?${q.toString()}`)
  return (body.illustManga?.data ?? [])
    .map((d) => ({
      id: Number(d.id),
      title: d.title ?? '',
      userName: d.userName ?? '',
      userId: Number(d.userId ?? 0),
      pageCount: d.pageCount ?? 1,
      xRestrict: d.xRestrict ?? 0,
    }))
    .filter((d) => Number.isFinite(d.id))
}

export async function searchWorks(keyword: string, page = 1): Promise<number[]> {
  const q = new URLSearchParams({
    word: keyword,
    order: 'date_d',
    mode: 'all',
    p: String(page),
    s_mode: 's_tag_full',
    type: 'all',
    lang: 'zh',
  })
  const body = await ajax<{ illustManga?: { data?: { id?: string }[] } }>(
    `/ajax/search/artworks/${encodeURIComponent(keyword)}?${q.toString()}`,
  )
  return (body.illustManga?.data ?? []).map((d) => Number(d.id)).filter((n) => Number.isFinite(n))
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

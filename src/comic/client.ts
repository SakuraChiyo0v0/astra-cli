/**
 * 漫画移动端 API 客户端（纯 TS）。
 *
 * 流程：刷新域名（可选）→ /setting 拿 cookies → 带 token 请求 → AES 解密 data。
 * 不经过任何本机其它容器。
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { progress } from '../core/output.ts'
import {
  API_DOMAIN_SERVER_SECRET,
  APP_TOKEN_SECRET_2,
  APP_UA,
  APP_VERSION,
  BUILTIN_API_DOMAINS,
  BUILTIN_IMAGE_DOMAINS,
  DOMAIN_SERVER_URLS,
  ORDER_BY_LATEST,
  SCRAMBLE_220980,
  TIME_ALL,
} from './constants.ts'
import { decodeRespData, tokenAndParam } from './crypto.ts'

export interface AlbumEpisode {
  id: string
  sort: number
  title: string
}

export interface AlbumDetail {
  id: string
  seriesId: string
  title: string
  authors: string[]
  tags: string[]
  description: string
  pageCount: number
  pubDate: string | null
  episodes: AlbumEpisode[]
}

export interface ChapterDetail {
  id: string
  albumId: string
  title: string
  sort: number
  images: string[]
  imageDomain: string
  scrambleId: string
}

export interface SearchHit {
  id: string
  title: string
  author: string
  tags: string[]
}

export interface SearchPage {
  query: string
  total: number
  page: number
  items: SearchHit[]
  /** 搜车号时接口会直接跳到该本。 */
  redirectId: string | null
}

function nowTs(): string {
  return String(Math.floor(Date.now() / 1000))
}

function pickImageDomain(): string {
  const list = BUILTIN_IMAGE_DOMAINS
  return list[Math.floor(Math.random() * list.length)]!
}

function joinCookie(setCookie: string[] | null, existing: string): string {
  const jar = new Map<string, string>()
  for (const part of existing.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k && rest.length) jar.set(k, rest.join('='))
  }
  for (const line of setCookie ?? []) {
    const first = line.split(';')[0] ?? ''
    const eq = first.indexOf('=')
    if (eq > 0) jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim())
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean)
  if (typeof value === 'string' && value.trim()) {
    return value.includes(',') ? value.split(',').map((s) => s.trim()) : value.split(/\s+/).filter(Boolean)
  }
  return []
}

export class JmClient {
  domains: string[]
  cookies = ''
  version = APP_VERSION
  private ready: Promise<void> | null = null

  constructor(domains: string[] = [...BUILTIN_API_DOMAINS]) {
    this.domains = domains.length > 0 ? domains : [...BUILTIN_API_DOMAINS]
  }

  /** 懒初始化：刷新域名 + 拿 cookies。 */
  ensure(): Promise<void> {
    if (!this.ready) this.ready = this.bootstrap().catch((err) => {
      this.ready = null
      throw err
    })
    return this.ready
  }

  private async bootstrap(): Promise<void> {
    const refreshed = await this.fetchLatestDomains().catch(() => null)
    if (refreshed && refreshed.length > 0) {
      progress('comic.domain', { domains: refreshed })
      this.domains = refreshed
    }
    await this.refreshCookies()
  }

  private async fetchLatestDomains(): Promise<string[] | null> {
    for (const url of DOMAIN_SERVER_URLS) {
      try {
        const resp = await httpRequest(url, { timeoutMs: 12_000, retries: 0 })
        if (!resp.ok) continue
        let text = await resp.text()
        while (text && text.charCodeAt(0) > 127) text = text.slice(1)
        const decoded = decodeRespData(text.trim(), '', API_DOMAIN_SERVER_SECRET)
        const parsed = JSON.parse(decoded) as { Server?: string[] }
        if (Array.isArray(parsed.Server) && parsed.Server.length > 0) return parsed.Server.map(String)
      } catch {
        // 换下一个域名服务器
      }
    }
    return null
  }

  private async refreshCookies(): Promise<void> {
    const { data, setCookie } = await this.rawApi('/setting')
    this.cookies = joinCookie(setCookie, this.cookies)
    const ver = data && typeof data === 'object' ? String((data as { jm3_version?: string }).jm3_version ?? '') : ''
    if (ver && ver !== this.version) {
      progress('comic.version', { from: this.version, to: ver })
      this.version = ver
    }
  }

  private async rawApi(pathAndQuery: string, options: { scrambleToken?: boolean; signal?: AbortSignal } = {}): Promise<{
    data: unknown
    setCookie: string[] | null
    rawText: string
    ts: string
  }> {
    const ts = nowTs()
    const secret = options.scrambleToken ? APP_TOKEN_SECRET_2 : undefined
    const { token, tokenparam } = tokenAndParam(ts, secret, this.version)
    const headers: Record<string, string> = {
      'Accept-Encoding': 'gzip, deflate',
      'user-agent': APP_UA,
      token,
      tokenparam,
    }
    if (this.cookies) headers.cookie = this.cookies

    let lastError: unknown = null
    for (const domain of this.domains) {
      const url = `https://${domain}${pathAndQuery}`
      try {
        const resp = await httpRequest(url, {
          headers,
          timeoutMs: 20_000,
          retries: 1,
          signal: options.signal,
        })
        const rawText = await resp.text()
        const setCookie = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : null
        if (!resp.ok) {
          lastError = new AstraError('COMIC_UPSTREAM', `漫画接口 HTTP ${resp.status}`, { exitCode: 5, retryable: resp.status >= 500 })
          continue
        }
        if (options.scrambleToken) {
          return { data: null, setCookie, rawText, ts }
        }
        let json: { code?: number; data?: string }
        try {
          json = JSON.parse(rawText) as { code?: number; data?: string }
        } catch {
          lastError = new AstraError('COMIC_UPSTREAM', '漫画接口返回的不是 JSON', { exitCode: 5, retryable: true })
          continue
        }
        if (json.code !== 200 || typeof json.data !== 'string') {
          lastError = new AstraError('COMIC_UPSTREAM', `漫画接口 code=${String(json.code)}`, { exitCode: 5, retryable: true })
          continue
        }
        const decoded = decodeRespData(json.data, ts)
        return { data: JSON.parse(decoded) as unknown, setCookie, rawText, ts }
      } catch (err) {
        lastError = err
      }
    }
    if (lastError instanceof AstraError) throw lastError
    throw new AstraError('NETWORK_ERROR', `漫画接口不可达：${lastError instanceof Error ? lastError.message : String(lastError)}`, {
      exitCode: 5,
      retryable: true,
      hint: '检查网络；若域名被墙可配 proxy（comic 域默认直连）',
    })
  }

  private async api(pathAndQuery: string, signal?: AbortSignal): Promise<unknown> {
    await this.ensure()
    const { data, setCookie } = await this.rawApi(pathAndQuery, { signal })
    this.cookies = joinCookie(setCookie, this.cookies)
    return data
  }

  async getAlbum(albumId: string, signal?: AbortSignal): Promise<AlbumDetail> {
    const data = (await this.api(`/album?id=${encodeURIComponent(albumId)}`, signal)) as Record<string, unknown>
    if (!data || data.name == null) {
      throw new AstraError('NOT_FOUND', `找不到漫画 ${albumId}`, { exitCode: 4, hint: '核对车号，或用 `astra comic search` 搜标题' })
    }
    const series = Array.isArray(data.series) ? data.series : []
    const episodes: AlbumEpisode[] = series.map((item) => {
      const row = item as { id?: string | number; sort?: string | number; name?: string }
      return { id: String(row.id), sort: Number(row.sort ?? 1), title: String(row.name ?? '').trim() || `第${row.sort ?? 1}话` }
    })
    episodes.sort((a, b) => a.sort - b.sort)
    // 无章节时整本即一章
    if (episodes.length === 0) {
      episodes.push({ id: String(data.id ?? albumId), sort: 1, title: String(data.name).trim() })
    }
    const seriesId = String(data.series_id ?? '0')
    // 传入的其实是章节 id 时，跟官方客户端一样跳回本子
    if (seriesId && seriesId !== '0' && seriesId !== String(data.id)) {
      progress('comic.redirect', { from: albumId, to: seriesId })
      return this.getAlbum(seriesId, signal)
    }
    const addtime = data.addtime != null ? Number(data.addtime) : NaN
    return {
      id: String(data.id ?? albumId),
      seriesId,
      title: String(data.name).trim(),
      authors: asStringList(data.author),
      tags: asStringList(data.tags),
      description: data.description == null ? '' : String(data.description).trim(),
      pageCount: Number(data.total_photos ?? 0) || episodes.length,
      pubDate: Number.isFinite(addtime) ? new Date(addtime * 1000).toISOString().slice(0, 10) : null,
      episodes,
    }
  }

  async getChapter(photoId: string, scrambleId?: string, signal?: AbortSignal): Promise<ChapterDetail> {
    const data = (await this.api(`/chapter?id=${encodeURIComponent(photoId)}`, signal)) as Record<string, unknown>
    if (!data || data.name == null) {
      throw new AstraError('NOT_FOUND', `找不到章节 ${photoId}`, { exitCode: 4 })
    }
    const imagesRaw = data.images
    const images = Array.isArray(imagesRaw)
      ? imagesRaw.map(String)
      : typeof imagesRaw === 'string'
        ? (JSON.parse(imagesRaw) as string[])
        : []
    if (images.length === 0) {
      throw new AstraError('COMIC_EMPTY', `章节 ${photoId} 没有图片`, { exitCode: 5 })
    }
    const seriesId = String(data.series_id ?? '0')
    const albumId = seriesId === '0' ? String(data.id ?? photoId) : seriesId
    let sort = 1
    if (Array.isArray(data.series)) {
      for (const item of data.series) {
        const row = item as { id?: string | number; sort?: string | number }
        if (String(row.id) === String(data.id)) {
          sort = Number(row.sort ?? 1)
          break
        }
      }
    }
    const resolvedScramble = scrambleId ?? (await this.getScrambleId(photoId, signal))
    return {
      id: String(data.id ?? photoId),
      albumId,
      title: String(data.name).trim(),
      sort,
      images,
      imageDomain: pickImageDomain(),
      scrambleId: resolvedScramble,
    }
  }

  async getScrambleId(photoId: string, signal?: AbortSignal): Promise<string> {
    await this.ensure()
    const qs = new URLSearchParams({
      id: photoId,
      mode: 'vertical',
      page: '0',
      app_img_shunt: '1',
      express: 'off',
      v: nowTs(),
    })
    try {
      const { rawText } = await this.rawApi(`/chapter_view_template?${qs}`, { scrambleToken: true, signal })
      const match = rawText.match(/var scramble_id = (\d+);/)
      if (match) return match[1]!
    } catch {
      // 回落默认阈值
    }
    return String(SCRAMBLE_220980)
  }

  async search(query: string, page = 1, signal?: AbortSignal): Promise<SearchPage> {
    const qs = new URLSearchParams({
      main_tag: '0',
      search_query: query,
      page: String(page),
      o: ORDER_BY_LATEST,
      t: TIME_ALL,
    })
    const data = (await this.api(`/search?${qs}`, signal)) as Record<string, unknown>
    const redirect = data.redirect_aid != null ? String(data.redirect_aid) : null
    if (redirect) {
      const album = await this.getAlbum(redirect, signal)
      return {
        query,
        total: 1,
        page,
        redirectId: redirect,
        items: [{ id: album.id, title: album.title, author: album.authors[0] ?? '', tags: album.tags }],
      }
    }
    const content = Array.isArray(data.content) ? data.content : []
    return {
      query,
      total: Number(data.total ?? 0) || content.length,
      page,
      redirectId: null,
      items: content.map((item) => {
        const row = item as { id?: string | number; name?: string; author?: string; tags?: unknown }
        return {
          id: String(row.id),
          title: String(row.name ?? '').trim(),
          author: String(row.author ?? '').trim(),
          tags: asStringList(row.tags),
        }
      }),
    }
  }

  imageUrl(chapter: ChapterDetail, imgName: string): string {
    return `https://${chapter.imageDomain}/media/photos/${chapter.id}/${imgName}`
  }

  async downloadImageBytes(chapter: ChapterDetail, imgName: string, signal?: AbortSignal): Promise<Buffer> {
    await this.ensure()
    const url = `${this.imageUrl(chapter, imgName)}?v=${nowTs()}`
    const headers: Record<string, string> = {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'X-Requested-With': 'com.JMComic3.app',
      Referer: `https://${this.domains[0]}/`,
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'user-agent': APP_UA,
    }
    if (this.cookies) headers.cookie = this.cookies
    const resp = await httpRequest(url, { headers, timeoutMs: 60_000, retries: 2, signal })
    if (!resp.ok) {
      throw new AstraError('COMIC_IMAGE', `图片下载失败 HTTP ${resp.status}：${imgName}`, { exitCode: 5, retryable: true })
    }
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length < 100) {
      throw new AstraError('COMIC_IMAGE', `图片内容异常（${buf.length} 字节）：${imgName}`, { exitCode: 5, retryable: true })
    }
    return buf
  }
}

let shared: JmClient | null = null

export function comicClient(): JmClient {
  if (!shared) shared = new JmClient()
  return shared
}

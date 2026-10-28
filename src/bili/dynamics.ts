/**
 * UP 主的「动态」与「相簿」（图文内容，不是视频）。
 *
 * ## 两个接口，可靠性完全不同
 *
 * **相簿** `/x/dynamic/feed/draw/doc_list`：免签名、免登录、稳定。返回的 `pictures[]`
 * 带 `img_width/img_height`，官方号发的高清图（实测 1920×1080、1080×2853）都在这里。
 * 官方账号的海报、立绘、表情包基本都发在相簿。
 *
 * **动态流**：要 `buvid3/buvid4` + wbi 签名，且有两个入口，行为差别很大：
 *   - `/x/polymer/web-dynamic/v1/feed/space`（网页版用的那个）在 Node 的 fetch 下
 *     **永远返回 `code:0` + 空 items**，同样的参数用 Python 请求却能拿到 12 条 ——
 *     这是按客户端指纹做的软拦截，改 header 没用（实测加 origin / accept-language 反而升级成 `-412`）。
 *   - `/x/polymer/web-dynamic/v1/opus/feed/space`（图文流）**在 Node 下正常**，一次 20 条。
 *     所以命令走 opus 入口，`feed/space` 只在 opus 拿不到时兜底。
 *
 * opus 条目只带**一张封面图**（`cover.url`，官方号通常是主视觉），
 * 要全部图片用 `bili album`（相簿接口给完整图集）。
 *
 * 风控的另一半是频率：取完 wbi key 立刻请求会被挡，隔 1.5 秒以上才稳；
 * 每次重试都换新的 buvid + wbi key。
 */
import { createHash } from 'node:crypto'

import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { mixinKey, type WbiKeys } from './sign.ts'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

// 只保留 UA / referer / accept：加 origin 与 accept-language 实测会把软拦截升级成 -412
const HEADERS = {
  'user-agent': UA,
  referer: 'https://space.bilibili.com/',
  accept: 'application/json, text/plain, */*',
}

export interface DynItem {
  /** 动态 id（可用于打开 https://t.bilibili.com/<id>）。 */
  dynId: string
  /** DRAW = 图文动态，FORWARD = 转发，AV = 视频投稿，ARTICLE = 专栏。 */
  kind: string
  /** 发布时间的 unix 秒。 */
  pubTs: number
  /** 正文（转发会带原动态的文案）。 */
  text: string
  /** 图片直链，已按原顺序去重。 */
  images: string[]
}

export interface AlbumItem {
  docId: string
  /** 相簿条目发布时间（unix 秒）。 */
  pubTs: number
  /** 说明文字（官方号通常带话题标签）。 */
  desc: string
  images: string[]
}

interface SpiBody {
  code?: number
  data?: { b_3?: string; b_4?: string }
}

async function buvidCookie(signal?: AbortSignal): Promise<string> {
  const response = await httpRequest('https://api.bilibili.com/x/frontend/finger/spi', {
    headers: HEADERS,
    ...(signal ? { signal } : {}),
  })
  const body = (await response.json()) as SpiBody
  const b3 = body.data?.b_3
  const b4 = body.data?.b_4
  if (!b3) throw new AstraError('BILI_NO_BUVID', '拿不到 buvid 设备指纹', { exitCode: 5, retryable: true })
  return `buvid3=${b3}; buvid4=${b4 ?? ''}`
}

async function wbiKeys(signal?: AbortSignal): Promise<WbiKeys> {
  const response = await httpRequest('https://api.bilibili.com/x/web-interface/nav', {
    headers: HEADERS,
    ...(signal ? { signal } : {}),
  })
  const body = (await response.json()) as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } }
  const img = body.data?.wbi_img?.img_url
  const sub = body.data?.wbi_img?.sub_url
  if (!img || !sub) throw new AstraError('BILI_NO_WBI', '拿不到 wbi 签名密钥', { exitCode: 5, retryable: true })
  return { imgUrl: img, subUrl: sub, fetchedAt: Date.now() }
}

function signDynamicQuery(params: Record<string, string | number>, keys: WbiKeys): string {
  const withWts: Record<string, string> = {
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    wts: String(Math.floor(Date.now() / 1000)),
  }
  const query = Object.keys(withWts)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(withWts[k]!)}`)
    .join('&')
  const wRid = createHash('md5').update(query + mixinKey(keys.imgUrl, keys.subUrl)).digest('hex')
  return `${query}&w_rid=${wRid}`
}

function uniq(urls: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of urls) {
    const url = raw.split('?')[0]
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url.replace(/^http:/, 'https:'))
  }
  return out
}

interface OpusFeedBody {
  code?: number
  message?: string
  data?: {
    items?: {
      opus_id?: string
      jump_url?: string
      content?: string
      pub_time?: string
      cover?: { url?: string; width?: number; height?: number } | null
    }[]
    offset?: string
    has_more?: boolean
  }
}

function parseOpusItem(raw: NonNullable<NonNullable<OpusFeedBody['data']>['items']>[number]): DynItem | null {
  const opusId = raw.opus_id ?? (raw.jump_url ?? '').split('/').pop()
  if (!opusId) return null
  const cover = raw.cover?.url ?? ''
  const parsedTs = raw.pub_time ? Math.floor(new Date(raw.pub_time).getTime() / 1000) : 0
  return {
    dynId: opusId,
    kind: 'OPUS',
    pubTs: Number.isFinite(parsedTs) ? parsedTs : 0,
    text: (raw.content ?? '').replace(/\s+/g, ' ').trim(),
    images: uniq([cover]),
  }
}

/**
 * 拉取 UP 的图文动态（新 → 旧）。
 *
 * 走 `opus/feed/space`（Node 下可用），按 offset 翻页。
 * 每条只带一张封面图；完整图集用 `fetchAlbum`。
 */
export async function fetchDynamics(
  mid: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ items: DynItem[]; pages: number; riskLimited: boolean }> {
  const items: DynItem[] = []
  let offset = ''
  let pages = 0
  let riskLimited = false

  while (items.length < limit && pages < 40) {
    let body: OpusFeedBody | null = null
    let cookie = await buvidCookie(signal)
    let keys = await wbiKeys(signal)

    for (let attempt = 0; attempt < 4; attempt += 1) {
      // 取完 key 立刻请求会被判风控，等一拍再发
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1500 : 4000 * attempt))
      const query = signDynamicQuery(
        {
          host_mid: mid,
          page: pages + 1,
          type: 'all',
          ...(offset ? { offset } : {}),
        },
        keys,
      )
      const response = await httpRequest(
        `https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/feed/space?${query}`,
        { headers: { ...HEADERS, cookie }, ...(signal ? { signal } : {}) },
      )
      body = (await response.json()) as OpusFeedBody
      const got = body.data?.items ?? []
      if (body.code === 0 && got.length > 0) break
      // 空列表（软拦截）和 -412（硬封）都算风控，换新 buvid + 拉长间隔再试
      cookie = await buvidCookie(signal)
      keys = await wbiKeys(signal)
      if (attempt === 3) riskLimited = true
    }

    if (!body || body.code !== 0) {
      throw new AstraError(
        'BILI_DYN_RISK',
        `动态接口被风控挡了（code=${body?.code ?? '?'}）`,
        { exitCode: 4, retryable: true, hint: '等几分钟再试；相簿接口（bili album）不受影响' },
      )
    }
    const raw = body.data?.items ?? []
    if (raw.length === 0) break
    pages += 1
    for (const one of raw) {
      const parsed = parseOpusItem(one)
      if (parsed) items.push(parsed)
    }
    if (!body.data?.has_more) break
    offset = body.data?.offset ?? ''
    if (!offset) break
  }

  return { items: items.slice(0, limit), pages, riskLimited }
}

interface DocListBody {
  code?: number
  message?: string
  data?: {
    items?: {
      doc_id?: number
      ctime?: number
      description?: string
      pictures?: { img_src?: string }[]
    }[]
  }
}

/** 拉取 UP 的相簿（新 → 旧）。免签名，稳定。 */
export async function fetchAlbum(
  mid: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ items: AlbumItem[]; pages: number }> {
  const items: AlbumItem[] = []
  let pages = 0

  while (items.length < limit && pages < 60) {
    const query = new URLSearchParams({
      uid: mid,
      page_num: String(pages),
      page_size: '20',
      biz: 'all',
    })
    const response = await httpRequest(
      `https://api.bilibili.com/x/dynamic/feed/draw/doc_list?${query.toString()}`,
      {
        headers: { ...HEADERS, referer: `https://space.bilibili.com/${mid}/album` },
        ...(signal ? { signal } : {}),
      },
    )
    const body = (await response.json()) as DocListBody
    if (body.code !== 0) {
      throw new AstraError('BILI_ALBUM_FAILED', `相簿接口返回 ${body.code}：${body.message ?? ''}`, {
        exitCode: 5,
        retryable: true,
      })
    }
    const raw = body.data?.items ?? []
    if (raw.length === 0) break
    pages += 1
    for (const one of raw) {
      items.push({
        docId: String(one.doc_id ?? ''),
        pubTs: one.ctime ?? 0,
        desc: (one.description ?? '').replace(/\s+/g, ' ').trim(),
        images: uniq((one.pictures ?? []).map((p) => p.img_src ?? '')),
      })
    }
  }

  return { items: items.slice(0, limit), pages }
}

export interface SavedImage {
  url: string
  file: string
  bytes: number
}

/** 把图片下载到目录；文件名 = <前缀><日期>_<id>_<序号>.<ext>。 */
export async function saveImages(
  entries: { id: string; pubTs: number; images: string[] }[],
  dir: string,
  prefix: string,
  signal?: AbortSignal,
): Promise<SavedImage[]> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { join, extname } = await import('node:path')
  await mkdir(dir, { recursive: true })
  const saved: SavedImage[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    const date = new Date(entry.pubTs * 1000)
    // opus 接口不返回发布时间（pub_time 恒为空），拿不到就写 undated，别留 1970
    const day = !entry.pubTs || Number.isNaN(date.getTime())
      ? 'undated'
      : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    let index = 0
    for (const url of entry.images) {
      index += 1
      if (seen.has(url)) continue
      seen.add(url)
      let response: Response
      try {
        response = await httpRequest(url, {
          headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
          ...(signal ? { signal } : {}),
        })
      } catch {
        continue
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.byteLength < 20 * 1024) continue // 图标/占位图不要
      const ext = extname(new URL(url).pathname) || '.jpg'
      const file = join(dir, `${prefix}${day}_${entry.id}_${index}${ext}`)
      await writeFile(file, buffer)
      saved.push({ url, file, bytes: buffer.byteLength })
    }
  }
  return saved
}

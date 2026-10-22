/**
 * B 站接口：视频详情、播放地址（DASH）、字幕。
 *
 * 实测（2026-10-21）：
 * - 详情 `/x/web-interface/view?bvid=` 免登录；`pages[]` 是分 P 列表，每项有 cid / part / duration
 * - 播放 `/x/player/wbi/playurl` 要 wbi 签名；`fnval=4048` 开 DASH（同时给视频流和音频流）
 * - **未登录画质封顶 360P**：qn 填 80/116 都只返回 16。登录后才有 1080P+ 的可能性
 * - DASH 里同一画质有多种编码（avc1 / hev1 / av01），按需挑，默认 avc1 兼容性最好
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { loadBiliSession, cookieHeader } from './auth.ts'
import { signParams, qualityName, type WbiKeys } from './sign.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { 'user-agent': UA, referer: REFERER, ...extra }
}

interface ApiBody<T> {
  code: number
  message?: string
  data?: T
}

async function get<T>(url: string, what: string, signal?: AbortSignal): Promise<T> {
  const session = loadBiliSession()
  const options: Parameters<typeof httpRequest>[1] = {
    headers: headers(session ? { cookie: cookieHeader(session) } : {}),
    timeoutMs: 15_000,
    retries: 1,
  }
  if (signal) options.signal = signal
  const response = await httpRequest(url, options)
  if (!response.ok) throw new AstraError('BILI_HTTP', `B 站${what}返回 HTTP ${response.status}`, { exitCode: 5, retryable: response.status >= 500 })
  let body: ApiBody<T>
  try {
    body = (await response.json()) as ApiBody<T>
  } catch {
    throw new AstraError('BILI_BAD_RESPONSE', `B 站${what}返回的不是 JSON`, { exitCode: 5 })
  }
  if (body.code !== 0) {
    // -101 = 未登录；-404 = 视频不存在；-403 = 权限（私密 / 地区限制）
    const hint = body.code === -101 ? '需要登录：先 `astra bili login start`' : body.code === -403 ? '私密或地区限制' : null
    throw new AstraError('BILI_API_ERROR', `B 站${what}失败（code=${body.code}${body.message ? `：${body.message}` : ''}）`, {
      exitCode: body.code === -404 ? 4 : 5,
      ...(hint ? { hint } : {}),
      details: { code: body.code },
    })
  }
  if (body.data === undefined) throw new AstraError('BILI_BAD_RESPONSE', `B 站${what}没有 data`, { exitCode: 5 })
  return body.data
}

export interface VideoPage {
  cid: number
  page: number
  part: string
  duration: number
}

export interface VideoInfo {
  bvid: string
  aid: number
  title: string
  desc: string
  owner: { mid: number; name: string }
  duration: number
  pic: string | null
  pubdate: number
  pages: VideoPage[]
}

export async function videoInfo(bvid: string, signal?: AbortSignal): Promise<VideoInfo> {
  const data = await get<{
    bvid: string; aid: number; title: string; desc?: string
    owner?: { mid?: number; name?: string }
    duration?: number; pic?: string; pubdate?: number
    pages?: { cid: number; page: number; part: string; duration: number }[]
  }>(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, '视频详情', signal)
  return {
    bvid: data.bvid,
    aid: data.aid,
    title: data.title,
    desc: data.desc ?? '',
    owner: { mid: data.owner?.mid ?? 0, name: data.owner?.name ?? '' },
    duration: data.duration ?? 0,
    pic: data.pic ? data.pic.replace(/^http:/, 'https:') : null,
    pubdate: data.pubdate ?? 0,
    pages: (data.pages ?? []).map((p) => ({ cid: p.cid, page: p.page, part: p.part, duration: p.duration })),
  }
}

export interface DashStream {
  id: number
  baseUrl: string
  backupUrls: string[]
  codecs: string
  width: number
  height: number
  frameRate: string
  bandwidth: number
  mimeType: string
}

export interface PlayInfo {
  /** 服务端实际给的最高画质（不是请求的）。 */
  quality: number
  qualityLabel: string
  /** 登录后才能看到的完整可选项。 */
  acceptQuality: number[]
  videos: DashStream[]
  audios: DashStream[]
  /** 番剧 / 部分老视频走 durl（整段 flv/mp4），没有 DASH。 */
  durl: { url: string; backupUrls: string[]; size: number; length: number }[]
}

let cachedKeys: WbiKeys | null = null

async function wbiKeys(signal?: AbortSignal): Promise<WbiKeys> {
  // 官方每天轮换，缓存 5 分钟足够
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < 5 * 60 * 1000) return cachedKeys
  const options: Parameters<typeof httpRequest>[1] = { headers: headers(), timeoutMs: 12_000, retries: 1 }
  if (signal) options.signal = signal
  const response = await httpRequest('https://api.bilibili.com/x/web-interface/nav', options)
  const body = (await response.json()) as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } }
  const img = body.data?.wbi_img?.img_url
  const sub = body.data?.wbi_img?.sub_url
  if (!img || !sub) throw new AstraError('BILI_NO_WBI', '拿不到 wbi 签名密钥', { exitCode: 5, retryable: true })
  cachedKeys = { imgUrl: img, subUrl: sub, fetchedAt: Date.now() }
  return cachedKeys
}

interface RawDash {
  video?: { id: number; baseUrl?: string; base_url?: string; backupUrl?: string[]; backup_url?: string[]; codecs?: string; width?: number; height?: number; frameRate?: string; frame_rate?: string; bandwidth?: number; mimeType?: string; mime_type?: string }[]
  audio?: { id: number; baseUrl?: string; base_url?: string; backupUrl?: string[]; backup_url?: string[]; codecs?: string; bandwidth?: number; mimeType?: string; mime_type?: string }[]
}

export async function playInfo(bvid: string, cid: number, qn: number, signal?: AbortSignal): Promise<PlayInfo> {
  const keys = await wbiKeys(signal)
  const query = signParams({ bvid, cid, qn, fnval: 4048, fourk: 1, fnver: 0 }, keys)
  const data = await get<{
    quality?: number; accept_quality?: number[]
    dash?: RawDash
    durl?: { url: string; backup_url?: string[]; size?: number; length?: number }[]
  }>(`https://api.bilibili.com/x/player/wbi/playurl?${query}`, '播放地址', signal)

  const toStream = (s: NonNullable<RawDash['video']>[number]): DashStream => ({
    id: s.id,
    baseUrl: s.baseUrl ?? s.base_url ?? '',
    backupUrls: s.backupUrl ?? s.backup_url ?? [],
    codecs: s.codecs ?? '',
    width: s.width ?? 0,
    height: s.height ?? 0,
    frameRate: s.frameRate ?? s.frame_rate ?? '',
    bandwidth: s.bandwidth ?? 0,
    mimeType: s.mimeType ?? s.mime_type ?? '',
  })

  return {
    quality: data.quality ?? 0,
    qualityLabel: qualityName(data.quality ?? 0),
    acceptQuality: data.accept_quality ?? [],
    videos: (data.dash?.video ?? []).map(toStream),
    audios: (data.dash?.audio ?? []).map((a) => ({
      id: a.id, baseUrl: a.baseUrl ?? a.base_url ?? '', backupUrls: a.backupUrl ?? a.backup_url ?? [],
      codecs: a.codecs ?? '', width: 0, height: 0, frameRate: '', bandwidth: a.bandwidth ?? 0, mimeType: a.mimeType ?? a.mime_type ?? '',
    })),
    durl: (data.durl ?? []).map((d) => ({ url: d.url, backupUrls: d.backup_url ?? [], size: d.size ?? 0, length: d.length ?? 0 })),
  }
}

/**
 * 字幕列表（需要登录；UP 主没传字幕就是空）。
 *
 * **必须走 `/x/player/wbi/v2`，不能用 `/x/player/v2`。** 实测（2026-10-22）：
 * 同一个 bvid+cid，不带 wbi 签名的那条会时好时坏 —— 6 次里 1 次返回**空 subtitle_url**、
 * 1 次丢掉 zh-CN，URL 也停在过期值上不刷新（wbi 版每次给的是新签名的 CDN 链接）。
 * 调用方拿到空 URL 后 `fetch('')` 抛错被跳过，于是"有时有字幕、有时没有"，
 * 甚至读到 CDN 上已经换给别人内容的旧路径 —— 表现就是"返回别的视频的字幕"。
 */
export async function subtitleList(bvid: string, cid: number, signal?: AbortSignal): Promise<{ lan: string; lanDoc: string; url: string }[]> {
  const keys = await wbiKeys(signal)
  // wbi 签名只需要 bvid/cid 参与；与播放地址是同一套密钥
  const query = signParams({ bvid, cid }, keys)
  const data = await get<{ subtitle?: { subtitles?: { lan: string; lan_doc: string; subtitle_url: string }[] } }>(
    `https://api.bilibili.com/x/player/wbi/v2?${query}`,
    '字幕列表',
    signal,
  )
  return (data.subtitle?.subtitles ?? [])
    .map((s) => ({ lan: s.lan, lanDoc: s.lan_doc, url: s.subtitle_url.startsWith('//') ? `https:${s.subtitle_url}` : s.subtitle_url }))
    // 空 URL 的条目没有任何用处，留着只会让调用方 fetch('') 抛错
    .filter((s) => s.url.length > 0)
}

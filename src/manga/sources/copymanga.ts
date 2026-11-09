/**
 * 拷贝漫画：作品最全，繁体为主，没有看图额度。协议参考 venera-configs/copy_manga.js（v1.4.3）。
 *
 * - **只能直连**：经 mihomo 时接口只回 `error`（代理出口 IP 被拒）。别把它的域名加进 `proxy.include`
 * - 请求头要带 HMAC 签名（`x-auth-signature = HMAC-SHA256(secret, 秒级时间戳)`）
 * - 设备标识固定存在 `<ASTRA_HOME>/manga/copymanga-device.json`：每次随机更像破解版
 * - 被判成破解版时回 `code 210`「請到官網更新最新APP」，约 1 小时自动解除。
 *   实测连下一卷 170 张图后紧接着调接口就会触发，所以接口请求之间、图与图之间都留间隔
 * - 一部作品分多个分组（default 连载 / tankobon 单行本 / 翻译组…），默认组可能是空的
 * - 一话的 `contents` 是乱序的，`words` 给出每张的真实页序
 */
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AstraError } from '../../core/errors.ts'
import { homePath } from '../../core/paths.ts'
import { fetchBytes, fetchJson, sleep } from '../fetch.ts'
import { QuotaError, type ChapterRef, type ComicInfo, type Group, type MangaSource, type PageRef, type SearchHit } from './types.ts'

const APIS = ['https://api.copy2000.online', 'https://api.copy-manga.com']
const SECRET = Buffer.from('M2FmMDg1OTAzMTEwMzJlZmUwNjYwNTUwYTA1NjNhNTM=', 'base64')
const APP_VER = '3.0.6'
const URL_RE = /(?:copymanga|mangacopy|copy-?manga|copy\d+|\d+copy)\.\w+\/comic\/([\w-]+)/
/** 接口请求的最小间隔。 */
const API_GAP_MS = 1_200
/** 图片之间的最小间隔：连发 170 张后就被 210 了。 */
const IMAGE_GAP_MS = 800
/** 210 之后约多久恢复。 */
const BLOCK_SECONDS = 3_600

let lastApi = 0
let lastImage = 0

interface Device { deviceinfo: string; device: string; pseudoid: string }

function deviceFile(): string {
  return homePath('manga', 'copymanga-device.json')
}

function device(): Device {
  const file = deviceFile()
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Device
    } catch {
      // 坏了就重建
    }
  }
  const rnd = (n: number): string => randomBytes(n).toString('hex').slice(0, n)
  const d: Device = { deviceinfo: `V1938CT-${rnd(6)}`, device: rnd(10).toUpperCase(), pseudoid: rnd(16) }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(d), { mode: 0o600 })
  return d
}

export function signature(ts: string): string {
  return createHmac('sha256', SECRET).update(ts).digest('hex')
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

function headers(): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000))
  const d = device()
  return {
    'user-agent': `COPY/${APP_VER}`, source: 'copyApp', deviceinfo: d.deviceinfo, dt: today(), platform: '3',
    referer: `com.copymanga.app-${APP_VER}`, version: APP_VER, device: d.device, pseudoid: d.pseudoid,
    accept: 'application/json', region: '0', authorization: 'Token', umstring: 'b4c89ca4104ea9a97750314d791520ac',
    'x-auth-timestamp': ts, 'x-auth-signature': signature(ts),
  }
}

async function gap(last: number, ms: number, signal?: AbortSignal): Promise<void> {
  const wait = ms - (Date.now() - last)
  if (wait > 0) await sleep(wait, signal)
}

interface ApiEnvelope<T> { code: number; message?: string; results: T }

async function api<T>(pathname: string, signal?: AbortSignal): Promise<T> {
  let last: unknown = null
  for (const base of APIS) {
    await gap(lastApi, API_GAP_MS, signal)
    let r: ApiEnvelope<T>
    try {
      r = await fetchJson<ApiEnvelope<T>>(base + pathname, { headers: headers(), ...(signal ? { signal } : {}) })
    } catch (err) {
      last = err
      continue
    } finally {
      lastApi = Date.now()
    }
    if (r.code === 210) throw new QuotaError('copymanga', BLOCK_SECONDS, '拷贝漫画暂时拒绝（code 210，约 1 小时自动解除）')
    if (r.code === 200) return r.results
    last = new Error(`code ${r.code} ${r.message ?? ''}`)
  }
  throw new AstraError('NETWORK_ERROR', `拷贝漫画接口都不可用：${(last as Error)?.message ?? '未知'}`, { exitCode: 5, retryable: true })
}

interface RawAuthor { name: string }
interface RawListItem { name: string; path_word: string; author?: RawAuthor[] }
interface RawChapter { uuid: string; name: string; size?: number }
interface RawGroup { name?: string; count?: number }

const authorText = (a?: RawAuthor[]): string | null => (a?.length ? a.map((x) => x.name).join('、') : null)

/** 分组 key → 展示名与是否按卷。 */
export function groupLabel(key: string, raw: RawGroup): { name: string; volumes: boolean } {
  if (key === 'default') return { name: '连载', volumes: false }
  if (key === 'tankobon') return { name: '单行本', volumes: true }
  return { name: raw.name || key, volumes: false }
}

/** `contents` 按 `words` 重排成真实页序；`words` 缺失时保持原序。 */
export function orderPages<T>(contents: T[], words: number[] | undefined): T[] {
  if (!words || words.length !== contents.length) return contents
  return contents.map((c, i) => [words[i]!, c] as const).sort((a, b) => a[0] - b[0]).map(([, c]) => c)
}

/** 图片地址里的尺寸后缀换成 1500 宽（站上默认给 800）。 */
export function hiRes(url: string): string {
  return url.replace(/\.c\d+x\./, '.c1500x.')
}

async function chapters(pw: string, key: string, signal?: AbortSignal): Promise<ChapterRef[]> {
  const out: ChapterRef[] = []
  for (let offset = 0; ; offset += 100) {
    const r = await api<{ total: number; list: RawChapter[] }>(`/api/v3/comic/${pw}/group/${key}/chapters?limit=100&offset=${offset}&platform=3`, signal)
    out.push(...r.list.map((c) => ({ id: `${key}:${c.uuid}`, name: c.name, pages: c.size ?? null })))
    if (offset + 100 >= r.total) return out
  }
}

export const copymanga: MangaSource = {
  name: 'copymanga',
  description: '拷贝漫画：作品最全（连载 / 单行本 / 翻译组），没有额度；只能直连，请求太密会被限流 1 小时',

  match(input) {
    const m = URL_RE.exec(input)
    return m ? m[1]! : null
  },

  async search(keyword, signal) {
    const r = await api<{ list: RawListItem[] }>(`/api/v3/search/comic?platform=3&q=${encodeURIComponent(keyword)}&limit=20&offset=0`, signal)
    return r.list.map((x): SearchHit => ({ source: 'copymanga', id: x.path_word, title: x.name, author: authorText(x.author) }))
  },

  async comic(pw, signal) {
    const r = await api<{ comic: { name: string; path_word: string; cover?: string; author?: RawAuthor[]; theme?: { name: string }[]; status?: { display?: string } }; groups: Record<string, RawGroup> }>(
      `/api/v3/comic2/${pw}?platform=3`, signal)
    const groups: Group[] = []
    for (const [key, raw] of Object.entries(r.groups)) {
      if (!Number(raw.count)) continue
      const label = groupLabel(key, raw)
      groups.push({ ...label, chapters: await chapters(pw, key, signal) })
    }
    // 单行本排最前：「下一整部」时它最省事
    groups.sort((a, b) => Number(b.volumes) - Number(a.volumes))
    return {
      source: 'copymanga', id: r.comic.path_word, title: r.comic.name, author: authorText(r.comic.author),
      status: r.comic.status?.display ?? null, tags: (r.comic.theme ?? []).map((t) => t.name), cover: r.comic.cover ?? null,
      url: `https://www.mangacopy.com/comic/${r.comic.path_word}`, groups,
    } satisfies ComicInfo
  },

  async pages(comic, chapter, signal) {
    const uuid = chapter.id.includes(':') ? chapter.id.slice(chapter.id.indexOf(':') + 1) : chapter.id
    const r = await api<{ chapter: { contents: { url: string }[]; words?: number[] } }>(`/api/v3/comic/${comic.id}/chapter2/${uuid}?platform=3`, signal)
    return orderPages(r.chapter.contents, r.chapter.words).map((c): PageRef => ({ url: hiRes(c.url), headers: { 'user-agent': `COPY/${APP_VER}` } }))
  },

  async image(page, signal) {
    await gap(lastImage, IMAGE_GAP_MS, signal)
    try {
      const r = await fetchBytes(page.url, { headers: page.headers, timeoutMs: 60_000, ...(signal ? { signal } : {}) })
      if (r.status >= 400) throw new AstraError('HTTP_ERROR', `拷贝漫画图片返回 HTTP ${r.status}`, { exitCode: 5, retryable: r.status >= 500 || r.status === 429 })
      return r.body
    } finally {
      lastImage = Date.now()
    }
  },

  async probe(signal) {
    await api<{ list: unknown[] }>('/api/v3/search/comic?platform=3&q=a&limit=1&offset=0', signal)
    return '接口正常'
  },
}

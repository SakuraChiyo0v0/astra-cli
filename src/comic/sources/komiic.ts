/**
 * Komiic（komiic.com）：繁体，GraphQL 接口。协议参考 venera-configs/komiic.js。
 *
 * - NAS 上直连不通，要把 `komiic.com` 加进 `proxy.include`
 * - 匿名看图额度：每 IP 约 300 张 / 天（`getImageLimit` 可查，实测重置周期约 24 小时）。
 *   代理出口只有一个 IP，换节点绕不开
 * - 一部作品的「章节」分两种 type：book（单行本）/ chapter（单话）
 */
import { AstraError } from '../../core/errors.ts'
import { fetchBytes, fetchJson } from '../fetch.ts'
import { QuotaError, type ChapterRef, type ComicInfo, type Group, type ComicSource, type PageRef, type SearchHit } from './types.ts'

const BASE = 'https://komiic.com'
const API = `${BASE}/api/query`
const URL_RE = /komiic\.com\/comic\/(\d+)/

interface GqlResponse<T> {
  data?: T
  errors?: { message?: string }[]
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const r = await fetchJson<GqlResponse<T>>(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', referer: `${BASE}/` },
    body: JSON.stringify({ query, variables }),
    ...(signal ? { signal } : {}),
  })
  if (r.errors?.length || !r.data) {
    throw new AstraError('BAD_RESPONSE', `Komiic：${r.errors?.[0]?.message ?? '没有数据'}`, { exitCode: 5, retryable: true })
  }
  return r.data
}

interface RawComic {
  id: string
  title: string
  status?: string
  imageUrl?: string
  authors?: { name: string }[]
  categories?: { name: string }[]
}

interface RawChapter {
  id: string
  serial: string
  type: string
  size?: number | string | null
}

/** 章节按 type 分组；Komiic 两种 type 的 serial 都是 `01` 这样的编号。 */
export function groupChapters(chs: RawChapter[]): Group[] {
  const toRef = (c: RawChapter): ChapterRef => ({ id: c.id, name: c.serial, pages: c.size == null ? null : Number(c.size) })
  const groups: Group[] = [
    { name: '单行本', volumes: true, chapters: chs.filter((c) => c.type === 'book').map(toRef) },
    { name: '单话', volumes: false, chapters: chs.filter((c) => c.type === 'chapter').map(toRef) },
  ]
  return groups.filter((g) => g.chapters.length > 0)
}

const authors = (c: RawComic): string | null => (c.authors?.length ? c.authors.map((a) => a.name).join('、') : null)

export async function quota(signal?: AbortSignal): Promise<{ limit: number; usage: number; resetInSeconds: number }> {
  const d = await gql<{ getImageLimit: { limit: number; usage: number; resetInSeconds: string | number } }>(
    'query { getImageLimit { limit usage resetInSeconds } }', {}, signal)
  return { limit: Number(d.getImageLimit.limit), usage: Number(d.getImageLimit.usage), resetInSeconds: Number(d.getImageLimit.resetInSeconds) }
}

export const komiic: ComicSource = {
  name: 'komiic',
  description: 'Komiic：繁体，单行本 + 单话；匿名每天约 300 张',

  match(input) {
    const m = URL_RE.exec(input)
    return m ? m[1]! : null
  },

  async search(keyword, signal) {
    const d = await gql<{ searchComicsAndAuthors: { comics: RawComic[] } }>(
      'query($k:String!){ searchComicsAndAuthors(keyword:$k){ comics { id title authors { name } } } }', { k: keyword }, signal)
    return d.searchComicsAndAuthors.comics.map((c): SearchHit => ({ source: 'komiic', id: c.id, title: c.title, author: authors(c) }))
  },

  async comic(id, signal) {
    const d = await gql<{ comicById: RawComic | null; chaptersByComicId: RawChapter[] }>(
      'query($id:ID!){ comicById(comicId:$id){ id title status imageUrl authors { name } categories { name } } chaptersByComicId(comicId:$id){ id serial type size } }',
      { id }, signal)
    const c = d.comicById
    if (!c) throw new AstraError('NOT_FOUND', `Komiic 上没有这部作品：${id}`, { exitCode: 4 })
    return {
      source: 'komiic', id: c.id, title: c.title, author: authors(c),
      status: c.status ?? null, tags: (c.categories ?? []).map((x) => x.name), cover: c.imageUrl ?? null,
      url: `${BASE}/comic/${c.id}`, groups: groupChapters(d.chaptersByComicId),
    } satisfies ComicInfo
  },

  async pages(comic, chapter, signal) {
    const d = await gql<{ imagesByChapterId: { kid: string }[] }>(
      'query($id:ID!){ imagesByChapterId(chapterId:$id){ kid } }', { id: chapter.id }, signal)
    const referer = `${BASE}/comic/${comic.id}/chapter/${chapter.id}/images/all`
    return d.imagesByChapterId.map((im): PageRef => ({ url: `${BASE}/api/image/${im.kid}`, headers: { referer } }))
  },

  async image(page, signal) {
    const r = await fetchBytes(page.url, { headers: page.headers, timeoutMs: 60_000, ...(signal ? { signal } : {}) })
    if (r.status < 400) return r.body
    // 额度用完时不一定给明确的错误码：每次失败都回查一次
    const q = await quota(signal).catch(() => null)
    if (q && q.usage >= q.limit) throw new QuotaError('komiic', q.resetInSeconds, `Komiic 今天的看图额度用完（${q.usage}/${q.limit}）`)
    throw new AstraError('HTTP_ERROR', `Komiic 图片返回 HTTP ${r.status}`, { exitCode: 5, retryable: r.status >= 500 || r.status === 429 })
  },

  async probe(signal) {
    const q = await quota(signal)
    const left = Math.max(0, q.limit - q.usage)
    return `额度 ${left}/${q.limit}${left === 0 ? `，${Math.ceil(q.resetInSeconds / 3600)} 小时后重置` : ''}`
  },
}

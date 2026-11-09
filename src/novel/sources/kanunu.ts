/**
 * 努努书坊（kanunu8）：简体出版读物（国内外文学、推理、科幻、武侠……）。页面是 GBK。
 *
 * ## 找书靠本地索引
 *
 * 站内没有搜索。索引 = 分类页（从 /genres.html 发现）+ 专题页 + 每个作家页上列出的书。
 * 只扫分类页不够：有的书只挂在作家页上（《活着》就是）。作家总目分 10 页、约 1,800 个作家，
 * 建一次要十来分钟，所以走后台任务（`novel index --rebuild`），结果存 `<ASTRA_HOME>/novel/kanunu-index.json`。
 * 索引里没有的书，直接给书页链接照样能抓。
 *
 * ## 书页两种排版
 *
 * - 新版：`<div class="mulu-title"><h2>卷名</h2></div><div class="mulu-list">章节</div>`
 * - 老版：`<table>` 里卷名行（`<td colspan><strong>卷名</strong>`）和章节行交替
 *
 * 同一本书 `/x/` 和 `/x/index.html` 两种写法都有人链，统一去掉 `index.html`。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import path from 'node:path'
import { AstraError } from '../../core/errors.ts'
import { homePath } from '../../core/paths.ts'
import { fetchText } from '../fetch.ts'
import { htmlParagraphs, normalizeTitle, stripTags } from '../text.ts'
import type { ChapterRef, NovelSource, SearchHit, Volume } from './types.ts'

const BASE = 'https://www.kanunu8.com'
const ENC = 'gb18030'
const URL_RE = /kanunu8\.com(\/(?:book\d*|wuxia|tuili)\/\w+\/?(?:index\.html)?)/
const BOOK_LINK_RE = /href=["'](?:https?:\/\/www\.kanunu8\.com)?(\/book\d*\/\w+\/(?:index\.html)?)["'][^>]*>([\s\S]*?)<\/a>/g
export const INDEX_TTL_MS = 7 * 86_400_000

export function normalizeBookPath(p: string): string {
  const cleaned = p.replace(/index\.html$/, '')
  return cleaned.endsWith('/') ? cleaned : `${cleaned}/`
}

const get = (p: string, signal?: AbortSignal): Promise<string> =>
  fetchText(p.startsWith('http') ? p : BASE + p, { referer: `${BASE}/`, encoding: ENC, ...(signal ? { signal } : {}) })

// ---------- 索引 ----------

export interface IndexEntry {
  path: string
  title: string
  author: string | null
}

export interface KanunuIndex {
  builtAt: string
  pages: number
  books: IndexEntry[]
}

/** 作家页 / 分类页上的书链接。分类页的链接文字常是「作者:书名」。 */
export function parseBookLinks(html: string, author: string | null = null): IndexEntry[] {
  const out: IndexEntry[] = []
  for (const m of html.matchAll(BOOK_LINK_RE)) {
    let label = stripTags(m[2]!).replace(/^《|》$/g, '').trim()
    let who = author
    const colon = /^([^:：]{1,12})[:：](.+)$/.exec(label)
    if (colon && !who) {
      who = colon[1]!.trim()
      label = colon[2]!.trim()
    }
    label = label.replace(/^《|》$/g, '').trim()
    if (label) out.push({ path: normalizeBookPath(m[1]!), title: label, author: who })
  }
  return out
}

/** 分类入口：/genres.html 上的 /files/… /wuxia/ /tuili/，外加专题页。 */
export function parseCategoryPaths(genresHtml: string): string[] {
  const set = new Set<string>()
  for (const m of genresHtml.matchAll(/href="(?:https:\/\/www\.kanunu8\.com)?(\/(?:files\/[\w./]+|wuxia\/|tuili\/))"/g)) {
    if (!m[1]!.includes('writer')) set.add(m[1]!)
  }
  set.add('/zt/')
  return [...set].sort()
}

/** 作家总目一页：作家页链接 + 作者名（「余华: 余华作品集」→ 余华）。 */
export function parseWriterLinks(html: string): { path: string; author: string }[] {
  const out: { path: string; author: string }[] = []
  for (const m of html.matchAll(/href=['"]((?:\/zj\/\d+|\/files\/writer\/\d+)\.html)['"][^>]*>([^<]+)<\/a>/g)) {
    const label = m[2]!.split(/[:：]/).pop()!.replace(/作品全?集.*$/, '').trim()
    out.push({ path: m[1]!, author: label })
  }
  return out
}

/** 作家总目共几页（「末页」链接 `18-10.html`）。 */
export function writerPageCount(html: string): number {
  const last = /href='18-(\d+)\.html'>末页/.exec(html)
  return last ? Number(last[1]) : 1
}

/** 建索引要扫的全部页面。只跑十来个请求，所以同步做；真正慢的逐页扫描交给后台任务。 */
export async function indexPages(signal?: AbortSignal): Promise<{ path: string; author: string | null }[]> {
  const categories = parseCategoryPaths(await get('/genres.html', signal))
  const first = await get('/files/writer/', signal)
  const writers = parseWriterLinks(first)
  for (let p = 2; p <= writerPageCount(first); p += 1) writers.push(...parseWriterLinks(await get(`/files/writer/18-${p}.html`, signal)))
  const seen = new Set<string>()
  const pages: { path: string; author: string | null }[] = []
  for (const c of categories) if (!seen.has(c)) { seen.add(c); pages.push({ path: c, author: null }) }
  for (const w of writers) if (!seen.has(w.path)) { seen.add(w.path); pages.push({ path: w.path, author: w.author || null }) }
  return pages
}

export async function scanIndexPage(page: { path: string; author: string | null }, signal?: AbortSignal): Promise<IndexEntry[]> {
  return parseBookLinks(await get(page.path, signal), page.author)
}

/** 合并各页结果：同一路径保留第一个带作者的条目。 */
export function mergeIndex(lists: IndexEntry[][]): IndexEntry[] {
  const byPath = new Map<string, IndexEntry>()
  for (const list of lists) {
    for (const e of list) {
      const prev = byPath.get(e.path)
      if (!prev || (!prev.author && e.author)) byPath.set(e.path, e)
    }
  }
  return [...byPath.values()]
}

export function indexFile(): string {
  return homePath('novel', 'kanunu-index.json')
}

export function loadIndex(): KanunuIndex | null {
  const file = indexFile()
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as KanunuIndex
  } catch {
    return null
  }
}

export function saveIndex(index: KanunuIndex): void {
  const file = indexFile()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(index))
  renameSync(`${file}.tmp`, file)
}

export function searchIndex(index: KanunuIndex, keyword: string): SearchHit[] {
  const kw = normalizeTitle(keyword)
  if (!kw) return []
  return index.books
    .filter((b) => normalizeTitle(b.title).includes(kw))
    .map((b) => ({ source: 'kanunu', id: b.path, title: b.title, author: b.author }))
}

// ---------- 书页 / 正文 ----------

export function parseKanunuToc(html: string): Volume[] {
  const volumes: Volume[] = []
  const toRef = (href: string, title: string): ChapterRef => ({ id: href.replace(/\.html$/, ''), title: stripTags(title) })
  if (html.includes('mulu-list')) {
    for (const m of html.matchAll(/<div class="mulu-title">\s*<h2[^>]*>([\s\S]*?)<\/h\d>\s*<\/div>\s*<div class="mulu-list">([\s\S]*?)<\/div>/g)) {
      const chapters = [...m[2]!.matchAll(/<a href=["'](\d+\.html)["']>([\s\S]*?)<\/a>/g)].map((c) => toRef(c[1]!, c[2]!))
      if (chapters.length > 0) volumes.push({ title: stripTags(m[1]!), chapters })
    }
    return volumes
  }
  let current: Volume = { title: '正文', chapters: [] }
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1]!.matchAll(/<a href=["'](\d+\.html)["'][^>]*>([\s\S]*?)<\/a>/g)]
    if (cells.length > 0) {
      current.chapters.push(...cells.map((c) => toRef(c[1]!, c[2]!)))
      continue
    }
    const head = /<strong>([\s\S]*?)<\/strong>/.exec(row[1]!)
    if (head && row[1]!.includes('colspan') && !/作品集|内容简介/.test(row[1]!)) {
      if (current.chapters.length > 0) volumes.push(current)
      current = { title: stripTags(head[1]!), chapters: [] }
    }
  }
  if (current.chapters.length > 0) volumes.push(current)
  return volumes
}

export function parseKanunuMeta(html: string): { title: string; author: string | null } {
  const titleRaw = /<div class="catalog">\s*<h1>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? ''
  const title = stripTags(titleRaw).split(/ - | by |全集|在线阅读/)[0]!.trim()
  const authorRaw = /<div class="info">作者：([\s\S]*?)<\/div>/.exec(html)?.[1]
    ?? /作者：\s*([^<\s]{1,20})/.exec(html)?.[1]
    ?? /<title>[\s\S]*? - (\S{1,12}) - 小说在线阅读/.exec(html)?.[1]
    ?? /<title>[\s\S]*? by (\S{1,12}) -/.exec(html)?.[1]
  return { title, author: authorRaw ? stripTags(authorRaw) || null : null }
}

export function parseKanunuBody(html: string): string[] {
  const neirong = /<div class="neirong" id="neirong">([\s\S]*?)<\/div>/.exec(html)?.[1]
  if (neirong !== undefined) return htmlParagraphs(neirong)
  const td = /<td width="820"[^>]*>([\s\S]*?)<\/td>/.exec(html)?.[1]
  if (td !== undefined) return htmlParagraphs(td)
  return htmlParagraphs([...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]).join('<br>'))
}

export const kanunu: NovelSource = {
  name: 'kanunu',
  description: '出版读物（简体）：国内外文学、推理、科幻、武侠，靠本地索引按书名找',
  language: 'zh-Hans',
  volumesAreBooks: false,

  match(input) {
    const m = URL_RE.exec(input)
    return m ? normalizeBookPath(m[1]!) : null
  },

  async search(keyword) {
    const index = loadIndex()
    return index ? searchIndex(index, keyword) : []
  },

  async book(id, signal) {
    const url = BASE + normalizeBookPath(id)
    const html = await get(url, signal)
    const { title, author } = parseKanunuMeta(html)
    const volumes = parseKanunuToc(html)
    if (!title || volumes.length === 0) {
      throw new AstraError('NOVEL_SITE_CHANGED', `努努书坊书页上没找到书名或目录：${normalizeBookPath(id)}`, { exitCode: 5 })
    }
    return { source: 'kanunu', id: normalizeBookPath(id), title, author, cover: null, url, volumes }
  },

  async chapter(book, chapter, signal) {
    const html = await get(`${book.url}${chapter.id}.html`, signal)
    return { paragraphs: parseKanunuBody(html), images: [] }
  },

  async probe(signal) {
    await get('/genres.html', signal)
    const index = loadIndex()
    return index ? `可达；索引 ${index.books.length} 本（${index.builtAt.slice(0, 10)}）` : '可达；索引还没建'
  },
}

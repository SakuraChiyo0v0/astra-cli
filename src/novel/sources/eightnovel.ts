/**
 * 8novel（無限輕小說）：繁体日轻，分卷齐，有站内搜索。
 *
 * ## 正文在哪
 *
 * 阅读页 HTML 里没有正文。页里有一段混淆过的脚本，拼出地址后用
 * `$.get(unescape(<表达式>))` 去拉 `/txt/1/<书号>/<章号><校验 5 位>.html`。
 * 脚本里的变量名每次刷新都会变，所以**不认名字、按结构求值**：
 *
 * 1. 收集 `var 名=值;` 定义（数字、字符串、`"a,b,c".split(',')` 数组）
 * 2. 认出「当前章号」变量：`var X=u.indexOf('?')>0?u.split…` 那个
 * 3. 把 `$.get(unescape(...))` 里的表达式按顶层 `+` 拆开逐项求值，
 *    只认四种项：字符串、数字、变量、`A[A.length-B].substr(C * D % E, F)`
 *
 * 认不出的项直接报 `NOVEL_SITE_CHANGED`，不猜。
 *
 * ## 其它坑
 *
 * - 插图地址是相对路径，真实图床是 `img9.8novel.com`（站点 read.js 里补的前缀）；
 *   主站同一路径返回的是状态码 200 的 404 页
 * - 正文每隔几十段插一整段同形字水印「⑧ΝОνЕ┕。Сοм」，见 `isWatermark`
 */
import { AstraError } from '../../core/errors.ts'
import { fetchText } from '../fetch.ts'
import { htmlParagraphs, stripTags } from '../text.ts'
import type { ChapterRef, NovelSource, SearchHit, Volume } from './types.ts'

const BASE = 'https://www.8novel.com'
const IMG_BASE = 'https://img9.8novel.com'
const URL_RE = /8novel\.com\/(?:novelbooks|read)\/(\d+)/

function siteChanged(what: string): AstraError {
  return new AstraError('NOVEL_SITE_CHANGED', `8novel 页面结构变了：${what}`, {
    exitCode: 5,
    hint: '书源需要跟着改（src/novel/sources/eightnovel.ts），换别的书源试试：--source',
  })
}

// ---------- 混淆脚本求值 ----------

type Value = string | number | string[]

/** 按顶层 `+` 拆表达式（括号与引号内的 `+` 不算）。 */
export function splitTopLevel(expr: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (const ch of expr) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth += 1
    else if (ch === ')' || ch === ']') depth -= 1
    if (ch === '+' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

/** 收集 `var x=...;` 里能静态确定的值。 */
export function collectVars(script: string): Map<string, Value> {
  const env = new Map<string, Value>()
  for (const statement of script.split(';')) {
    const m = /^\s*var\s+(\w+)\s*=\s*([\s\S]*)$/.exec(statement)
    if (!m) continue
    const name = m[1]!
    const raw = m[2]!.trim()
    const split = /^"([^"]*)"\.split\('(.)'\)$/.exec(raw)
    if (split) env.set(name, split[1]!.split(split[2]!))
    else if (/^-?\d+$/.test(raw)) env.set(name, Number(raw))
    else if (/^'[^']*'$|^"[^"]*"$/.test(raw)) env.set(name, raw.slice(1, -1))
  }
  return env
}

function num(env: Map<string, Value>, token: string): number {
  if (/^-?\d+$/.test(token)) return Number(token)
  const v = env.get(token)
  if (typeof v === 'number') return v
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v)
  throw siteChanged(`地址公式里的 ${token} 不是数字`)
}

const SUBSTR_RE = /^(\w+)\[(\w+)\.length-(\w+)\]\.substr\((\w+) \* (\w+) % (\w+), (\w+)\)$/

export function evalTerm(term: string, env: Map<string, Value>): string {
  // (typeof(td)!='undefined'?td:'') —— 站点镜像前缀，主站恒为空
  if (term.startsWith('(typeof(')) return ''
  if (/^'[^']*'$|^"[^"]*"$/.test(term)) return term.slice(1, -1)
  if (/^-?\d+$/.test(term)) return term
  const m = SUBSTR_RE.exec(term)
  if (m) {
    const arr = env.get(m[1]!)
    if (!Array.isArray(arr)) throw siteChanged(`${m[1]} 不是数组`)
    const s = arr[arr.length - num(env, m[3]!)] ?? ''
    const start = (num(env, m[4]!) * num(env, m[5]!)) % num(env, m[6]!)
    return s.substr(start, num(env, m[7]!))
  }
  const v = env.get(term)
  if (v !== undefined && !Array.isArray(v)) return String(v)
  throw siteChanged(`地址公式里有认不出的项「${term.slice(0, 60)}」`)
}

export interface ReaderScript {
  /** 本书全部章节 id（阅读页脚本里的顺序）。 */
  ids: string[]
  /** 与 ids 对应的完整章节名（含「第N卷 副标题」），可能缺。 */
  names: string[]
  url: (chapterId: string) => string
}

/** 从阅读页 HTML 里找到加载正文的脚本并准备好求值。 */
export function parseReader(html: string): ReaderScript {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
  const script = scripts.find((s) => s.includes('$.get(unescape('))
  if (!script) throw siteChanged('阅读页里没有正文加载脚本')
  const env = collectVars(script)
  const cidVar = /var (\w+)=u\.indexOf\('\?'\)>0\?u\.split/.exec(script)?.[1]
  const expr = /\$\.get\(unescape\(([\s\S]*?)\),function/.exec(script)?.[1]
  if (!cidVar || !expr) throw siteChanged('认不出正文地址公式')
  const lists = [...env.values()].filter((v): v is string[] => Array.isArray(v))
  const idList = lists.find((v) => v.length > 1 && v.slice(0, -1).every((x) => /^\d+$/.test(x)))
  if (!idList) throw siteChanged('没找到章节 id 列表')
  // 最后一项是取校验码用的长串，不是章节
  const ids = idList.slice(0, -1)
  const names = lists.find((v) => v.length === ids.length && !v.every((x) => /^\d+$/.test(x))) ?? []
  const terms = splitTopLevel(expr)
  return {
    ids,
    names,
    url: (chapterId) => {
      const local = new Map(env)
      local.set(cidVar, chapterId)
      return BASE + decodeURIComponent(terms.map((t) => evalTerm(t, local)).join(''))
    },
  }
}

// ---------- 水印 ----------

/**
 * 同形字 → ASCII。先 NFKC（全角、`⒏`、`⑧` 这类兼容字都归到 ASCII），
 * 再查这张表补 NFKC 管不到的希腊 / 西里尔 / 制表符 / 片假名形近字。
 * 实测见过的水印：「⑧ΝОνЕ┕。Сοм」「８ＮОvヨ└．ｃоm」「⒏NσＶｅ└．Ｃом」。
 */
const HOMOGLYPH: Record<string, string> = {
  'Ν': 'N', 'Н': 'N', 'и': 'n', 'п': 'n', 'η': 'n',
  'Ο': 'O', 'О': 'O', 'ο': 'o', 'о': 'o', 'σ': 'o', 'θ': 'o', '○': 'o', '〇': 'o',
  'ν': 'v', 'ѵ': 'v', 'Ѵ': 'V', 'υ': 'v',
  'Ε': 'E', 'Е': 'E', 'Ё': 'E', 'е': 'e', 'ε': 'e', 'ヨ': 'E', 'ё': 'e',
  '┕': 'L', '┗': 'L', '└': 'L', '∟': 'L', 'ι': 'l', 'Ι': 'l', '丨': 'l', '|': 'l',
  '。': '.', '·': '.', '・': '.', '﹒': '.', '｡': '.',
  'С': 'C', 'с': 'c', 'Ϲ': 'C', 'ϲ': 'c',
  'м': 'm', 'М': 'M', 'ｍ': 'm', 'Μ': 'M',
}

export function foldHomoglyphs(text: string): string {
  return [...text.normalize('NFKC')].map((c) => HOMOGLYPH[c] ?? c).join('')
}

/** 整段都是「8novel.com」的同形字变体才算水印（字母偶尔会少一个）。正文里的英文不受影响。 */
export function isWatermark(paragraph: string): boolean {
  if (paragraph.length > 24) return false
  const folded = foldHomoglyphs(paragraph).replace(/\s+/g, '')
  return /^8\.?n?o?v?e?l?\.c?o?m$/i.test(folded) && /^8\.?n/i.test(folded) && /\.c?om$/i.test(folded)
}

// ---------- 书源 ----------

function meta(html: string, key: string): string {
  const m = new RegExp(`<meta property="og:${key}" content="([^"]*)"`).exec(html)
  return m ? stripTags(m[1]!) : ''
}

/** 书页目录：`<h3 class="px-2">第一卷</font> … <ul>章节</ul>`。 */
export function parseToc(html: string, bookId: string): Volume[] {
  const volumes: Volume[] = []
  for (const m of html.matchAll(/<h3 class="px-2">([\s\S]*?)<\/font>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/g)) {
    const chapters: ChapterRef[] = []
    for (const c of m[2]!.matchAll(new RegExp(`href='/read/${bookId}/\\?(\\d+)'>([\\s\\S]*?)</a>`, 'g'))) {
      chapters.push({ id: c[1]!, title: stripTags(c[2]!) })
    }
    if (chapters.length > 0) volumes.push({ title: stripTags(m[1]!), chapters })
  }
  return volumes
}

const readerCache = new Map<string, ReaderScript>()

async function reader(bookId: string, firstChapter: string, signal?: AbortSignal): Promise<ReaderScript> {
  const hit = readerCache.get(bookId)
  if (hit) return hit
  const html = await fetchText(`${BASE}/read/${bookId}/?${firstChapter}`, { referer: `${BASE}/novelbooks/${bookId}/`, ...(signal ? { signal } : {}) })
  const parsed = parseReader(html)
  readerCache.set(bookId, parsed)
  return parsed
}

export const eightnovel: NovelSource = {
  name: '8novel',
  description: '日本轻小说（繁体），分卷齐全，站内搜索',
  language: 'zh-Hant',
  volumesAreBooks: true,

  match(input) {
    return URL_RE.exec(input)?.[1] ?? null
  },

  async search(keyword, signal) {
    const html = await fetchText(`${BASE}/search/?key=${encodeURIComponent(keyword)}`, { referer: `${BASE}/`, ...(signal ? { signal } : {}) })
    const seen = new Set<string>()
    const hits: SearchHit[] = []
    for (const m of html.matchAll(/href='\/novelbooks\/(\d+)'\s+title='([^']+)'/g)) {
      if (seen.has(m[1]!)) continue
      seen.add(m[1]!)
      hits.push({ source: 'eightnovel', id: m[1]!, title: stripTags(m[2]!), author: null })
    }
    return hits
  },

  async book(id, signal) {
    const url = `${BASE}/novelbooks/${id}/`
    const html = await fetchText(url, { referer: `${BASE}/`, ...(signal ? { signal } : {}) })
    const volumes = parseToc(html, id)
    if (volumes.length === 0) throw siteChanged('书页上没有目录')
    const title = meta(html, 'novel:book_name') || meta(html, 'title')
    if (!title) throw siteChanged('书页上没有书名')
    return {
      source: 'eightnovel',
      id,
      title,
      author: meta(html, 'novel:author') || null,
      cover: meta(html, 'image') || null,
      url,
      volumes,
    }
  },

  async chapter(book, chapter, signal) {
    const first = book.volumes[0]!.chapters[0]!.id
    const rd = await reader(book.id, first, signal)
    const raw = await fetchText(rd.url(chapter.id), { referer: `${BASE}/read/${book.id}/?${chapter.id}`, ...(signal ? { signal } : {}) })
    // 正文地址算错时站点返回的是 404 页（状态码却是 200）
    if (raw.includes('<title>404.')) throw new AstraError('NOVEL_CHAPTER_MISSING', `「${chapter.title}」的正文取不到`, { exitCode: 5, retryable: true })
    const images = [...raw.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => (m[1]!.startsWith('http') ? m[1]! : IMG_BASE + m[1]!))
    return { paragraphs: htmlParagraphs(raw).filter((p) => !isWatermark(p)), images }
  },

  async probe(signal) {
    const hits = await this.search('青春', signal)
    return `搜索可用（「青春」${hits.length} 条）`
  },
}

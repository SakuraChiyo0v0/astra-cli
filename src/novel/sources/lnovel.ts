/**
 * lnovel.tw（輕小說百科）：繁体日轻。书页、章节页都是静态 HTML。
 *
 * 没有可用的站内搜索，只认书号和书页链接。纯数字输入也按这里的书号处理。
 *
 * - 正文在 `<article class="card mb-4">` 里，一段一个 `<p>`
 * - 「插畫」是独立一节，正文里只有 `<img>` 没有 `<p>` —— 只取文字会把整节丢掉
 * - 封面优先 `og:image`；没有就找 `alt` 等于书名的 `<img>`（属性顺序不固定，逐个标签解析）；
 *   `.jpg.small.webp` 是缩略图，去掉后缀就是 270×360 的原图
 */
import { AstraError } from '../../core/errors.ts'
import { fetchText } from '../fetch.ts'
import { stripTags } from '../text.ts'
import type { NovelSource } from './types.ts'

const BASE = 'https://lnovel.tw'
const URL_RE = /lnovel\.tw\/books-(\d+)/

export function findCover(html: string, title: string): string | null {
  let cover = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/.exec(html)?.[1] ?? ''
  if (!cover) {
    for (const tag of html.match(/<img[^>]*>/g) ?? []) {
      const alt = /alt="([^"]*)"/.exec(tag)?.[1]
      const src = /src="([^"]+)"/.exec(tag)?.[1]
      if (alt !== undefined && src && alt.trim() === title) {
        cover = src
        break
      }
    }
  }
  if (!cover) return null
  if (cover.startsWith('/')) cover = BASE + cover
  if (cover.endsWith('.small.webp')) {
    cover = cover.slice(0, -'.small.webp'.length)
    if (!/\.(jpe?g|png|webp)$/i.test(cover)) cover += '.jpg'
  }
  return cover
}

export const lnovel: NovelSource = {
  name: 'lnovel',
  description: '日本轻小说（繁体），只认书号 / 书页链接',
  language: 'zh-Hant',
  volumesAreBooks: true,

  match(input) {
    const m = URL_RE.exec(input)
    if (m) return m[1]!
    return /^\d+$/.test(input.trim()) ? input.trim() : null
  },

  async search() {
    return []
  },

  async book(id, signal) {
    const url = `${BASE}/books-${id}`
    const html = await fetchText(url, { referer: `${BASE}/`, ...(signal ? { signal } : {}) })
    const rawTitle = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1]
    if (!rawTitle) throw new AstraError('NOVEL_SITE_CHANGED', 'lnovel 书页上没有书名', { exitCode: 5 })
    const title = stripTags(rawTitle).split(' - ')[0]!.trim()
    const authorRaw = /作者[\s\S]{0,120}?>\s*([^<\s][^<]{0,30})/.exec(html)?.[1]
    const chapters: { id: string; title: string }[] = []
    for (const m of html.matchAll(/href="\/chapters-(\d+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      if (chapters.some((c) => c.id === m[1])) continue
      chapters.push({ id: m[1]!, title: stripTags(m[2]!) || `第${chapters.length + 1}节` })
    }
    if (chapters.length === 0) throw new AstraError('NOVEL_SITE_CHANGED', 'lnovel 书页上没有目录', { exitCode: 5 })
    return {
      source: 'lnovel',
      id,
      title,
      author: authorRaw ? stripTags(authorRaw) : null,
      cover: findCover(html, title),
      url,
      volumes: [{ title: '正文', chapters }],
    }
  },

  async chapter(book, chapter, signal) {
    const html = await fetchText(`${BASE}/chapters-${chapter.id}`, { referer: book.url, ...(signal ? { signal } : {}) })
    const article = /<article class="card mb-4">([\s\S]*?)<\/article>/.exec(html)?.[1]
    if (article === undefined) throw new AstraError('NOVEL_SITE_CHANGED', `lnovel 章节页没有正文容器：${chapter.title}`, { exitCode: 5 })
    const paragraphs = [...article.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => stripTags(m[1]!)).filter(Boolean)
    const images = [...article.matchAll(/<img[^>]*src="([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((src) => src.includes('/uploads/'))
      .map((src) => (src.startsWith('http') ? src : BASE + src))
    return { paragraphs, images }
  },

  async probe(signal) {
    await fetchText(`${BASE}/`, { ...(signal ? { signal } : {}) })
    return '首页可达'
  },
}

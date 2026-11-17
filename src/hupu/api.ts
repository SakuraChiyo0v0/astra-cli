/**
 * 虎扑只读抓取（网页层，无签名、无登录）。
 *
 * 实测口径（2026-11-17）：
 *  - `bbs.hupu.com/topic-daily`、`/bxj`、`/nba` 带普通 UA 即可 200，页面 300KB 左右；
 *  - 列表页 8 次 / 0.6s 间隔、详情页 5 次 / 0.8s 间隔全部 200，未出现验证码或降级；
 *  - 长期高频阈值没测过，所以批量抓取一律有界并发 + 间隔，且遇到验证码直接报错不重试。
 *
 * 只做「读」：列表、正文。回帖是异步加载、搜索走 App 签名、发帖要点亮态，都不在范围内。
 */
import { AstraError } from '../core/errors.ts'

const BASE = 'https://bbs.hupu.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const TIMEOUT_MS = 15_000

export interface HupuListItem {
  tid: string
  title: string
  url: string
}

export interface HupuPost {
  tid: string
  title: string
  board: string | null
  author: string | null
  content: string
  images: number
  views: number | null
  replies: number | null
  url: string
}

/** 已验证能打开的板块。其它板块路径可以直接传给 --board（虎扑的路径规则是 /<board>）。 */
export const BOARDS: Array<{ board: string; label: string; verified: boolean }> = [
  { board: 'topic-daily', label: '热帖榜（每日）', verified: true },
  { board: 'bxj', label: '步行街', verified: true },
  { board: 'nba', label: 'NBA', verified: true },
  { board: 'cba', label: 'CBA', verified: true },
]

function decodeEntities(s: string): string {
  const map: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
  }
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => map[m] ?? m)
}

export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim()
}

async function getHtml(url: string): Promise<{ html: string; finalUrl: string }> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        'user-agent': UA,
        'accept-language': 'zh-CN,zh;q=0.9',
        referer: `${BASE}/`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new AstraError('HUPU_NETWORK', `请求虎扑失败：${(error as Error).message}`, {
      hint: '检查出网；虎扑是国内站，通常不需要代理',
    })
  }
  if (!res.ok) {
    throw new AstraError('HUPU_HTTP', `虎扑返回 HTTP ${res.status}`, {
      hint: '稍后重试；连续失败可能是被限流',
    })
  }
  const html = await res.text()
  const head = html.slice(0, 4000)
  if (/访问验证|安全验证|captcha/i.test(head)) {
    throw new AstraError('HUPU_BLOCKED', '虎扑要求人机验证（可能被限流）', {
      hint: '等几分钟再试，并把抓取频率降下来；不要自动重试',
    })
  }
  return { html, finalUrl: res.url || url }
}

/**
 * 列表页 → 帖子条目。纯函数，方便用固定 HTML 做单测。
 * 同一 tid 在页面里会出现多次（标题、图片卡、热榜侧栏），按 tid 去重并保留第一个能用的标题。
 */
export function parseList(html: string): HupuListItem[] {
  const out: HupuListItem[] = []
  const seen = new Set<string>()
  const re = /<a[^>]+href="[^"]*?\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const tid = m[1]
    if (!tid || seen.has(tid)) continue
    const title = stripTags(m[2] ?? '')
      .replace(/^\s*\d+\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (title.length < 6) continue
    seen.add(tid)
    out.push({ tid, title, url: `${BASE}/${tid}.html` })
  }
  return out
}

/** 从详情页标题里拆出板块（`标题-步行街主干道-虎扑社区`）。 */
export function boardOf(rawTitle: string): string | null {
  const segs = rawTitle
    .split(/[-_]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (segs.length >= 3) return segs[1] ?? null
  return null
}

/**
 * 详情页 → 帖子正文。纯函数。
 * 页面里正文有主楼和 `seo-dom` 两个副本，洗的时候整段去重；工具栏（推荐/评论/分享）按特征切掉。
 */
export function parsePost(html: string, tid: string): HupuPost {
  // 虎扑在「推荐<!-- --> (67)」这类位置插了 HTML 注释，先去掉再匹配，否则数字取不到
  const clean = html.replace(/<!--[\s\S]*?-->/g, '')
  const titleRaw = /<title>([\s\S]*?)<\/title>/.exec(clean)?.[1] ?? ''
  const rawTitle = stripTags(titleRaw)
  const segs = rawTitle
    .split(/[-_]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const hasSiteSuffix = segs.length >= 2 && /虎扑/.test(segs[segs.length - 1] ?? '')
  const boardFromPost = /发表在<a[^>]*>([^<]{2,20})<\/a>/.exec(clean)?.[1]?.trim() ?? null
  const board = boardFromPost ?? (hasSiteSuffix && segs.length >= 3 ? (segs[segs.length - 2] ?? null) : null)
  const title = (hasSiteSuffix ? segs.slice(0, board ? -2 : -1) : segs).join('-') || rawTitle

  // 页面原文：由<span class="…">皇马妹妹</span>发表在<a …>步行街主干道</a>
  const author = /由<span[^>]*>([^<]{1,30}?)<\/span>发表在/.exec(clean)?.[1]?.trim() ?? null
  const viewsM = /推荐\s*\((\d+)\)/.exec(clean)
  const repliesM = /评论\s*\((\d+)\)/.exec(clean)
  const views = viewsM ? Number(viewsM[1]) : null
  const replies = repliesM ? Number(repliesM[1]) : null

  const attrAt = html.search(/class="[^"]*main-thread[^"]*"/)
  const mainStart = attrAt >= 0 ? html.indexOf('>', attrAt) + 1 : -1
  const mainEndMark = html.indexOf('这些回帖亮了')
  const segEnd = mainEndMark > mainStart && mainStart >= 0 ? mainEndMark : html.length
  const seg = mainStart >= 0 ? html.slice(mainStart, segEnd) : html

  const images = (seg.match(/<img/gi) ?? []).length

  let raw = stripTags(seg)
  const cutoff = raw.indexOf('含AI生成内容')
  if (cutoff > 0) raw = raw.slice(0, cutoff)
  raw = raw.replace(/(推荐|点赞)\s*\(\d+\).{0,160}$/, '')

  const drop = new Set(['QQ', 'QQ空间', '微博', '微信扫一扫分享', '这些回帖亮了', '分享', '复制'])
  const cleaned: string[] = []
  for (const line of raw.split('\n')) {
    const x = line.trim()
    if (!x || drop.has(x) || x.startsWith('http')) continue
    if (x.length < 40 && (/[推荐评论]\s*\(\d+\)/.test(x) || x.includes('只看楼主'))) continue
    if (cleaned.length > 0 && cleaned[cleaned.length - 1] === x) continue
    cleaned.push(x)
  }
  const seen = new Set<string>()
  const dedup: string[] = []
  for (const x of cleaned) {
    if (x.length > 20 && seen.has(x)) continue
    seen.add(x)
    dedup.push(x)
  }

  return {
    tid,
    title,
    board,
    author,
    content: dedup.join('\n'),
    images,
    views,
    replies,
    url: `${BASE}/${tid}.html`,
  }
}

export interface ListOptions {
  board: string
  limit: number
}

export async function listBoard({ board, limit }: ListOptions): Promise<HupuListItem[]> {
  const url = `${BASE}/${encodeURIComponent(board)}`
  const { html, finalUrl } = await getHtml(url)
  // 不存在的板块会被 302 到首页/其它路径；只看 status 会把它当成「有帖子」
  const wantPath = `/${board}`.replace(/\/$/, '').toLowerCase()
  const gotPath = new URL(finalUrl).pathname.replace(/\/$/, '').toLowerCase()
  // 无效板块不一定 302：实测会 200 + 通用首页内容，标题固定是「虎扑社区-虎扑网」
  const pageTitle = (/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? '').trim()
  if (gotPath !== wantPath || pageTitle === '虎扑社区-虎扑网') {
    throw new AstraError('HUPU_BOARD_NOT_FOUND', `板块 ${board} 不存在（返回的是首页内容）`, {
      hint: '用 `astra hupu boards` 看已验证的路径；其它板块路径是 /<board>',
    })
  }
  return parseList(html).slice(0, limit)
}

export async function fetchPost(tid: string): Promise<HupuPost> {
  if (!/^\d{4,}$/.test(tid)) {
    throw new AstraError('INVALID_INPUT', '帖子 id 必须是纯数字', { hint: '可以用帖子链接里的那串数字' })
  }
  const { html } = await getHtml(`${BASE}/${tid}.html`)
  // 删帖/隐藏帖在网页上是 200 + 提示页（title 为空、没有 main-thread）
  if (!/main-thread/.test(html) && /404|不存在|已删除/.test(html.slice(0, 30_000))) {
    throw new AstraError('HUPU_POST_NOT_FOUND', `帖子 ${tid} 不存在或已删除`, {
      hint: '确认 tid；被删/隐藏的帖子网页返回 200 但正文是提示页',
    })
  }
  return parsePost(html, tid)
}

/** 从「链接 / 纯数字」里取 tid。 */
export function tidOf(input: string): string | null {
  const byUrl = /bbs\.hupu\.com\/(\d+)\.html/.exec(input)?.[1]
  if (byUrl) return byUrl
  if (/^\d{4,}$/.test(input.trim())) return input.trim()
  return null
}

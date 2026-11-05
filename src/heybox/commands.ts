/**
 * `astra heybox ...`：小黑盒社区只读查询。
 *
 * v1 只做匿名可用的两条：首页信息流、全站搜索。
 * 帖子详情/评论（`/bbs/app/link/tree`）匿名会被要求人机验证，等接了登录态再加。
 */
import type { Command } from '../core/command.ts'
import { invalidInput } from '../core/errors.ts'
import { okResult } from '../core/output.ts'
import { listFeeds, mapLink, searchLinks, getLinkTree, fetchSession, searchGames, getGameDetail } from './api.ts'
import { clearCredential, loadCredential, saveCredential } from './auth.ts'
import { openHeyboxDb, readGame, readPost, saveGame, savePost, searchPosts } from './db.ts'

function num(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) {
    throw invalidInput(`${name} 必须是 ${min}..${max} 的整数`, `收到：${String(value)}`)
  }
  return Math.trunc(n)
}

const feed: Command = {
  name: 'heybox feed',
  summary: '小黑盒首页信息流（帖子列表）',
  usage: 'astra heybox feed [--limit 20] [--offset 0]',
  notes: ['匿名接口，不需要登录；返回 linkId / 标题 / 摘要 / 赞 / 评论数 / 话题。'],
  options: {
    limit: { type: 'string', description: '取多少条，默认 20，上限 50', valueName: 'n' },
    offset: { type: 'string', description: '偏移，翻页用', valueName: 'n' },
  },
  maxArgs: 0,
  async run({ values }) {
    const limit = num(values.limit, 20, 1, 50, '--limit')
    const offset = num(values.offset, 0, 0, 10_000, '--offset')
    const items = (await listFeeds(limit, offset)).map(mapLink)
    return {
      ...okResult({ count: items.length, offset, items }),
      table: {
        headers: ['linkId', '标题', '话题', '赞', '评论', '时间'],
        rows: items.map((i) => [
          String(i.linkId ?? ''),
          String(i.title ?? '').slice(0, 34),
          String(i.topic ?? '-'),
          String(i.up ?? 0),
          String(i.comments ?? 0),
          String(i.createdAt ?? '-'),
        ]),
      },
    }
  },
}

const search: Command = {
  name: 'heybox search',
  summary: '搜小黑盒社区帖子（攻略、评测、资讯）',
  usage: 'astra heybox search <关键词> [--limit 20] [--offset 0]',
  notes: [
    '匿名接口。结果只保留帖子类，过滤掉「相关游戏 / 筛选器」这些占位块。',
    '关键词可以是游戏名、攻略主题，中文直接传，不用转义。',
  ],
  options: {
    limit: { type: 'string', description: '取多少条，默认 20，上限 50', valueName: 'n' },
    offset: { type: 'string', description: '偏移，翻页用', valueName: 'n' },
  },
  minArgs: 1,
  maxArgs: 10,
  async run({ positionals, values }) {
    const keyword = positionals.join(' ').trim()
    if (!keyword) throw invalidInput('要给搜索关键词', '例：astra heybox search 艾尔登法环')
    const limit = num(values.limit, 20, 1, 50, '--limit')
    const offset = num(values.offset, 0, 0, 10_000, '--offset')
    const items = (await searchLinks(keyword, limit, offset)).map(mapLink)
    return {
      ...okResult({ keyword, count: items.length, offset, items }),
      table: {
        headers: ['linkId', '标题', '话题', '赞', '评论', '时间'],
        rows: items.map((i) => [
          String(i.linkId ?? ''),
          String(i.title ?? '').slice(0, 34),
          String(i.topic ?? '-'),
          String(i.up ?? 0),
          String(i.comments ?? 0),
          String(i.createdAt ?? '-'),
        ]),
      },
    }
  },
}

const LOGIN_HINT = '浏览器打开 xiaoheihe.cn → F12 → Network → 任一请求的 Cookie 整条复制'

/** 登录态下的请求之间至少隔 5 秒：小黑盒写/读详情接口频率高了就弹验证码。 */
let lastAuthedAt = 0
async function throttle(): Promise<void> {
  const gap = 5000 - (Date.now() - lastAuthedAt)
  if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap))
  lastAuthedAt = Date.now()
}

function mask(cookie: string): string {
  return cookie.length <= 24 ? '***' : `${cookie.slice(0, 8)}…${cookie.slice(-6)}（${cookie.length} 字符）`
}

const login: Command = {
  name: 'heybox login',
  summary: '保存小黑盒登录 cookie（600 权限，供帖子详情/评论用）',
  usage: 'astra heybox login <cookie 字符串>',
  notes: [
    '整条 cookie 一起传（`k=v; k2=v2`），只存本机 ASTRA_HOME/heybox.json，权限 600。',
    `从哪拿：${LOGIN_HINT}`,
    '存完会用「消息列表」这条最轻的接口验一次登录态。',
  ],
  minArgs: 1,
  maxArgs: 40,
  async run({ positionals }) {
    const raw = positionals.join(' ')
    const cred = saveCredential(raw)
    const session = await fetchSession(cred).catch(() => ({ loggedIn: false, heyboxId: cred.heyboxId }))
    return {
      ...okResult({
        saved: true,
        loggedIn: session.loggedIn,
        heyboxId: session.heyboxId || null,
        cookie: mask(cred.cookie),
      }),
      table: {
        headers: ['项', '值'],
        rows: [
          ['cookie', mask(cred.cookie)],
          ['heybox_id', session.heyboxId || '（未识别，不影响读取）'],
          ['登录态', session.loggedIn ? '有效' : '未验证通过（可能已过期）'],
        ],
      },
    }
  },
}

const status: Command = {
  name: 'heybox status',
  summary: '看小黑盒登录态',
  usage: 'astra heybox status',
  maxArgs: 0,
  async run() {
    const cred = loadCredential()
    if (!cred) {
      return {
        ...okResult({ loggedIn: false, saved: false }),
        table: { headers: ['项', '值'], rows: [['登录态', '未登录（只读接口仍可用）']] },
      }
    }
    const session = await fetchSession(cred).catch(() => ({ loggedIn: false, heyboxId: cred.heyboxId }))
    return {
      ...okResult({
        saved: true,
        loggedIn: session.loggedIn,
        heyboxId: session.heyboxId || null,
        savedAt: cred.savedAt,
        cookie: mask(cred.cookie),
      }),
      table: {
        headers: ['项', '值'],
        rows: [
          ['登录态', session.loggedIn ? '有效' : '失效/未验证'],
          ['heybox_id', session.heyboxId || '-'],
          ['保存时间', cred.savedAt.slice(0, 19).replace('T', ' ')],
          ['cookie', mask(cred.cookie)],
        ],
      },
    }
  },
}

const logout: Command = {
  name: 'heybox logout',
  summary: '清除本机保存的小黑盒 cookie',
  usage: 'astra heybox logout',
  maxArgs: 0,
  async run() {
    const cleared = clearCredential()
    return {
      ...okResult({ cleared }),
      table: { headers: ['项', '值'], rows: [['cookie', cleared ? '已清除' : '本来就没有']] },
    }
  },
}

const post: Command = {
  name: 'heybox post',
  summary: '看单个帖子：正文 + 图片 + 首屏评论（需登录）',
  usage: 'astra heybox post <linkId> [--comments 10]',
  notes: ['需要 `heybox login` 保存过 cookie；匿名调用会被人机验证拦下。', '请求间自动限速 5 秒。'],
  options: {
    comments: { type: 'string', description: '带多少条评论，默认 10，0 表示只看正文', valueName: 'n' },
    refresh: { type: 'boolean', description: '强制重新请求接口（默认库里有时直接读库）' },
    raw: { type: 'boolean', description: '附上原始 link/comments 结构（调试字段映射用）' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    const cred = loadCredential()
    if (!cred) throw invalidInput('没有登录态', '先跑 astra heybox login <cookie>')
    const linkId = requireLinkId(positionals[0])
    const limit = num(values.comments, 10, 0, 50, '--comments')
    const refresh = values.refresh === true
    const db = await openHeyboxDb()

    // 先读库：详情接口 5 分钟一次，同一篇不该重复请求
    if (!refresh) {
      const cached = await readPost(db, linkId)
      if (cached) return renderPost(cached.post, cached.comments.slice(0, limit), 'cache')
    }

    await throttle()
    const { link, comments } = await getLinkTree(linkId, { limit: Math.max(limit, 1), credential: cred })
    if (!link) throw invalidInput('没拿到帖子', '链接 id 可能不存在，或登录态已失效')

    const rich = parseRichText(link.text)
    const text = rich.text || cleanText(String(link.description ?? ''))
    const images = [...rich.images, ...((link.imgs as string[] | undefined) ?? [])]
    const picked = flattenComments(comments).slice(0, limit).map(mapComment)
    const row = {
      linkId,
      title: cleanText(String(link.title ?? '')),
      author: String((link.user as Record<string, unknown> | undefined)?.username ?? ''),
      authorId: link.userid ? Number(link.userid) : null,
      topic: (link.topics as Array<{ name?: string }> | undefined)?.[0]?.name ?? null,
      body: text,
      images,
      up: Number(link.up ?? 0),
      comments: Number(link.comment_num ?? 0),
      createdAt: link.create_at
        ? new Date(Number(link.create_at) * 1000).toISOString().slice(0, 16).replace('T', ' ')
        : null,
      fetchedAt: new Date().toISOString(),
    }
    const flat = flattenComments(comments)
    const rows = flat
      .filter((c) => c.commentid)
      .map((c) => ({
        commentId: String(c.commentid),
        userId: c.userid ? Number(c.userid) : null,
        text: cleanText(String(c.text ?? '')),
        images: Array.isArray(c.imgs) ? c.imgs.length : 0,
        createdAt: c.create_at
          ? new Date(Number(c.create_at) * 1000).toISOString().slice(0, 16).replace('T', ' ')
          : null,
      }))
    await savePost(db, row, rows, { link, comments })
    return renderPost(row, rows.slice(0, limit), 'network')
  },
}

/** 统一的输出：库里读出来的和刚抓的都是这张表。 */
function renderPost(
  post: { linkId: string; title: string; author: string; topic: string | null; body: string; images: string[]; up: number; comments: number; createdAt: string | null },
  comments: Array<{ commentId?: string; userId: number | null; text: string; images: number; createdAt: string | null }>,
  source: 'cache' | 'network',
) {
  const data = {
    linkId: post.linkId,
    title: post.title,
    author: post.author,
    topic: post.topic,
    text: post.body,
    images: post.images,
    up: post.up,
    comments: post.comments,
    createdAt: post.createdAt,
    url: `https://www.xiaoheihe.cn/app/bbs/link/${post.linkId}`,
    source,
    commentPreview: comments.map((c) => ({
      userId: c.userId,
      text: c.text,
      images: c.images,
      at: c.createdAt,
    })),
  }
  return {
    ...okResult(data),
    table: {
      headers: ['项', '值'],
      rows: [
        ['标题', data.title.slice(0, 40)],
        ['作者', data.author || '-'],
        ['话题', data.topic ?? '-'],
        ['赞/评论', `${data.up} / ${data.comments}`],
        ['图片', String(data.images.length)],
        ['时间', data.createdAt ?? '-'],
        ['来源', source === 'cache' ? '本地库（未请求接口）' : '刚从小黑盒抓取并入库'],
      ],
    },
  }
}

const comments: Command = {
  name: 'heybox comments',
  summary: '看帖子评论区（需登录）',
  usage: 'astra heybox comments <linkId> [--limit 20] [--page 1]',
  notes: ['需要 `heybox login`；分页从 1 开始，每页最多 50 条。'],
  options: {
    limit: { type: 'string', description: '每页多少条，默认 20，上限 50', valueName: 'n' },
    page: { type: 'string', description: '页码，默认 1', valueName: 'n' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    const cred = loadCredential()
    if (!cred) throw invalidInput('没有登录态', '先跑 astra heybox login <cookie>')
    const linkId = requireLinkId(positionals[0])
    const limit = num(values.limit, 20, 1, 50, '--limit')
    const page = num(values.page, 1, 1, 200, '--page')
    await throttle()
    const { comments: raw } = await getLinkTree(linkId, { page, limit, credential: cred })
    const items = flattenComments(raw).map(mapComment)
    return {
      ...okResult({ linkId, page, count: items.length, items }),
      table: {
        headers: ['#', '用户id', '内容', '图', '时间'],
        rows: items.map((i, idx) => [
          String(idx + 1),
          String(i.userId ?? '-'),
          i.text.slice(0, 44),
          String(i.images),
          String(i.at ?? '-'),
        ]),
      },
    }
  },
}

/** 正文 `text` 是一段 JSON 字符串：富文本块数组，text 块拼正文、img 块取 url。 */
function parseRichText(raw: unknown): { text: string; images: string[] } {
  if (typeof raw !== 'string' || !raw.trim().startsWith('[')) {
    return { text: cleanText(String(raw ?? '')), images: [] }
  }
  try {
    const blocks = JSON.parse(raw) as Array<Record<string, unknown>>
    const text = blocks
      .filter((b) => (b.type ?? 'text') === 'text')
      .map((b) => String(b.text ?? ''))
      .join('\n')
    const images = blocks
      .filter((b) => b.type === 'img' && typeof b.url === 'string')
      .map((b) => String(b.url))
    return { text: cleanText(text), images }
  } catch {
    return { text: cleanText(raw), images: [] }
  }
}

/**
 * 评论的真实结构是「一层 wrapper」：
 * `{ comment: [ {commentid,userid,text,imgs,create_at}, ... ] }`，第一个是主楼、后面是楼中楼。
 * 且**只有 userid，没有昵称**——补昵称要再打一次用户接口，撞验证码不值得，先只用 id。
 */
function flattenComments(raw: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const item of raw) {
    const inner = item.comment
    if (Array.isArray(inner)) out.push(...(inner as Array<Record<string, unknown>>))
    else if (item.commentid) out.push(item)
  }
  return out
}

function mapComment(c: Record<string, unknown>): { userId: number | null; text: string; images: number; at: string | null; reply: boolean } {
  const at = c.create_at ? new Date(Number(c.create_at) * 1000).toISOString().slice(0, 16).replace('T', ' ') : null
  return {
    userId: c.userid ? Number(c.userid) : null,
    text: cleanText(String(c.text ?? c.content ?? '')),
    images: Array.isArray(c.imgs) ? c.imgs.length : 0,
    at,
    reply: Boolean(c.is_link_owner) || Boolean(c.reply_id && Number(c.reply_id) > 0),
  }
}

function requireLinkId(raw: string | undefined): string {
  const value = String(raw ?? '').trim()
  const fromUrl = value.match(/link\/(\d+)/)?.[1]
  const id = fromUrl ?? value
  if (!/^\d+$/.test(id)) throw invalidInput('linkId 要是纯数字', '可以直接粘帖子 URL，会自动取末尾 id')
  return id
}

function cleanText(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[cube_[^\]]+\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const find: Command = {
  name: 'heybox find',
  summary: '在本地小黑盒库里搜已存过的帖子（不请求接口）',
  usage: 'astra heybox find <关键词> [--limit 10]',
  notes: ['只搜 `crawl.heybox_post`：标题 / 正文 / 作者模糊匹配。', '想拉新帖子用 `heybox post <链接>`，它会入库。'],
  options: {
    limit: { type: 'string', description: '最多几条，默认 10，上限 50', valueName: 'n' },
  },
  minArgs: 1,
  maxArgs: 10,
  async run({ positionals, values }) {
    const keyword = positionals.join(' ').trim()
    if (!keyword) throw invalidInput('要给关键词', '例：astra heybox find 法环')
    const limit = num(values.limit, 10, 1, 50, '--limit')
    const db = await openHeyboxDb()
    const items = await searchPosts(db, keyword, limit)
    return {
      ...okResult({ keyword, count: items.length, items }),
      table: {
        headers: ['linkId', '标题', '作者', '评论', '时间'],
        rows: items.map((i) => [
          i.linkId,
          i.title.slice(0, 34),
          i.author || '-',
          String(i.comments),
          i.createdAt ?? '-',
        ]),
      },
    }
  },
}

const game: Command = {
  name: 'heybox game',
  summary: '看游戏：评分、现价/史低、关注数、平台（小黑盒游戏库）',
  usage: 'astra heybox game <游戏名 或 appid> [--refresh]',
  notes: [
    '名称会先搜一次再取详情；也可以直接给 steam appid（纯数字）。',
    '价格 6 小时内直接用库里的，`--refresh` 强制重抓（价格波动不频繁，没必要每次都打接口）。',
  ],
  options: {
    refresh: { type: 'boolean', description: '强制重新抓取（默认 6 小时内读库）' },
  },
  minArgs: 1,
  maxArgs: 10,
  async run({ positionals, values }) {
    const keyword = positionals.join(' ').trim()
    let appid = /^\d+$/.test(keyword) ? keyword : ''
    let name = ''
    if (!appid) {
      const hits = await searchGames(keyword, 8)
      // 优先 PC（有 steam_appid），手游/主机专区也能搜到，但详情接口只认 PC 的 appid
      const first = hits.find((h) => h.steam_appid) ?? hits[0]
      if (!first) throw invalidInput('没搜到这个游戏', '换个写法，或直接给 steam appid')
      appid = String(first.appid ?? '')
      name = String(first.name ?? '')
    }

    const db = await openHeyboxDb()
    if (values.refresh !== true) {
      const row = await readGame(db, appid)
      const fresh = row && Date.now() - Date.parse(String(row.fetched_at ?? 0)) < 6 * 3600_000
      if (row && fresh) return renderGame(row, 'cache')
    }

    const detail = await getGameDetail(appid).catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('非法游戏id')) {
        throw invalidInput('这个 appid 小黑盒不收', '多半是手游/主机专区，详情接口只认 PC 游戏；可试 steam appid')
      }
      throw error
    })
    if (!detail) throw invalidInput('没拿到游戏详情', 'appid 可能不对')
    const price = (detail.price as Record<string, unknown> | undefined) ?? {}
    const fields = {
      name: String(detail.name ?? name),
      nameEn: detail.name_en ?? null,
      score: detail.score ?? null,
      scoreDesc: detail.score_desc ?? null,
      priceCurrent: price.current ?? null,
      priceInitial: price.initial ?? null,
      lowestPrice: price.lowest_price ?? null,
      lowestDiscount: price.lowest_discount ?? null,
      followNum: detail.follow_num ?? null,
      // comment_stats 里没有 total：评分人数在 score_comment，期望人数在 expect_num
      commentNum: (detail.comment_stats as Record<string, unknown> | undefined)?.score_comment ?? null,
      platforms: (detail.platforms as unknown[] | undefined) ?? [],
      tags: (detail.common_tags as unknown[] | undefined) ?? [],
      about: typeof detail.about_the_game === 'string' ? detail.about_the_game.slice(0, 600) : null,
    }
    await saveGame(db, appid, fields, detail)
    return renderGame({ appid, ...fields, fetched_at: new Date().toISOString() }, 'network')
  },
}

function renderGame(row: Record<string, unknown>, source: 'cache' | 'network') {
  const priceNow = row.price_current ?? row.priceCurrent ?? null
  const lowest = row.lowest_price ?? row.lowestPrice ?? null
  const discount = row.lowest_discount ?? row.lowestDiscount ?? null
  const data = {
    appid: Number(row.appid),
    name: String(row.name ?? ''),
    nameEn: row.name_en ?? row.nameEn ?? null,
    score: row.score ?? null,
    scoreDesc: row.score_desc ?? row.scoreDesc ?? null,
    price: { current: priceNow, lowest, lowestDiscount: discount },
    followNum: row.follow_num ?? row.followNum ?? null,
    commentNum: row.comment_num ?? row.commentNum ?? null,
    platforms: parseArr(row.platforms),
    tags: parseArr(row.tags),
    about: row.about ?? null,
    fetchedAt: row.fetched_at ?? null,
    source,
  }
  return {
    ...okResult(data),
    table: {
      headers: ['项', '值'],
      rows: [
        ['游戏', `${data.name}${data.nameEn ? ` / ${data.nameEn}` : ''}`],
        ['小黑盒评分', String(data.score ?? '-')],
        ['现价 / 史低', `${data.price.current ?? '-'} / ${data.price.lowest ?? '-'}${discount ? `（-${discount}%）` : ''}`],
        ['关注 / 评论', `${data.followNum ?? '-'} / ${data.commentNum ?? '-'}`],
        ['平台', data.platforms.join(' / ') || '-'],
        ['抓取时间', String(data.fetchedAt ?? '-').slice(0, 19).replace('T', ' ')],
        ['来源', source === 'cache' ? '本地库（6 小时内）' : '刚抓取并入库'],
      ],
    },
  }
}

function parseArr(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x))
  if (typeof raw === 'string' && raw.startsWith('[')) {
    try {
      return (JSON.parse(raw) as unknown[]).map((x) => String(x))
    } catch {
      return []
    }
  }
  return []
}

export const heyboxCommands: Command[] = [feed, search, login, status, logout, post, comments, find, game]

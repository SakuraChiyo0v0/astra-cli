/**
 * `astra hupu ...`：虎扑社区只读。
 *
 * 只做「看」：板块列表、帖子正文、本地库搜索。
 * 回帖（异步接口）、搜索（App 签名）、发帖点亮（要登录态）都不做。
 */
import type { Command } from '../core/command.ts'
import { invalidInput } from '../core/errors.ts'
import { okResult } from '../core/output.ts'
import { BOARDS, fetchPost, listBoard, tidOf, type HupuPost } from './api.ts'
import { countPosts, openHupuDb, readPost, readScoreBoard, savePost, saveScoreBoard, searchPosts, type HupuPostRow } from './db.ts'
import { SPORTS, fetchScoreBoard, listMatches, listSchedule, locateMatch, parentOf, type HupuScoreBoard } from './match.ts'

function num(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) {
    throw invalidInput(`${name} 必须是 ${min}..${max} 的整数`, `收到：${String(value)}`)
  }
  return Math.trunc(n)
}

function short(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

const list: Command = {
  name: 'hupu list',
  summary: '虎扑板块帖子列表（热帖榜 / 步行街 / NBA）',
  usage: 'astra hupu list [--board topic-daily] [--n 20]',
  notes: [
    '匿名网页，不需要登录。默认板块 topic-daily（每日热帖榜）。',
    '其它板块路径直接传：bxj 步行街、nba、湿乎乎等；`astra hupu boards` 看已验证的那几个。',
    '列表页内容一直在变，所以不做缓存；批量抓取请自己控制间隔。',
  ],
  options: {
    board: { type: 'string', description: '板块路径，默认 topic-daily', valueName: 'path' },
    n: { type: 'string', description: '取多少条，默认 20，上限 100', valueName: 'n' },
  },
  maxArgs: 0,
  async run({ values }) {
    const board = String(values.board ?? 'topic-daily').trim() || 'topic-daily'
    const n = num(values.n, 20, 1, 100, '--n')
    const items = await listBoard({ board, limit: n })
    return {
      ...okResult({
        board,
        returned: items.length,
        truncated: items.length >= n,
        items,
      }),
      table: {
        headers: ['tid', '标题', '链接'],
        rows: items.map((i) => [i.tid, short(i.title, 44), i.url]),
      },
    }
  },
}

function postTable(
  post: {
    tid: string
    title: string
    board?: string | null
    author?: string | null
    replies?: number | null
    views?: number | null
    images?: number
  },
  source: string,
): { headers: string[]; rows: string[][] } {
  return {
    headers: ['项', '值'],
    rows: [
      ['来源', source === 'cache' ? '本地库（--refresh 可重抓）' : '网页'],
      ['tid', post.tid],
      ['标题', short(post.title, 50)],
      ['板块', post.board ?? '-'],
      ['作者', post.author ?? '-'],
      ['回复', post.replies === null || post.replies === undefined ? '-' : String(post.replies)],
      ['浏览', post.views === null || post.views === undefined ? '-' : String(post.views)],
      ['图片', String(post.images ?? 0)],
    ],
  }
}

const post: Command = {
  name: 'hupu post',
  summary: '虎扑帖子正文（默认先查库）',
  usage: 'astra hupu post <tid|链接> [--refresh] [--chars 1200]',
  notes: [
    '默认先查本地库，命中就不发请求；要最新内容用 --refresh。',
    '纯图帖正文为空，会带 images 计数。作者字段取不到时是 null，不做猜测。',
    '不做回帖：那部分在页面里是异步加载的。',
  ],
  options: {
    refresh: { type: 'boolean', description: '忽略缓存，重新抓一次', valueName: '' },
    chars: { type: 'string', description: '正文最多返回多少字，默认 1200，上限 20000', valueName: 'n' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    const tid = tidOf(positionals[0] ?? '')
    if (!tid) throw invalidInput('给帖子 id 或链接', '例：astra hupu post 643975554')
    const chars = num(values.chars, 1200, 50, 20_000, '--chars')
    const refresh = Boolean(values.refresh)

    const db = await openHupuDb()
    if (!refresh) {
      const cached = await readPost(db, tid)
      if (cached) {
        return {
          ...okResult({
            source: 'cache',
            ...cached,
            content: cached.content.slice(0, chars),
            contentChars: cached.content.length,
          }),
          table: postTable(cached, 'cache'),
        }
      }
    }
    const fetched = await fetchPost(tid)
    const row: HupuPostRow = {
      tid: fetched.tid,
      board: fetched.board,
      title: fetched.title,
      author: fetched.author,
      content: fetched.content,
      images: fetched.images,
      views: fetched.views,
      replies: fetched.replies,
      url: fetched.url,
      fetchedAt: new Date().toISOString(),
    }
    await savePost(db, row, fetched satisfies HupuPost)
    return {
      ...okResult({
        source: 'live',
        ...row,
        content: row.content.slice(0, chars),
        contentChars: row.content.length,
      }),
      table: postTable(row, 'live'),
    }
  },
}

const find: Command = {
  name: 'hupu find',
  summary: '在本地虎扑库里搜帖子（标题+正文）',
  usage: 'astra hupu find <关键词> [--limit 20]',
  notes: ['只搜抓过的帖子，不打网络。报数用 total（库内总量），不是 returned。'],
  options: {
    limit: { type: 'string', description: '返回多少条，默认 20，上限 100', valueName: 'n' },
  },
  minArgs: 1,
  maxArgs: 20,
  async run({ positionals, values }) {
    const keyword = positionals.join(' ').trim()
    if (!keyword) throw invalidInput('要给关键词', '例：astra hupu find 房价')
    const limit = num(values.limit, 20, 1, 100, '--limit')
    const db = await openHupuDb()
    const rows = await searchPosts(db, keyword, limit)
    const total = await countPosts(db)
    return {
      ...okResult({
        keyword,
        total,
        returned: rows.length,
        truncated: rows.length >= limit,
        items: rows,
      }),
      table: {
        headers: ['tid', '标题', '板块', '抓取时间'],
        rows: rows.map((r) => [
          r.tid,
          short(r.title, 40),
          r.board ?? '-',
          r.fetchedAt.slice(0, 16).replace('T', ' '),
        ]),
      },
    }
  },
}

const boards: Command = {
  name: 'hupu boards',
  summary: '可用的虎扑板块路径',
  usage: 'astra hupu boards',
  notes: ['verified=false 表示路径没实测过；能打开就说明可用，打不开换个路径再试。'],
  maxArgs: 0,
  async run() {
    return {
      ...okResult({ count: BOARDS.length, boards: BOARDS }),
      table: {
        headers: ['board', '名称', '已实测'],
        rows: BOARDS.map((b) => [b.board, b.label, b.verified ? '是' : '否']),
      },
    }
  },
}

const doctor: Command = {
  name: 'hupu doctor',
  summary: '虎扑域自检：能否打开列表、能否解析正文',
  usage: 'astra hupu doctor',
  notes: ['会真实打两次请求（列表 + 第一篇详情）。页面改版时会在这里先红。'],
  maxArgs: 0,
  async run() {
    const started = Date.now()
    const items = await listBoard({ board: 'topic-daily', limit: 5 })
    const listMs = Date.now() - started
    if (items.length === 0) {
      return {
        ...okResult({ list: { count: 0, ms: listMs }, ok: false }),
        table: { headers: ['项', '值'], rows: [['列表', '0 条——页面结构可能变了'], ['耗时', `${listMs}ms`]] },
      }
    }
    const t2 = Date.now()
    // 热帖榜里常有纯图帖，挑一条有正文的来验解析（最多试 3 条）
    let detail = await fetchPost(items[0]!.tid)
    if (detail.content.length === 0) {
      for (const item of items.slice(1, 3)) {
        const next = await fetchPost(item.tid)
        if (next.content.length > 0) {
          detail = next
          break
        }
      }
    }
    const detailMs = Date.now() - t2
    const bodyOk = detail.content.length > 0 || detail.images > 0
    return {
      ...okResult({
        ok: bodyOk,
        list: { count: items.length, ms: listMs },
        detail: {
          tid: detail.tid,
          titleChars: detail.title.length,
          contentChars: detail.content.length,
          images: detail.images,
          ms: detailMs,
          bodyOk,
        },
      }),
      table: {
        headers: ['项', '值'],
        rows: [
          ['列表', `${items.length} 条 / ${listMs}ms`],
          ['详情', `${detail.tid} / ${detailMs}ms`],
          ['正文', bodyOk ? `${detail.content.length} 字 / ${detail.images} 图` : '空——解析可能失效'],
        ],
      },
    }
  },
}

const match: Command = {
  name: 'hupu match',
  summary: '虎扑赛程：比分、评分人数、当场最高分',
  usage: 'astra hupu match [--sport nba] [--limit 10] [--date 2026-11-17]',
  notes: [
    '走 match-api.hupu.com，匿名，不需要 Cookie；路径里带客户端版本号，虎扑发版后可能失效。',
    '接口一次返回整个赛季，这里取最近结束/即将开始的若干场，最新的在前。',
    '足球只有英超（epl）和世界杯（worldcup）；其它联赛 id 上游返回空数组，不报错。',
  ],
  options: {
    sport: { type: 'string', description: '赛事 id，默认 nba；`--sport list` 看全部', valueName: 'id' },
    limit: { type: 'string', description: '取多少场，默认 10，上限 200', valueName: 'n' },
    date: { type: 'string', description: '只保留这一天（YYYY-MM-DD）', valueName: 'd' },
  },
  maxArgs: 0,
  async run({ values }) {
    const sport = String(values.sport ?? 'nba').trim() || 'nba'
    if (sport === 'list') {
      return {
        ...okResult({ count: SPORTS.length, sports: SPORTS }),
        table: { headers: ['id', '赛事'], rows: SPORTS.map((s) => [s.id, s.label]) },
      }
    }
    const limit = num(values.limit, 10, 1, 200, '--limit')
    const date = values.date ? String(values.date).trim() : ''
    const { anchorId, matches } = await listSchedule(sport)
    let window: typeof matches
    if (date) {
      window = matches.filter((m) => (m.startAt ?? '').startsWith(date))
    } else {
      const idx = anchorId ? matches.findIndex((m) => m.matchId === anchorId) : -1
      if (idx >= 0) {
        window = matches.slice(Math.max(0, idx - limit + 1), idx + 1)
      } else {
        const lastDone = matches.map((m) => m.status).lastIndexOf('COMPLETED')
        window = lastDone >= 0 ? matches.slice(Math.max(0, lastDone - limit + 1), lastDone + 1) : matches
      }
    }
    const picked = window.slice(-limit).reverse()
    return {
      ...okResult({
        sport,
        total: matches.length,
        returned: picked.length,
        truncated: matches.length > picked.length,
        matches: picked,
      }),
      table: {
        headers: ['时间', '比赛', '评分人数', '最高分', '状态'],
        rows: picked.map((m) => [
          m.startAt ?? '-',
          m.teams.join(' vs ') || m.intro,
          m.scoreCountText ?? '-',
          m.topName ? `${m.topName} ${m.topScore ?? '-'}` : '-',
          m.status,
        ]),
      },
    }
  },
}

const score: Command = {
  name: 'hupu score',
  summary: '一场比赛的全部评分（篮球按整场、电竞按单局）',
  usage: 'astra hupu score <matchId|节点编号> [--sport nba] [--type basketball_match] [--refresh] [--top 20]',
  notes: [
    '匿名接口，赛后数据固定，所以默认查库（crawl.hupu_score）；--refresh 重抓。',
    'matchId 从 `astra hupu match` 拿（19 位）时会自动判断父节点类型：篮球是整场，电竞是单局（lol_bo）。',
    '直接给节点编号时用 --type 指定类型（basketball_match / lol_bo），否则按篮球整场处理。',
    '热评取每条评分下的第一条高亮评论（hotText / hotLight）。',
  ],
  options: {
    sport: { type: 'string', description: '定位 matchId 时用哪个赛事，默认 nba', valueName: 'id' },
    type: { type: 'string', description: '直接给节点编号时的父类型，默认 basketball_match', valueName: 't' },
    refresh: { type: 'boolean', description: '忽略缓存，重新抓一次', valueName: '' },
    top: { type: 'string', description: '返回多少个条目，默认 20，上限 100', valueName: 'n' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    const raw = (positionals[0] ?? '').trim()
    const sport = String(values.sport ?? 'nba').trim() || 'nba'
    const top = num(values.top, 20, 1, 100, '--top')
    // 支持 `astra hupu score lol_bo:7932` 这种直接给「类型:编号」的写法
    const colon = raw.indexOf(':')
    const explicitType = colon > 0 ? raw.slice(0, colon).trim() : ''
    const explicitNo = colon > 0 ? raw.slice(colon + 1).trim() : ''
    if (colon > 0 ? !/^\d+$/.test(explicitNo) : !/^\d{3,}$/.test(raw)) {
      throw invalidInput(
        '给 matchId、节点编号或 类型:编号',
        '例：astra hupu score 1537808033030078464 / astra hupu score lol_bo:7932',
      )
    }

    let nodeType = (explicitType || String(values.type ?? 'basketball_match')).trim() || 'basketball_match'
    let nodeNo = explicitNo || raw
    if (!explicitNo && raw.length >= 10) {
      const hit = await locateMatch(raw, sport)
      if (!hit.topItemNo) {
        throw invalidInput('这场比赛还没有评分条目', '评分只对已开赛的比赛有数据，换一场再试')
      }
      const parent = await parentOf(hit.topItemNo, hit.topItemType ?? 'basketball_item')
      nodeType = parent.type
      nodeNo = parent.no
    }
    const cacheKey = `${nodeType}:${nodeNo}`

    const db = await openHupuDb()
    let board: HupuScoreBoard | null = null
    let source = 'live'
    if (!values.refresh) {
      const cached = await readScoreBoard(db, cacheKey)
      if (cached) {
        board = cached.board
        source = 'cache'
      }
    }
    if (!board) {
      board = await fetchScoreBoard(nodeType, nodeNo)
      await saveScoreBoard(db, cacheKey, board)
    }
    const items = board.items.slice(0, top)
    return {
      ...okResult({
        source,
        nodeType,
        nodeNo,
        title: board.title,
        peopleTotal: board.peopleTotal,
        total: board.items.length,
        returned: items.length,
        truncated: board.items.length > items.length,
        items,
      }),
      table: {
        headers: ['球员/选手', '均分', '评分人数', '评论', '热评亮'],
        rows: items.map((i) => [
          i.name,
          i.avg === null ? '-' : i.avg.toFixed(1),
          i.people === null ? '-' : String(i.people),
          i.comments === null ? '-' : String(i.comments),
          i.hotLight === null ? '-' : String(i.hotLight),
        ]),
      },
    }
  },
}

export const hupuCommands: Command[] = [list, post, find, match, score, boards, doctor]

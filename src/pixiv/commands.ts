/**
 * `astra pixiv ...`：Pixiv 的查询与单作品下载。
 *
 * 落盘规范跟媒体库其他部分一致：**只存不可变标识**——
 * `<pixiv.dir>/<userId>/<illustId>_p<N>.<ext>`，不建系列目录、不存标题快照。
 *
 * 这一批只做「查得到 + 单作品下得下来」，画师全量 / 订阅留到后面加，
 * 免得一次铺太开、把上游改动撞得稀碎。
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AstraError, invalidInput } from '../core/errors.ts'
import type { Command } from '../core/command.ts'
import { getConfig } from '../core/config.ts'
import { ensureDir, homePath } from '../core/paths.ts'
import {
  clearCookie,
  cookieDigest,
  downloadImage,
  illustDetail,
  loadCookie,
  pageUrls,
  ranking,
  resolveSearch,
  saveCookie,
  searchHits,
  searchPage,
  illustStats,
  userWorks,
  type RankMode,
} from './api.ts'

const RANK_MODES: RankMode[] = ['daily', 'weekly', 'monthly', 'rookie', 'original', 'male', 'female']

/** 作品分类的本地过滤表。pixiv ajax 的 `type` 参数被忽略，只能按 `illustType` 自己筛。 */
const TYPE_FILTER: Record<string, number[] | null> = {
  all: null,
  illust: [0],
  manga: [1],
  ugoira: [2],
}

const TYPE_LABEL: Record<number, string> = { 0: '插画', 1: '漫画', 2: '动图' }

function num(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw invalidInput(`${label} 必须是 ${min}..${max} 的整数`)
  return n
}

function requireId(raw: string | undefined, label: string): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw invalidInput(`${label} 要是正整数`, 'pixiv 的 id 是纯数字，比如 123456789')
  }
  return n
}

/** 落盘根目录：`--out` > `pixiv.dir` > 报错。没有默认值是有意的。 */
function resolveDir(out: unknown): string {
  if (typeof out === 'string' && out.trim()) return out.trim()
  const configured = getConfig('pixiv.dir').trim()
  if (configured) return configured
  throw new AstraError('NO_OUTPUT_DIR', '没有指定落盘目录', {
    exitCode: 2,
    hint: '`astra config set pixiv.dir /host-root/volume1/图片/pixiv`，或本次用 `--out <目录>`',
  })
}

interface PullOptions {
  dir: string
  r18: boolean
  dry: boolean
  limit?: number
  /** 每个作品最多下多少页；undefined = 全部。日报只要首图时传 1。 */
  pages?: number
  /** original = 原图（几 MB~几十 MB）；regular = 1200px（几百 KB，快 5-10 倍）。 */
  quality?: 'original' | 'regular'
}

interface PullSummary {
  works: number
  pages: number
  downloaded: number
  skipped: number
  failed: number
  r18Skipped: number
  files: string[]
  errors: { file: string; error: string }[]
}

/** 一批作品 id → 落盘。pull / user --pull / sub run 都走这里，行为保持一致。 */
async function pullWorks(ids: number[], opts: PullOptions): Promise<PullSummary> {
  const out: PullSummary = { works: 0, pages: 0, downloaded: 0, skipped: 0, failed: 0, r18Skipped: 0, files: [], errors: [] }
  const seen = new Set<number>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    if (opts.limit !== undefined && out.works >= opts.limit) break
    let detail
    try {
      detail = await illustDetail(id)
    } catch (err) {
      out.failed += 1
      out.errors.push({ file: String(id), error: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (detail.xRestrict > 0 && !opts.r18) {
      out.r18Skipped += 1
      continue
    }
    out.works += 1
    const allPages = pageUrls(detail)
    const pages = opts.pages ? allPages.slice(0, opts.pages) : allPages
    out.pages += pages.length
    const target = join(opts.dir, detail.userId)
    if (!opts.dry) await mkdir(target, { recursive: true })

    for (const page of pages) {
      const file = join(target, `${detail.id}_p${page.page}.${page.ext}`)
      if (existsSync(file) && statSync(file).size > 0) {
        out.skipped += 1
        continue
      }
      if (opts.dry) {
        out.files.push(file)
        continue
      }
      try {
        let buf: Buffer
        if (opts.quality === 'regular') {
          // 直接拿 1200px：原图动辄 4000×6000、十几 MB，日报/预览根本用不上
          buf = await downloadImage(page.regular)
        } else {
          try {
            buf = await downloadImage(page.original)
          } catch {
            buf = await downloadImage(page.regular)
          }
        }
        await writeFile(file, buf)
        out.downloaded += 1
        out.files.push(file)
      } catch (err) {
        out.failed += 1
        out.errors.push({ file, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  return out
}

/** 订阅表：<ASTRA_HOME>/pixiv-subs.json。只存 uid 与已见过的最大作品 id。 */
interface SubEntry {
  userId: number
  userName: string
  lastSeenId: number
  addedAt: string
}

const SUBS_FILE = () => homePath('pixiv-subs.json')

function loadSubs(): SubEntry[] {
  const file = SUBS_FILE()
  if (!existsSync(file)) return []
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .map((e) => e as Partial<SubEntry>)
      .filter((e) => Number.isFinite(e.userId))
      .map((e) => ({
        userId: Number(e.userId),
        userName: String(e.userName ?? ''),
        lastSeenId: Number(e.lastSeenId ?? 0),
        addedAt: String(e.addedAt ?? ''),
      }))
  } catch {
    return []
  }
}

function saveSubs(list: SubEntry[]): void {
  ensureDir(homePath())
  const file = SUBS_FILE()
  writeFileSync(file, JSON.stringify(list, null, 2))
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows 上 chmod 无效
  }
}

const info: Command = {
  name: 'pixiv info',
  summary: '看单个作品详情（作者、页数、尺寸、标签、是否 R-18）',
  usage: 'astra pixiv info <illustId>',
  notes: [
    '只读，不下载。R-18 作品会照实返回 xRestrict=1，但 `pull` 默认跳过。',
    '拿不到详情通常是作品已删除或仅登录可见（需要 `pixiv cookie set`）。',
  ],
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const id = requireId(positionals[0], 'illustId')
    const d = await illustDetail(id)
    return {
      data: {
        illustId: Number(d.id),
        title: d.title,
        userId: Number(d.userId),
        userName: d.userName,
        pages: d.pageCount,
        size: `${d.width}x${d.height}`,
        xRestrict: d.xRestrict,
        r18: d.xRestrict > 0,
        bookmarks: (await illustStats(id)).bookmarkCount,
        tags: d.tags,
        original: d.urls.original,
      },
    }
  },
}

const rank: Command = {
  name: 'pixiv rank',
  summary: '排行榜作品 id 列表（daily / weekly / monthly / rookie …）',
  usage: 'astra pixiv rank [--mode daily] [--pages 1] [--limit 50]',
  notes: ['只返回 id 和作者，要看详情用 `pixiv info <id>`；要下载用 `pixiv pull <id>`。'],
  options: {
    mode: { type: 'string', description: `榜种，默认 daily；可选 ${RANK_MODES.join(' / ')}`, valueName: 'm' },
    pages: { type: 'string', description: '翻几页（每页 50），默认 1', valueName: 'n' },
    limit: { type: 'string', description: '最多返回多少条，默认 50', valueName: 'n' },
  },
  maxArgs: 0,
  async run({ values }) {
    const mode = (typeof values.mode === 'string' ? values.mode : 'daily') as RankMode
    if (!RANK_MODES.includes(mode)) throw invalidInput(`不认识的榜种：${mode}`, `可选 ${RANK_MODES.join(' / ')}`)
    const pages = num(values.pages, 1, 1, 10, '--pages')
    const limit = num(values.limit, 50, 1, 200, '--limit')
    const ids = (await ranking(mode, pages)).slice(0, limit)
    return {
      data: { mode, count: ids.length, illustIds: ids },
      table: { headers: ['#', 'illustId'], rows: ids.map((id, i) => [i + 1, id]) },
    }
  },
}

const user: Command = {
  name: 'pixiv user',
  summary: '看画师作品 id 列表；加 --pull 直接批量下载',
  usage: 'astra pixiv user <userId> [--limit 20] [--pull] [--out 目录] [--quality regular] [--r18] [--dry]',
  notes: [
    '不带 --pull 只列 id（新的在前）；带 --pull 会把这一批全下下来，落盘规则与 `pixiv pull` 一致。',
    '目录优先 `--out`，其次 `pixiv.dir`；R-18 默认跳过。',
    '`--quality regular` 取 1200px（原图一张 4000×6000 实测要 138s，1200px 只要 20s）；批量预览建议开。',
  ],
  options: {
    limit: { type: 'string', description: '最多处理多少个作品，默认 20，--pull 时可放大到 500', valueName: 'n' },
    pull: { type: 'boolean', description: '下载这些作品（不加只列 id）' },
    out: { type: 'string', description: '落盘目录（覆盖 pixiv.dir）', valueName: 'dir' },
    pages: { type: 'string', description: '每个作品最多下几页（只要首图写 1）', valueName: 'n' },
    quality: { type: 'string', description: 'original（默认，原图）/ regular（1200px，快很多）', valueName: 'q' },
    r18: { type: 'boolean', description: '允许下载 R-18 作品（默认跳过）' },
    dry: { type: 'boolean', description: '配合 --pull：只打印会写哪些文件' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    const uid = requireId(positionals[0], 'userId')
    const limit = num(values.limit, 20, 1, 500, '--limit')
    const all = await userWorks(uid)
    const ids = all.slice(0, limit)
    if (values.pull !== true) {
      return {
        data: { userId: uid, total: all.length, count: ids.length, illustIds: ids },
        table: { headers: ['#', 'illustId'], rows: ids.map((id, i) => [i + 1, id]) },
      }
    }
    const dir = resolveDir(values.out)
    const summary = await pullWorks(ids, {
      dir,
      r18: values.r18 === true,
      dry: values.dry === true,
      limit,
      quality: values.quality === 'regular' ? 'regular' : 'original',
      ...(values.pages ? { pages: num(values.pages, 0, 1, 100, '--pages') } : {}),
    })
    return {
      data: { userId: uid, total: all.length, dir, ...summary },
      table: {
        headers: ['项目', '数量'],
        rows: [['作品', summary.works], ['页', summary.pages], ['新下载', summary.downloaded],
               ['已存在', summary.skipped], ['R-18 跳过', summary.r18Skipped], ['失败', summary.failed]],
      },
    }
  },
}

const subAdd: Command = {
  name: 'pixiv sub add',
  summary: '订阅画师：之后 `pixiv sub run` 只拉新作品',
  usage: 'astra pixiv sub add <userId>',
  notes: [
    '订阅表在 <ASTRA_HOME>/pixiv-subs.json（600），只记 userId、画师名、已见过的最大作品 id。',
    '加入时会把当前最新作品 id 记为基线，所以第一次 run 不会把历史作品全下一遍。',
  ],
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const uid = requireId(positionals[0], 'userId')
    const list = loadSubs()
    if (list.some((e) => e.userId === uid)) {
      return { data: { userId: uid, added: false, reason: 'already-subscribed', total: list.length } }
    }
    const ids = await userWorks(uid)
    let userName = ''
    if (ids.length) {
      try {
        userName = (await illustDetail(ids[0]!)).userName
      } catch {
        // 拿不到名字不影响订阅
      }
    }
    list.push({ userId: uid, userName, lastSeenId: ids[0] ?? 0, addedAt: new Date().toISOString() })
    saveSubs(list)
    return {
      data: { userId: uid, userName, added: true, baseline: ids[0] ?? 0, total: list.length },
    }
  },
}

const subRemove: Command = {
  name: 'pixiv sub remove',
  summary: '取消订阅画师',
  usage: 'astra pixiv sub remove <userId>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const uid = requireId(positionals[0], 'userId')
    const list = loadSubs()
    const next = list.filter((e) => e.userId !== uid)
    if (next.length !== list.length) saveSubs(next)
    return { data: { userId: uid, removed: next.length !== list.length, total: next.length } }
  },
}

const subList: Command = {
  name: 'pixiv sub list',
  summary: '看订阅了哪些画师',
  usage: 'astra pixiv sub list',
  maxArgs: 0,
  async run() {
    const list = loadSubs()
    return {
      data: { total: list.length, items: list },
      table: {
        headers: ['userId', '画师', '已见最大作品', '加入时间'],
        rows: list.map((e) => [e.userId, e.userName || '-', e.lastSeenId || '-', e.addedAt.slice(0, 10)]),
      },
    }
  },
}

const subRun: Command = {
  name: 'pixiv sub run',
  summary: '拉取所有订阅画师的新作品（配合定时任务用）',
  usage: 'astra pixiv sub run [--out 目录] [--per-user 10] [--r18] [--dry]',
  notes: [
    '只处理 id 大于「已见最大 id」的作品，所以重复跑不会重复下载。',
    '给 cron 用：没有新作品时返回 newWorks: 0，不产生噪音。',
  ],
  options: {
    out: { type: 'string', description: '落盘目录（覆盖 pixiv.dir）', valueName: 'dir' },
    'per-user': { type: 'string', description: '每个画师最多处理多少个新作品，默认 10', valueName: 'n' },
    r18: { type: 'boolean', description: '允许下载 R-18 作品（默认跳过）' },
    dry: { type: 'boolean', description: '只打印会写哪些文件' },
  },
  maxArgs: 0,
  async run({ values }) {
    const dir = resolveDir(values.out)
    const perUser = num(values['per-user'], 10, 1, 100, '--per-user')
    const list = loadSubs()
    if (!list.length) return { data: { subscribed: 0, newWorks: 0, downloaded: 0, note: '还没有订阅，用 `pixiv sub add <userId>`' } }

    let newWorks = 0
    let downloaded = 0
    let skipped = 0
    let failed = 0
    let r18Skipped = 0
    const perUserReport: { userId: number; userName: string; newWorks: number; downloaded: number }[] = []

    for (const entry of list) {
      let ids: number[] = []
      try {
        ids = await userWorks(entry.userId)
      } catch (err) {
        failed += 1
        perUserReport.push({ userId: entry.userId, userName: entry.userName, newWorks: 0, downloaded: 0 })
        continue
      }
      const fresh = ids.filter((id) => id > entry.lastSeenId).slice(0, perUser)
      if (!fresh.length) {
        perUserReport.push({ userId: entry.userId, userName: entry.userName, newWorks: 0, downloaded: 0 })
        continue
      }
      newWorks += fresh.length
      const summary = await pullWorks(fresh, { dir, r18: values.r18 === true, dry: values.dry === true })
      downloaded += summary.downloaded
      skipped += summary.skipped
      failed += summary.failed
      r18Skipped += summary.r18Skipped
      perUserReport.push({ userId: entry.userId, userName: entry.userName, newWorks: fresh.length, downloaded: summary.downloaded })
      if (!values.dry && ids[0]) entry.lastSeenId = Math.max(entry.lastSeenId, ids[0])
    }
    if (!values.dry) saveSubs(list)

    return {
      data: {
        subscribed: list.length,
        newWorks,
        downloaded,
        skipped,
        r18Skipped,
        failed,
        dir,
        perUser: perUserReport,
      },
    }
  },
}

const search: Command = {
  name: 'pixiv search',
  summary: '按关键词搜作品（按时间倒序；查不到会自动放宽 tag 匹配）',
  usage: 'astra pixiv search <关键词> [--page 1] [--limit 20] [--type all]',
  notes: [
    'pixiv 的 tag 是**全词精确匹配**，角色全名常常查不到：绝区零凯撒的真实 tag 是 `キング・シーザー`，搜 `カエサル・キング` 是 0 条。',
    '所以查不到会自动放宽：精确 tag → 部分 tag → 标题/说明 → 按 ・/空格 拆词逐个查。返回里的 `matchedBy` 告诉你最后用了哪种。',
    '`--type` 是**本地过滤**：pixiv ajax 的 `type` 参数实测被忽略（`type=illust` 和 `type=manga` 返回同一批数据），只能按 `illustType` 自己筛。',
    '`relatedTags` 是 pixiv 给出的真正标签，找别名/同义词看这个字段。',
  ],
  options: {
    page: { type: 'string', description: '页码，默认 1', valueName: 'n' },
    limit: { type: 'string', description: '最多返回多少条，默认 20', valueName: 'n' },
    type: { type: 'string', description: '分类：all / illust / manga / ugoira（本地过滤），默认 all', valueName: 't' },
  },
  minArgs: 1,
  async run({ positionals, values }) {
    const keyword = positionals.join(' ')
    const page = num(values.page, 1, 1, 100, '--page')
    const limit = num(values.limit, 20, 1, 100, '--limit')
    const type = typeof values.type === 'string' ? values.type.trim() : 'all'
    if (!(type in TYPE_FILTER)) throw invalidInput('--type 只能是 all / illust / manga / ugoira')
    const want = TYPE_FILTER[type]

    const res = await resolveSearch(keyword, page)
    // `--type` 是本地过滤，单页可能一条都不剩（凯撒的 manga 就一页 0 条），
    // 所以按需再往后多翻几页，凑够 limit 或翻不动为止。
    const hits = [...res.hits]
    const seen = new Set(hits.map((h) => h.id))
    if (want && hits.filter((h) => want.includes(h.illustType)).length < limit) {
      for (let p = page + 1; p <= page + 4; p += 1) {
        let more
        try {
          more = (await searchPage(res.matchedKeyword, p, res.sMode)).hits
        } catch {
          break
        }
        if (!more.length) break
        for (const h of more) {
          if (seen.has(h.id)) continue
          seen.add(h.id)
          hits.push(h)
        }
        if (hits.filter((h) => want.includes(h.illustType)).length >= limit) break
      }
    }
    const picked = (want ? hits.filter((h) => want.includes(h.illustType)) : hits).slice(0, limit)
    return {
      data: {
        keyword,
        page,
        type,
        matchedKeyword: res.matchedKeyword,
        matchedBy: res.matchedBy,
        cookieStale: res.cookieStale,
        total: res.total,
        relatedTags: res.relatedTags,
        count: picked.length,
        illustIds: picked.map((h) => h.id),
      },
      table: {
        headers: ['#', 'illustId', '类型'],
        rows: picked.map((h, i) => [i + 1, h.id, TYPE_LABEL[h.illustType] ?? String(h.illustType)]),
      },
    }
  },
}

const top: Command = {
  name: 'pixiv top',
  summary: '按收藏数排序看某个关键词的热门作品（Pixiv 的「人気順」要会员，这里是本地排序）',
  usage: 'astra pixiv top <关键词> [--pages 3] [--limit 20] [--r18]',
  notes: [
    'Pixiv 搜索的 `order=popular_d`（人気順）是会员功能，非会员调用会被静默忽略、返回的仍是新着順。',
    '所以这里走「先拉最近 N 页新作 → 再逐个取 bookmarkCount → 本地倒序」，不需要会员。',
    '代价：`--pages` 越大请求越多（每页 60 个作品、每个一次详情）。默认 3 页 = 180 个，约 20-40 秒。',
    '只覆盖最近的作品——老作品收藏再高也不会出现在结果里，这是和新着順共用同一个候选池的必然结果。',
  ],
  options: {
    pages: { type: 'string', description: '拉最近几页（每页 60），默认 3；要全量就写 lastPage 的数（几十页）', valueName: 'n' },
    also: { type: 'string', description: '额外关键词，逗号分隔，合并进同一个候选池再排序（如 "あめちゃん,ニディガ"）', valueName: 'kw' },
    limit: { type: 'string', description: '返回条数，默认 20', valueName: 'n' },
    type: { type: 'string', description: '分类：all / illust / manga / ugoira（本地过滤），默认 all', valueName: 't' },
    r18: { type: 'boolean', description: '包含 R-18 作品（默认过滤掉）' },
  },
  minArgs: 1,
  async run({ positionals, values }) {
    const keyword = positionals.join(' ')
    const pages = num(values.pages, 3, 1, 200, '--pages')
    const limit = num(values.limit, 20, 1, 100, '--limit')

    const keywords = [keyword, ...(typeof values.also === 'string'
      ? values.also.split(',').map((k) => k.trim()).filter(Boolean)
      : [])]
    const type = typeof values.type === 'string' ? values.type.trim() : 'all'
    if (!(type in TYPE_FILTER)) throw invalidInput('--type 只能是 all / illust / manga / ugoira')
    const want = TYPE_FILTER[type]

    const hits: Awaited<ReturnType<typeof searchHits>> = []
    const seen = new Set<number>()
    const matched: { keyword: string; matchedKeyword: string; matchedBy: string }[] = []
    const relatedTags: string[] = []
    let cookieStale = false
    for (const kw of keywords) {
      // 第一页先按回退顺序解析出真正有结果的关键词，后面几页沿用同一组（词, 匹配模式），
      // 免得翻到第 3 页又换回精确 tag 直接断流。
      let first
      try {
        first = await resolveSearch(kw, 1)
      } catch {
        continue
      }
      matched.push({ keyword: kw, matchedKeyword: first.matchedKeyword, matchedBy: first.matchedBy })
      if (first.cookieStale) cookieStale = true
      for (const t of first.relatedTags) if (!relatedTags.includes(t)) relatedTags.push(t)
      let batch = first.hits
      for (let page = 1; page <= pages; page += 1) {
        if (page > 1) {
          try {
            batch = (await searchPage(first.matchedKeyword, page, first.sMode)).hits
          } catch {
            break
          }
        }
        if (!batch.length) break
        for (const hit of batch) {
          if (seen.has(hit.id)) continue
          seen.add(hit.id)
          hits.push(hit)
        }
      }
    }
    const typed = want ? hits.filter((h) => want.includes(h.illustType)) : hits
    const pool = values.r18 === true ? typed : typed.filter((h) => h.xRestrict === 0)

    // 分批并发取收藏数，避免一次打 180 个请求被限流
    const stats = new Map<number, number>()
    const batch = 24
    for (let i = 0; i < pool.length; i += batch) {
      const chunk = pool.slice(i, i + batch)
      const results = await Promise.all(chunk.map(async (h) => {
        try {
          return await illustStats(h.id)
        } catch {
          return { id: h.id, bookmarkCount: -1, likeCount: 0, viewCount: 0 }
        }
      }))
      for (const r of results) stats.set(r.id, r.bookmarkCount)
    }

    const ranked = pool
      .map((h) => ({ ...h, bookmarks: stats.get(h.id) ?? -1 }))
      .sort((a, b) => b.bookmarks - a.bookmarks)
      .slice(0, limit)

    return {
      data: {
        keyword,
        keywords,
        type,
        matched,
        relatedTags,
        cookieStale,
        scanned: pool.length,
        pages,
        count: ranked.length,
        items: ranked.map((r) => ({
          illustId: r.id,
          title: r.title,
          userName: r.userName,
          userId: r.userId,
          pages: r.pageCount,
          bookmarks: r.bookmarks,
          url: `https://www.pixiv.net/artworks/${r.id}`,
        })),
      },
      table: {
        headers: ['illustId', '收藏', '页', '作品名', '作者'],
        rows: ranked.map((r) => [r.id, r.bookmarks, r.pageCount, r.title.slice(0, 34), r.userName.slice(0, 14)]),
      },
    }
  },
}

const pull: Command = {
  name: 'pixiv pull',
  summary: '下载单个作品的全部页（原图优先，失败回落 1200px）',
  usage: 'astra pixiv pull <illustId> [--out 目录] [--pages N] [--r18] [--dry]',
  notes: [
    '落盘 `<目录>/<userId>/<illustId>_p<N>.<ext>`，已存在的文件跳过（只认 id + 页号）。',
    'R-18 作品默认跳过，要下得显式加 `--r18`。',
    '目录优先 `--out`，其次 `pixiv.dir`；两者都没配会直接报错，不会瞎写到一个默认路径。',
  ],
  options: {
    out: { type: 'string', description: '落盘目录（覆盖 pixiv.dir）', valueName: 'dir' },
    pages: { type: 'string', description: '每个作品最多下几页（多页作品只想要首图就写 1）', valueName: 'n' },
    quality: { type: 'string', description: 'original（默认，原图）/ regular（1200px，快很多）', valueName: 'q' },
    r18: { type: 'boolean', description: '允许下载 R-18 作品（默认跳过）' },
    dry: { type: 'boolean', description: '只打印会写哪些文件，不真下' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    const id = requireId(positionals[0], 'illustId')
    const dir = resolveDir(values.out)
    const pages = values.pages ? num(values.pages, 0, 1, 100, '--pages') : undefined
    const detail = await illustDetail(id)
    if (detail.xRestrict > 0 && values.r18 !== true) {
      throw new AstraError('R18_BLOCKED', '这是 R-18 作品，默认不下载', {
        exitCode: 4,
        hint: '确实要下就加 `--r18`',
        details: { illustId: id, xRestrict: detail.xRestrict },
      })
    }
    const quality = values.quality === 'regular' ? 'regular' as const : 'original' as const
    const summary = await pullWorks([id], {
      dir,
      r18: values.r18 === true,
      dry: values.dry === true,
      quality,
      ...(pages ? { pages } : {}),
    })
    return {
      data: {
        illustId: id,
        title: detail.title,
        userId: Number(detail.userId),
        pages: summary.pages,
        downloaded: summary.downloaded,
        skipped: summary.skipped,
        failed: summary.failed,
        files: summary.files,
        ...(summary.errors.length ? { errors: summary.errors } : {}),
      },
    }
  },
}

const cookieSet: Command = {
  name: 'pixiv cookie set',
  summary: '保存浏览器 cookie（可选，用于看登录可见的作品）',
  usage: 'astra pixiv cookie set "<cookie 字符串>"',
  notes: [
    '匿名就能查公开作品，cookie 只在需要看受限内容时才要。',
    '存在 <ASTRA_HOME>/pixiv-cookie.txt，权限 600；只回显有没有 PHPSESSID，不回显值。',
  ],
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const raw = positionals[0]!.trim()
    if (!raw.includes('=')) throw invalidInput('这不像 cookie 字符串', '从浏览器 DevTools 复制整行 `k=v; k2=v2`')
    saveCookie(raw)
    return { data: { saved: true, ...cookieDigest(raw) } }
  },
}

const cookieCheck: Command = {
  name: 'pixiv cookie check',
  summary: '验证存的 cookie 还能不能用（过期会让 pixiv 静默返回空结果）',
  usage: 'astra pixiv cookie check',
  notes: [
    'pixiv 对失效的 PHPSESSID **不报错**，而是返回 HTTP 200 + 空结果，看起来就像「这个词查不到」。',
    '这条命令用一个固定关键词分别带 cookie / 不带 cookie 各搜一次，带 cookie 0 条而不带有条 → cookie 过期。',
  ],
  maxArgs: 0,
  async run() {
    const raw = loadCookie()
    if (!raw) return { data: { configured: false, valid: null, hint: '没存 cookie，匿名可用' } }
    const probe = 'オリジナル'
    // pixiv 突发后会返回 HTTP 200 + 空结果，和「cookie 失效」表现一样，
    // 所以判定「失效」必须复测一次，别被限流骗了（实测踩过）。
    const probeOnce = async (): Promise<'valid' | 'stale' | 'unknown'> => {
      const withCookie = await searchPage(probe, 1, 's_tag_full', false)
      if (withCookie.hits.length) return 'valid'
      const anonymous = await searchPage(probe, 1, 's_tag_full', true)
      return anonymous.hits.length ? 'stale' : 'unknown'
    }
    let verdict = await probeOnce()
    if (verdict === 'stale') {
      await new Promise((r) => setTimeout(r, 3000))
      verdict = await probeOnce()
    }
    return {
      data: {
        configured: true,
        valid: verdict === 'valid' ? true : verdict === 'stale' ? false : null,
        probed: probe,
        hint:
          verdict === 'valid'
            ? 'cookie 可用'
            : verdict === 'stale'
              ? 'cookie 已失效，建议 `pixiv cookie clear` 或重新 set'
              : '带 cookie 和匿名都搜不到，可能是限流或代理问题，不能断定 cookie 失效',
      },
    }
  },
}

const cookieShow: Command = {
  name: 'pixiv cookie show',
  summary: '看 cookie 状态（不回显值）',
  usage: 'astra pixiv cookie show',
  maxArgs: 0,
  async run() {
    const raw = loadCookie()
    return { data: { configured: Boolean(raw), ...cookieDigest(raw) } }
  },
}

const cookieClear: Command = {
  name: 'pixiv cookie clear',
  summary: '删掉保存的 cookie',
  usage: 'astra pixiv cookie clear',
  maxArgs: 0,
  async run() {
    return { data: { removed: clearCookie() } }
  },
}

export const pixivCommands: Command[] = [
  info, rank, top, user, search, pull,
  subAdd, subRemove, subList, subRun,
  cookieSet, cookieShow, cookieCheck, cookieClear,
]

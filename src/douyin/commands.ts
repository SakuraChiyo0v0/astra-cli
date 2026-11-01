/**
 * `astra douyin ...`
 *
 * 视频与图文都走同一个详情接口；下载直链是 CDN 直连（带 Referer 即可，不需要 cookie）。
 * 只有「收藏 / 收藏夹」需要登录态，登录方式是把浏览器 cookie 粘进 stdin。
 */
import { mkdirSync } from 'node:fs'
import { AstraError, invalidInput } from '../core/errors.ts'
import type { Command, CommandResult } from '../core/command.ts'
import { okResult } from '../core/output.ts'
import { checkWritable } from '../core/doctor.ts'
import { fetchAwemeDetail, fetchCollects, fetchFavorites, fetchHotSearch, fetchRelated, mintTtwid, resolveAwemeId, whoAmI, type RawAweme } from './api.ts'
import { clearSession, loadSession, parseCookieInput, saveSession, sessionPath } from './auth.ts'
import { normalizeAweme, pickGear, summarizeGears, type DouyinItem, type Quality } from './model.ts'
import { downloadItem } from './download.ts'
import { douyinRoot } from './paths.ts'

const QUALITIES: Quality[] = ['best', '1080p', '720p', '540p', 'small']

function qualityOf(value: unknown): Quality {
  if (value === undefined) return 'best'
  if (typeof value !== 'string' || !QUALITIES.includes(value as Quality)) {
    throw invalidInput(`--quality 只能是 ${QUALITIES.join(' / ')}`)
  }
  return value as Quality
}

function limitOf(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > max) throw invalidInput(`--limit 只能是 1..${max} 的整数`)
  return n
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw invalidInput('没有从 stdin 拿到内容', '`astra douyin login < cookie.txt`，或把 Copy as cURL 的整段粘进管道')
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function itemSummary(item: DouyinItem) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    author: item.author,
    authorId: item.authorId,
    durationSec: item.durationSec,
    cover: item.cover,
    images: item.images.length,
    qualities: item.gears.length,
    music: item.music?.title ?? null,
    stats: item.stats,
  }
}

const get: Command = {
  name: 'douyin get',
  summary: '下载抖音作品：视频、图文都行，链接 / 短链 / 19 位 id 都可以',
  usage: 'astra douyin get <链接|ID>... [--out <目录>] [--quality best|1080p|720p|540p|small] [--force] [--dry]',
  notes: [
    '视频默认挑 h264 最高档（**h265 档没有音轨**，只有 h264 才能直接得到有声文件）',
    '图文按原图下（不要 `download_url_list`，那是带水印的），顺序编号 01.jpg 起',
    '落盘目录：`--out` > `douyin.dir`；文件名是「作品 id + 标题」，同一 id 已存在就跳过',
    '`--dry` 只解析不下载，用来确认链接对不对',
  ],
  options: {
    out: { type: 'string', description: '落盘目录（覆盖 douyin.dir）', valueName: 'dir' },
    quality: { type: 'string', description: '画质上限，默认 best', valueName: 'q' },
    force: { type: 'boolean', description: '已存在也重下' },
    dry: { type: 'boolean', description: '只解析、不下载' },
  },
  minArgs: 1,
  maxArgs: 20,
  async run({ positionals, values, signal }): Promise<CommandResult> {
    const quality = qualityOf(values.quality)
    const root = douyinRoot(typeof values.out === 'string' ? values.out : undefined)
    const results: Record<string, unknown>[] = []
    const warnings: string[] = []

    for (const input of positionals) {
      const awemeId = await resolveAwemeId(input, signal)
      const raw = await fetchAwemeDetail(awemeId, { cookie: loadSession()?.cookie ?? null, signal })
      const item = normalizeAweme(raw)
      if (values.dry === true) {
        results.push({
          status: 'resolved',
          ...itemSummary(item),
          picked: item.kind === 'video' ? pickGear(item.gears, quality)?.name ?? null : null,
        })
        continue
      }
      const outcome = await downloadItem(item, {
        root,
        quality,
        force: values.force === true,
        signal,
      })
      warnings.push(...outcome.warnings)
      results.push({
        status: outcome.status,
        ...itemSummary(item),
        path: 'path' in outcome ? outcome.path : undefined,
        dir: 'dir' in outcome ? outcome.dir : undefined,
        bytes: outcome.bytes,
        gear: 'gear' in outcome ? outcome.gear : undefined,
        audio: 'audio' in outcome ? outcome.audio : undefined,
      })
    }

    const downloaded = results.filter((r) => r.status === 'downloaded').length
    return {
      ...okResult({ root, requested: positionals.length, downloaded, results }, warnings),
      table: {
        headers: ['状态', 'id', '标题', '类型', '大小'],
        rows: results.map((r) => [
          String(r.status ?? ''),
          String(r.id ?? ''),
          String(r.title ?? '').slice(0, 32),
          String(r.kind ?? ''),
          r.bytes ? `${(Number(r.bytes) / 1048576).toFixed(1)}MB` : '-',
        ]),
      },
    }
  },
}

const info: Command = {
  name: 'douyin info',
  summary: '只看元数据和可选档位，不下载',
  usage: 'astra douyin info <链接|ID>',
  notes: [
    '`gears[].audio` 为 false 表示这一档没有音轨（h265），下载时会跳过',
    '`aweme_detail` 为空且带 `filter_detail` = 作品被删或不可见，重试没用',
  ],
  options: {},
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, signal }) {
    const awemeId = await resolveAwemeId(positionals[0]!, signal)
    const raw = await fetchAwemeDetail(awemeId, { cookie: loadSession()?.cookie ?? null, signal })
    const item = normalizeAweme(raw)
    return okResult({
      ...itemSummary(item),
      gears: summarizeGears(item.gears),
      picked: item.kind === 'video' ? pickGear(item.gears, 'best')?.name ?? null : null,
    })
  },
}

const hot: Command = {
  name: 'douyin hot',
  summary: '抖音热榜（免登录、免签名）',
  usage: 'astra douyin hot [--limit 20]',
  notes: ['只有「此刻」的快照，没有历史；要历史得自己按天存'],
  options: { limit: { type: 'string', description: '条数 1..50，默认 20', valueName: 'n' } },
  minArgs: 0,
  maxArgs: 0,
  async run({ values, signal }) {
    const limit = limitOf(values.limit, 20, 50)
    const words = (await fetchHotSearch({ signal })).slice(0, limit)
    return {
      ...okResult({ count: words.length, words }),
      table: {
        headers: ['#', '热词', '热度'],
        rows: words.map((w, i) => [i + 1, w.word, w.hotValue ?? '-']),
      },
    }
  },
}

const related: Command = {
  name: 'douyin related',
  summary: '给一条作品找相似推荐（免签名，不需要登录）',
  usage: 'astra douyin related <链接|ID> [--limit 10]',
  notes: ['推荐流会掺进无关内容，按需自己筛；要精确的元数据用 `douyin info`'],
  options: { limit: { type: 'string', description: '条数 1..20，默认 10', valueName: 'n' } },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const limit = limitOf(values.limit, 10, 20)
    const awemeId = await resolveAwemeId(positionals[0]!, signal)
    const list = (await fetchRelated(awemeId, { signal })).slice(0, limit)
    const items = list.map((raw: RawAweme) => {
      const item = normalizeAweme(raw)
      return {
        id: item.id,
        kind: item.kind,
        title: item.title,
        author: item.author,
        durationSec: item.durationSec,
        likes: item.stats.digg_count ?? null,
      }
    })
    return {
      ...okResult({ seed: awemeId, count: items.length, items }),
      table: {
        headers: ['id', '作者', '标题', '赞'],
        rows: items.map((i) => [i.id, i.author.slice(0, 12), i.title.slice(0, 36), i.likes ?? '-']),
      },
    }
  },
}

const fav: Command = {
  name: 'douyin fav',
  summary: '看（并可下载）你自己「收藏」的作品，需要先登录',
  usage: 'astra douyin fav [--limit 20] [--keyword <词>] [--download] [--quality q] [--out <目录>] [--cursor <n>]',
  notes: [
    '不带 `--download` 只列清单（id / 标题 / 作者 / 点赞）',
    '`--keyword` 在标题与作者里做大小写不敏感的子串过滤，只筛当前取到的这一批',
    '`--download` 会把筛出来的逐条下载，落盘规则和 `douyin get` 一样',
    '抖音这个接口每页约 20 条，`--limit` 超过 20 会自动翻页',
  ],
  options: {
    limit: { type: 'string', description: '条数 1..100，默认 20', valueName: 'n' },
    cursor: { type: 'string', description: '起始游标（分页续取）', valueName: 'n' },
    keyword: { type: 'string', description: '只保留标题/作者含该词的', valueName: 'text' },
    download: { type: 'boolean', description: '顺手下载筛出来的作品' },
    quality: { type: 'string', description: '下载画质上限，默认 best', valueName: 'q' },
    out: { type: 'string', description: '下载目录（覆盖 douyin.dir）', valueName: 'dir' },
  },
  minArgs: 0,
  maxArgs: 0,
  async run({ values, signal }): Promise<CommandResult> {
    const session = loadSession()
    if (!session) {
      throw new AstraError('DOUYIN_NOT_LOGGED_IN', '还没登录', {
        exitCode: 3,
        hint: '`astra douyin login < cookie.txt`（浏览器里 Copy as cURL 的整段）',
      })
    }
    const limit = limitOf(values.limit, 20, 100)
    const quality = qualityOf(values.quality)
    const keyword = typeof values.keyword === 'string' ? values.keyword.toLowerCase() : null
    let cursor: string = typeof values.cursor === 'string' ? values.cursor : '0'

    const collected: RawAweme[] = []
    while (collected.length < limit) {
      const page = await fetchFavorites(cursor, Math.min(20, limit - collected.length), { cookie: session.cookie, signal })
      collected.push(...page.items)
      if (!page.hasMore || !page.maxCursor || page.maxCursor === cursor) break
      cursor = page.maxCursor
    }

    const items = collected.slice(0, limit).map(normalizeAweme)
    const filtered = keyword
      ? items.filter((i) => i.title.toLowerCase().includes(keyword) || i.author.toLowerCase().includes(keyword))
      : items

    const results: Record<string, unknown>[] = []
    const warnings: string[] = []
    if (values.download === true) {
      const root = douyinRoot(typeof values.out === 'string' ? values.out : undefined)
      mkdirSync(root, { recursive: true })
      for (const item of filtered) {
        const outcome = await downloadItem(item, { root, quality, force: false, signal })
        warnings.push(...outcome.warnings)
        results.push({
          id: item.id,
          title: item.title,
          status: outcome.status,
          path: 'path' in outcome ? outcome.path : undefined,
          dir: 'dir' in outcome ? outcome.dir : undefined,
          bytes: outcome.bytes,
        })
      }
    }

    return {
      ...okResult({
        fetched: items.length,
        matched: filtered.length,
        nextCursor: cursor,
        items: filtered.map((i) => ({
          id: i.id,
          kind: i.kind,
          title: i.title,
          author: i.author,
          durationSec: i.durationSec,
          likes: i.stats.digg_count ?? null,
        })),
        ...(values.download === true ? { downloads: results } : {}),
      }, warnings),
      table: {
        headers: ['id', '类型', '作者', '标题', '赞'],
        rows: filtered.map((i) => [i.id, i.kind, i.author.slice(0, 12), i.title.slice(0, 36), i.stats.digg_count ?? '-']),
      },
    }
  },
}

const login: Command = {
  name: 'douyin login',
  summary: '导入浏览器 cookie（扫码登录已不可用，只能粘 cookie）',
  usage: 'astra douyin login < cookie.txt   ｜   astra douyin login \'<cookie 串>\'',
  notes: [
    '浏览器打开 www.douyin.com 并登录 → F12 → Network → 任一请求 → 右键 Copy as cURL (bash) → 整段喂进来',
    '`document.cookie` 拿不到 httpOnly 的 sessionid，所以必须用 Copy as cURL',
    '优先从 stdin 读：cookie 出现在 argv 里会被 `ps` 和 shell 历史看见',
    '成功后写 `<ASTRA_HOME>/douyin-session.json`（600）',
  ],
  options: {},
  minArgs: 0,
  maxArgs: 1,
  async run({ positionals, signal }) {
    const raw = positionals[0] ?? (await readStdin())
    const cookie = parseCookieInput(raw)
    const me = await whoAmI(cookie, signal)
    if (!me.loggedIn) {
      throw new AstraError('DOUYIN_LOGIN_FAILED', `cookie 无效（status_code=${me.statusCode ?? '?'}）`, {
        exitCode: 3,
        hint: '确认浏览器里是登录状态，并且拷的是 www.douyin.com 的请求；重新 Copy as cURL 一次',
      })
    }
    const file = saveSession(cookie, { nickname: me.nickname, uid: me.uid })
    return okResult({ loggedIn: true, nickname: me.nickname, uid: me.uid, savedTo: file })
  },
}

const whoami: Command = {
  name: 'douyin whoami',
  summary: '看当前登录的是谁（顺带验证 cookie 还有没有效）',
  usage: 'astra douyin whoami',
  notes: ['没登录会明确说 not_logged_in；cookie 过期会标出 status_code'],
  options: {},
  minArgs: 0,
  maxArgs: 0,
  async run({ signal }) {
    const session = loadSession()
    if (!session) return okResult({ loggedIn: false, savedAt: null, file: sessionPath() })
    const me = await whoAmI(session.cookie, signal)
    return okResult({
      loggedIn: me.loggedIn,
      nickname: me.nickname ?? session.nickname,
      uid: me.uid ?? session.uid,
      savedAt: session.savedAt,
      statusCode: me.statusCode,
      file: sessionPath(),
    })
  },
}

const logout: Command = {
  name: 'douyin logout',
  summary: '删除本地保存的抖音 cookie',
  usage: 'astra douyin logout',
  notes: ['只删本地文件，不影响手机/浏览器里的登录状态'],
  options: {},
  minArgs: 0,
  maxArgs: 0,
  async run() {
    return okResult({ removed: clearSession(), file: sessionPath() })
  },
}

const doctor: Command = {
  name: 'douyin doctor',
  summary: '自检：ttwid、签名、热榜、登录态、目录写权限',
  usage: 'astra douyin doctor',
  notes: [
    '四项里任何一项失败都会单独报出来，不会因为一项挂了就说全坏',
    '`signature` 失败通常是 SALT 变了（SDK 升级），需要重抓 `runtime_bundler_34.js`',
  ],
  options: {},
  minArgs: 0,
  maxArgs: 0,
  async run({ signal }) {
    const checks: Record<string, { ok: boolean; detail: string }> = {}

    try {
      const ttwid = await mintTtwid()
      checks.ttwid = { ok: ttwid.length > 40, detail: `ttwid 长度 ${ttwid.length}` }
    } catch (err) {
      checks.ttwid = { ok: false, detail: (err as Error).message }
    }

    try {
      const words = await fetchHotSearch({ signal })
      checks.hotsearch = { ok: words.length > 0, detail: `${words.length} 条热词` }
    } catch (err) {
      checks.hotsearch = { ok: false, detail: (err as Error).message }
    }

    const session = loadSession()
    if (session) {
      try {
        const me = await whoAmI(session.cookie, signal)
        checks.login = { ok: me.loggedIn, detail: me.loggedIn ? `已登录：${me.nickname ?? me.uid ?? '?'}` : `未登录 status=${me.statusCode ?? '?'}` }
        if (me.loggedIn) {
          try {
            const cols = await fetchCollects({ cookie: session.cookie, signal })
            checks.collects = { ok: true, detail: `${cols.length} 个收藏夹` }
          } catch (err) {
            checks.collects = { ok: false, detail: (err as Error).message }
          }
        }
      } catch (err) {
        checks.login = { ok: false, detail: (err as Error).message }
      }
    } else {
      checks.login = { ok: true, detail: '未登录（收藏类命令不可用，下载视频/图文不需要登录）' }
    }

    try {
      const root = douyinRoot()
      const writable = checkWritable(root)
      checks.dir = { ok: writable.ok, detail: writable.detail }
    } catch (err) {
      checks.dir = { ok: false, detail: (err as Error).message }
    }

    const ok = Object.values(checks).every((c) => c.ok)
    return {
      ...okResult({ ok, checks, sessionFile: sessionPath() }),
      table: {
        headers: ['检查', '结果', '说明'],
        rows: Object.entries(checks).map(([k, v]) => [k, v.ok ? 'ok' : 'FAIL', v.detail]),
      },
    }
  },
}

export const douyinCommands: Command[] = [get, info, hot, related, fav, login, whoami, logout, doctor]

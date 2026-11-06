/**
 * `astra x ...` —— 把 X 当数据源读：时间线、搜索、单条、首页、书签、媒体落库。
 *
 * 不是聊天渠道（那是 Hermes 的 platform 适配器）。登录用一个会话 cookie，
 * 存 `<ASTRA_HOME>/x.json`（600）。写接口（发推/点赞/转发）**一律不做**。
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { AstraError, invalidInput } from '../core/errors.ts'
import type { Command } from '../core/command.ts'
import { okResult } from '../core/output.ts'
import { homePath } from '../core/paths.ts'
import {
  buildSearchUrl,
  galleryJson,
  installTools,
  listMeta,
  missingTools,
  parseGalleryEntries,
  proxyUrl,
  toItem,
  toolsDir,
  twitter,
  type SearchQuery,
  type XItem,
} from './api.ts'
import { clearCredential, credPath, loadCredential, maskSecret, parseXCookie, saveCredential, type XCredential } from './auth.ts'
import { downloadMedia, resolveTarget, xRoot } from './media.ts'

const MAX_ITEMS = 200

function credOrThrow(): XCredential {
  const cred = loadCredential()
  if (!cred) {
    throw new AstraError('X_NOT_LOGGED_IN', '还没有 X 登录态', {
      exitCode: 3,
      hint: '浏览器导出 cookies.txt 后：`astra x login --cookie-file <文件>`（也支持 stdin 管道）',
    })
  }
  return cred
}

function num(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw invalidInput(`${name} 必须是 ${min}..${max} 的整数`, `收到：${String(value)}`)
  }
  return n
}

function brakePath(): string {
  return homePath('x-stop')
}

/** 刹车：所有抓取命令先过这一关（用户喊停时不想逐条解释）。 */
function assertNotPaused(): void {
  if (existsSync(brakePath())) {
    throw new AstraError('X_PAUSED', 'X 抓取已暂停', {
      exitCode: 1,
      hint: '恢复：`astra x resume`',
    })
  }
}

function oneLine(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat
}

function tableOf(items: XItem[]): { headers: string[]; rows: (string | number | null)[][] } {
  return {
    headers: ['时间', '账号', '内容', '赞', '转', '回', '看', '媒体'],
    rows: items.map((i) => [
      i.createdAt.slice(0, 16),
      i.author ? `@${i.author}` : '-',
      oneLine(i.text),
      i.metrics.likes,
      i.metrics.retweets,
      i.metrics.replies,
      i.metrics.views,
      i.media.length || null,
    ]),
  }
}

function itemsOf(raw: unknown, limit: number): XItem[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && 'items' in raw ? (raw as { items: unknown[] }).items : []
  return list.map(toItem).filter((i): i is XItem => i !== null).slice(0, limit)
}

function listResult(items: XItem[], limit: number, extra: Record<string, unknown> = {}) {
  return {
    ...okResult({ ...extra, ...listMeta(items.length, limit), items }),
    table: tableOf(items),
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

// ---------- 命令 ----------
const status: Command = {
  name: 'x status',
  summary: 'X 登录态 + 账号信息（探活）',
  usage: 'astra x status',
  notes: [
    '未登录也返回 ok=true，`data.authenticated=false`；要报错的那种判断用 `astra x doctor`。',
    'cookie 只在 data.credential 里给脱敏值。',
  ],
  maxArgs: 0,
  async run() {
    const cred = loadCredential()
    const base = {
      toolsDir: toolsDir(),
      proxy: proxyUrl(),
      cookieSaved: cred ? cred.savedAt : null,
      credential: cred ? { authToken: maskSecret(cred.authToken), ct0: maskSecret(cred.ct0) } : null,
    }
    if (!cred) {
      return { data: { ...base, authenticated: false, account: null, hint: 'astra x login --cookie-file <cookies.txt>' } }
    }
    const data = twitter(['status', '--json'], cred) as { authenticated?: boolean; user?: Record<string, unknown> } | null
    const user = data?.user ?? null
    return {
      data: {
        ...base,
        authenticated: Boolean(data?.authenticated),
        account: user
          ? {
            id: user.id ?? null,
            screenName: user.screenName ?? user.username ?? null,
            name: user.name ?? null,
            followers: user.followers ?? null,
            tweets: user.tweets ?? null,
          }
          : null,
      },
    }
  },
}

const login: Command = {
  name: 'x login',
  summary: '导入 X 登录 cookie（cookies.txt 或 k=v 串）',
  usage: 'astra x login [--cookie-file <文件>] [--cookie "<auth_token=…; ct0=…>"]',
  notes: [
    '浏览器登录 x.com → F12 → Application → Cookies → https://x.com，导出 Netscape 格式 cookies.txt 最省事。',
    '也可以 `astra x login < cookies.txt`；cookie 存 <ASTRA_HOME>/x.json（600），输出只回显脱敏值。',
    'cookie 等价账号全权，别贴到群聊里；换了设备或改密码后要重新导一次。',
  ],
  options: {
    'cookie-file': { type: 'string', description: 'Netscape 格式 cookies.txt 路径', valueName: 'file' },
    cookie: { type: 'string', description: '直接给 `auth_token=…; ct0=…`', valueName: 'text' },
  },
  maxArgs: 0,
  async run({ values }) {
    let raw = ''
    if (typeof values.cookie === 'string') raw = values.cookie
    if (typeof values['cookie-file'] === 'string') {
      const file = values['cookie-file']
      if (!existsSync(file)) throw invalidInput(`文件不存在：${file}`)
      raw = (await import('node:fs')).readFileSync(file, 'utf8')
    }
    if (!raw) raw = await readStdin()
    if (!raw.trim()) {
      throw invalidInput('没有拿到 cookie', '`astra x login --cookie-file <cookies.txt>`，或 `astra x login < cookies.txt`')
    }
    const parsed = parseXCookie(raw)
    let screenName: string | undefined
    let authenticated = false
    try {
      const probe = twitter(['status', '--json'], { authToken: parsed.authToken, ct0: parsed.ct0, savedAt: '' }) as {
        authenticated?: boolean
        user?: { screenName?: string }
      } | null
      authenticated = Boolean(probe?.authenticated)
      screenName = probe?.user?.screenName
    } catch {
      // 网络/风控失败不拦住保存：cookie 可能只是要等一会儿才生效
    }
    const cred = saveCredential(raw, screenName)
    return {
      data: {
        saved: true,
        path: credPath(),
        authToken: maskSecret(cred.authToken),
        ct0: maskSecret(cred.ct0),
        authenticated,
        screenName: screenName ?? null,
      },
      warnings: authenticated ? [] : ['cookie 已保存，但本次探活没通过；稍后跑 `astra x status` 复核'],
    }
  },
}

const logout: Command = {
  name: 'x logout',
  summary: '删除本地保存的 X 登录态',
  usage: 'astra x logout',
  maxArgs: 0,
  async run() {
    const cleared = clearCredential()
    rmSync(homePath('x-cookies.txt'), { force: true })
    return { data: { cleared } }
  },
}

const user: Command = {
  name: 'x user',
  summary: '查某个账号的资料',
  usage: 'astra x user <账号>',
  notes: ['账号不带 @。关注数/推文数来自 X 的实时返回。'],
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const handle = positionals[0]!.replace(/^@/, '')
    const raw = twitter(['user', handle, '--json'], credOrThrow()) as Record<string, unknown> | null
    if (!raw) throw new AstraError('X_NOT_FOUND', `查不到账号 ${handle}`, { exitCode: 4 })
    const data = {
      id: raw.id ?? null,
      screenName: raw.screenName ?? handle,
      name: raw.name ?? null,
      bio: raw.bio ?? '',
      followers: raw.followers ?? null,
      following: raw.following ?? null,
      tweets: raw.tweets ?? null,
      likes: raw.likes ?? null,
      verified: Boolean(raw.verified),
      url: raw.screenName ? `https://x.com/${String(raw.screenName)}` : null,
    }
    return {
      data,
      table: {
        headers: ['账号', '昵称', '关注者', '推文', '认证'],
        rows: [[
          `@${String(data.screenName ?? '')}`,
          data.name === null ? '-' : String(data.name),
          data.followers === null ? '-' : Number(data.followers),
          data.tweets === null ? '-' : Number(data.tweets),
          data.verified ? '是' : '否',
        ]],
      },
    }
  },
}

const posts: Command = {
  name: 'x posts',
  summary: '某个账号的时间线（最新的 n 条）',
  usage: 'astra x posts <账号> [--limit 20]',
  notes: [
    '返回正文、作者、赞/转/回/看、媒体 URL 与推文链接；`returned >= limit` 说明可能还有更多。',
    '转推会在 isRetweet=true，正文是原推内容。',
  ],
  options: { limit: { type: 'string', short: 'n', description: `取多少条，默认 20，上限 ${MAX_ITEMS}`, valueName: 'n' } },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    assertNotPaused()
    const limit = num(values.limit, 20, 1, MAX_ITEMS, '--limit')
    const handle = positionals[0]!.replace(/^@/, '')
    const raw = twitter(['user-posts', handle, '-n', String(limit), '--json'], credOrThrow())
    return listResult(itemsOf(raw, limit), limit, { handle })
  },
}

const tweet: Command = {
  name: 'x tweet',
  summary: '单条推文 + 回复',
  usage: 'astra x tweet <推文ID|链接> [--limit 20]',
  notes: ['`--limit` 是回复条数；主推始终在第一条。链接里的数字 ID 也能直接用。'],
  options: { limit: { type: 'string', short: 'n', description: '回复取多少条，默认 20', valueName: 'n' } },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    assertNotPaused()
    const limit = num(values.limit, 20, 1, MAX_ITEMS, '--limit')
    const target = positionals[0]!
    const id = /status\/(\d+)/.exec(target)?.[1] ?? (/^\d+$/.test(target) ? target : null)
    if (!id) throw invalidInput(`不是推文 ID 或链接：${target}`)
    const raw = twitter(['tweet', id, '-n', String(limit), '--json'], credOrThrow())
    return listResult(itemsOf(raw, limit), limit, { tweetId: id })
  },
}

const feed: Command = {
  name: 'x feed',
  summary: '首页时间线（推荐 / 关注）',
  usage: 'astra x feed [--type following] [--limit 20]',
  notes: ['默认 following（按时间）；`--type for-you` 是算法推荐流。'],
  options: {
    type: { type: 'string', description: 'following（默认）或 for-you', valueName: 'name' },
    limit: { type: 'string', short: 'n', description: '取多少条，默认 20', valueName: 'n' },
  },
  maxArgs: 0,
  async run({ values }) {
    assertNotPaused()
    const limit = num(values.limit, 20, 1, MAX_ITEMS, '--limit')
    const type = typeof values.type === 'string' ? values.type : 'following'
    if (!['following', 'for-you'].includes(type)) throw invalidInput('--type 只能是 following / for-you')
    const raw = twitter(['feed', '-t', type, '-n', String(limit), '--json'], credOrThrow())
    return listResult(itemsOf(raw, limit), limit, { type })
  },
}

const bookmarks: Command = {
  name: 'x bookmarks',
  summary: '我的书签',
  usage: 'astra x bookmarks [--limit 20]',
  options: { limit: { type: 'string', short: 'n', description: '取多少条，默认 20', valueName: 'n' } },
  maxArgs: 0,
  async run({ values }) {
    assertNotPaused()
    const limit = num(values.limit, 20, 1, MAX_ITEMS, '--limit')
    const raw = twitter(['bookmarks', '-n', String(limit), '--json'], credOrThrow())
    return listResult(itemsOf(raw, limit), limit)
  },
}

const search: Command = {
  name: 'x search',
  summary: '搜索推文（关键词 + X 高级搜索过滤器）',
  usage: 'astra x search [关键词] [--limit 20] [--type latest] [--from 账号] [--since 2026-01-01]'
    + ' [--until 2026-02-01] [--min-likes 100] [--has images] [--exclude replies]',
  notes: [
    '不要指望翻到很久以前：X 搜索自己只给一个窗口，超出就是没有。',
    '`--has` 可选 links / images / videos / media；`--exclude` 可选 retweets / replies / links，都可重复给。',
    '返回的 createdAt 是 UTC（形如 2026-11-06 03:54:00），比北京时间少 8 小时。',
    '搜索走的是 gallery-dl 的搜索接口（twitter-cli 的 search 在 0.8.5 已 404），纯文字推也在结果里。',
  ],
  options: {
    limit: { type: 'string', short: 'n', description: '返回多少条推文，默认 20，上限 200', valueName: 'n' },
    type: { type: 'string', description: 'top / latest（默认）/ photos / videos', valueName: 'name' },
    from: { type: 'string', description: '只搜某个账号的推', valueName: '账号' },
    since: { type: 'string', description: '起始日期 YYYY-MM-DD', valueName: 'date' },
    until: { type: 'string', description: '截止日期 YYYY-MM-DD', valueName: 'date' },
    'min-likes': { type: 'string', description: '最少点赞数', valueName: 'n' },
    has: { type: 'string', multiple: true, description: '要求含 links/images/videos/media，可重复', valueName: 'kind' },
    exclude: { type: 'string', multiple: true, description: '排除 retweets/replies/links，可重复', valueName: 'kind' },
  },
  maxArgs: 1,
  async run({ positionals, values }) {
    assertNotPaused()
    const limit = num(values.limit, 20, 1, MAX_ITEMS, '--limit')
    const type = typeof values.type === 'string' ? values.type : 'latest'
    if (!['top', 'latest', 'photos', 'videos'].includes(type)) throw invalidInput('--type 只能是 top / latest / photos / videos')
    const minLikes = values['min-likes'] === undefined ? undefined : num(values['min-likes'], 0, 0, 10_000_000, '--min-likes')
    const has = values.has === undefined ? [] : Array.isArray(values.has) ? values.has : [String(values.has)]
    const exclude = values.exclude === undefined ? [] : Array.isArray(values.exclude) ? values.exclude : [String(values.exclude)]
    const query: SearchQuery = {
      ...(positionals[0] ? { q: positionals[0] } : {}),
      type: type as SearchQuery['type'],
      ...(typeof values.from === 'string' ? { from: values.from } : {}),
      ...(typeof values.since === 'string' ? { since: values.since } : {}),
      ...(typeof values.until === 'string' ? { until: values.until } : {}),
      ...(minLikes === undefined ? {} : { minLikes }),
      ...(has.length > 0 ? { has } : {}),
      ...(exclude.length > 0 ? { exclude } : {}),
    }
    if (!query.q && !query.from) throw invalidInput('至少给一个关键词或 --from 账号')
    const url = buildSearchUrl(query)
    // 一个推文带 4 张图会占 5 条 gallery 条目，所以多抓一点再截断
    const entries = galleryJson(url, Math.min(limit * 3, 600), credOrThrow())
    const items = parseGalleryEntries(entries).slice(0, limit)
    return listResult(items, limit, { query: url })
  },
}

const media: Command = {
  name: 'x media',
  summary: '把推文里的图/视频原文件下到 NAS',
  usage: 'astra x media <账号|推文链接|搜索链接> [--limit 50] [--out <目录>]',
  notes: [
    '账号=该号最近媒体；推文链接=那一条；搜索链接=搜索结果里的媒体。',
    '默认落 `<素材根>/twitter/<账号>/<推文id>_<序号>.<ext>`，`--out` 换根目录，配置 `x.dir` 改默认。',
    '重跑不重复下载（gallery-dl archive 记账）；`--limit` 是文件数上限，不是推文数。',
  ],
  options: {
    limit: { type: 'string', description: '最多下多少个文件，默认 50', valueName: 'n' },
    out: { type: 'string', description: '本次落盘根目录（绝对路径）', valueName: 'dir' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    assertNotPaused()
    const limit = num(values.limit, 50, 1, 2000, '--limit')
    const out = typeof values.out === 'string' ? values.out : undefined
    const target = resolveTarget(positionals[0]!)
    const result = downloadMedia(target, limit, credOrThrow(), out)
    return {
      data: {
        ...result,
        downloadedCount: result.downloaded.length,
        root: xRoot(out),
      },
      table: {
        headers: ['目录', '新下', '跳过', '合计'],
        rows: [[result.dir, result.downloaded.length, result.skipped, result.total]],
      },
    }
  },
}

const pause: Command = {
  name: 'x pause',
  summary: '暂停所有 X 抓取（写刹车文件）',
  usage: 'astra x pause',
  maxArgs: 0,
  async run() {
    writeFileSync(brakePath(), new Date().toISOString())
    return { data: { paused: true, path: brakePath() } }
  },
}

const resume: Command = {
  name: 'x resume',
  summary: '恢复 X 抓取',
  usage: 'astra x resume',
  maxArgs: 0,
  async run() {
    const existed = existsSync(brakePath())
    rmSync(brakePath(), { force: true })
    return { data: { resumed: true, wasPaused: existed } }
  },
}

const doctor: Command = {
  name: 'x doctor',
  summary: '自检：工具/代理/登录态/目录，可一键补装',
  usage: 'astra x doctor [--install]',
  notes: [
    '工具装在 `venvs/x`（`x.bin` 可改）；容器重建后跑 `astra x doctor --install` 一句话补回来。',
    '代理取 `proxy.url`，留空时回落 http://mihomo:7890（X 在本机必须走代理）。',
  ],
  options: { install: { type: 'boolean', description: '缺工具时自动建 venv 并装 twitter-cli / gallery-dl' } },
  maxArgs: 0,
  async run({ values }) {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = []
    if (values.install === true) {
      const result = installTools()
      checks.push({ name: 'install', ok: result.installed, detail: result.output || '已是最新' })
    }
    const missing = missingTools()
    checks.push({
      name: 'tools',
      ok: missing.length === 0,
      detail: missing.length === 0 ? toolsDir() : `缺少 ${missing.map((m) => m.split('/').pop()).join(' / ')}`,
    })

    const cred = loadCredential()
    checks.push({
      name: 'credential',
      ok: Boolean(cred),
      detail: cred ? `保存于 ${cred.savedAt}，auth_token=${maskSecret(cred.authToken)}` : '没有登录态，跑 `astra x login`',
    })

    const curl = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', '-x', proxyUrl(), 'https://x.com/'], { encoding: 'utf8' })
    const code = (curl.stdout ?? '').trim()
    checks.push({
      name: 'proxy',
      ok: code === '200',
      detail: curl.error ? `curl 不可用：${curl.error.message}` : `${proxyUrl()} → HTTP ${code || '无响应'}`,
    })

    if (cred) {
      try {
        const st = twitter(['status', '--json'], cred) as { authenticated?: boolean; user?: { screenName?: string } } | null
        checks.push({
          name: 'session',
          ok: Boolean(st?.authenticated),
          detail: st?.authenticated ? `已登录 @${st.user?.screenName ?? '?'}` : 'cookie 已失效',
        })
      } catch (err) {
        checks.push({ name: 'session', ok: false, detail: err instanceof Error ? err.message : String(err) })
      }
    }

    try {
      const root = xRoot()
      checks.push({ name: 'mediaDir', ok: true, detail: root })
    } catch (err) {
      checks.push({ name: 'mediaDir', ok: false, detail: err instanceof Error ? err.message : String(err) })
    }

    const healthy = checks.every((c) => c.ok)
    return {
      data: { healthy, checks },
      ...(healthy ? {} : { warnings: checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`) }),
      table: {
        headers: ['检查', '结果', '说明'],
        rows: checks.map((c) => [c.name, c.ok ? 'OK' : 'FAIL', c.detail]),
      },
    }
  },
}

export const xCommands: Command[] = [status, login, logout, user, posts, tweet, feed, bookmarks, search, media, pause, resume, doctor]

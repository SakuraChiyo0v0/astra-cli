/**
 * X 抓取的执行层：不自己说 GraphQL，改为 spawn 两个跟得上 X 前端的工具。
 *
 *  - `twitter-cli`（`venvs/x/bin/twitter`）：时间线、单条+回复、首页、书签、用户资料；
 *  - `gallery-dl`（`venvs/x/bin/gallery-dl`）：关键词搜索与图片/视频下载。
 *
 * 为什么这么分工：twitter-cli 0.8.5 的 `search` 对 X 一律 404（queryId 跟慢了），
 * 而 gallery-dl 的搜索接口还在维护。**不要**把 GraphQL 客户端搬进 astra ——
 * queryId / feature flags / x-client-transaction-id 是纯维护负担，上游跟得比自己紧。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { getConfig } from '../core/config.ts'
import { AstraError } from '../core/errors.ts'
import { cookieTxtPath, writeCookieFile, type XCredential } from './auth.ts'

/** 本机默认装在这里；`x.bin` 配置或 `ASTRA_X_BIN` 可改。 */
const DEFAULT_TOOLS_DIR = '/opt/data/venvs/x/bin'
export const DEFAULT_PROXY = 'http://mihomo:7890'

export function toolsDir(): string {
  const fromEnv = process.env.ASTRA_X_BIN?.trim()
  if (fromEnv) return fromEnv
  const configured = getConfig('x.bin')?.trim()
  return configured || DEFAULT_TOOLS_DIR
}

export function twitterBin(): string {
  return path.join(toolsDir(), 'twitter')
}

export function galleryBin(): string {
  return path.join(toolsDir(), 'gallery-dl')
}

export function proxyUrl(): string {
  return process.env.ASTRA_X_PROXY?.trim() || getConfig('proxy.url')?.trim() || DEFAULT_PROXY
}

/** 工具在不在；`x doctor` 与所有命令的前置检查共用。 */
export function missingTools(): string[] {
  return [twitterBin(), galleryBin()].filter((p) => !existsSync(p))
}

export function envFor(cred: XCredential): NodeJS.ProcessEnv {
  const proxy = proxyUrl()
  return {
    ...process.env,
    TWITTER_AUTH_TOKEN: cred.authToken,
    TWITTER_CT0: cred.ct0,
    TWITTER_PROXY: proxy,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
  }
}

interface RunResult {
  stdout: string
  stderr: string
}

function run(bin: string, args: string[], cred: XCredential | null, timeoutMs = 120_000): RunResult {
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: cred ? envFor(cred) : { ...process.env, HTTPS_PROXY: proxyUrl(), HTTP_PROXY: proxyUrl() },
  })
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new AstraError('X_TOOLS_MISSING', `找不到 ${path.basename(bin)}`, {
        exitCode: 3,
        hint: `先 \`astra x doctor --install\` 装到 ${toolsDir()}，或 \`astra config set x.bin <目录>\` 指到已有位置`,
      })
    }
    throw new AstraError('X_TOOL_FAILED', `${path.basename(bin)} 执行失败：${res.error.message}`, { exitCode: 5 })
  }
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function parseJson(raw: string, label: string): unknown {
  const text = raw.trim()
  if (!text) {
    throw new AstraError('X_EMPTY', `${label} 没有返回内容`, { exitCode: 5, retryable: true, hint: '多半是登录态失效或代理不通' })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new AstraError('X_BAD_JSON', `${label} 返回的不是 JSON`, { exitCode: 5, details: text.slice(0, 500) })
  }
}

/** 调 twitter-cli，返回 `data` 里的东西（它把结果包在 `{ok, data}` 里）。 */
export function twitter(args: string[], cred: XCredential, timeoutMs?: number): unknown {
  const { stdout, stderr } = run(twitterBin(), args, cred, timeoutMs)
  let parsed: unknown
  try {
    parsed = parseJson(stdout, `twitter ${args[0]}`)
  } catch (err) {
    // 有些子命令失败时 JSON 打在 stdout、诊断在 stderr，这里把 stderr 尾部带上更好定位
    if (err instanceof AstraError && stderr.trim()) {
      throw new AstraError(err.code, err.message, {
        exitCode: err.exitCode,
        retryable: err.retryable,
        ...(err.hint === null ? {} : { hint: err.hint }),
        details: { stdout: String(err.details ?? ''), stderr: stderr.trim().slice(-400) },
      })
    }
    throw err
  }
  if (parsed && typeof parsed === 'object' && 'ok' in parsed && (parsed as { ok?: boolean }).ok === false) {
    const error = (parsed as { error?: { message?: string; code?: string } }).error
    throw new AstraError('X_UPSTREAM', error?.message?.trim() || 'twitter-cli 返回失败', {
      exitCode: 5,
      retryable: true,
      hint: '先跑 `astra x status`；未登录就 `astra x login --cookie-file <cookies.txt>`',
    })
  }
  return parsed && typeof parsed === 'object' && 'data' in parsed ? (parsed as { data: unknown }).data : parsed
}

/**
 * 把超长整数转成字符串再解析。
 *
 * 推文 id 已经到 19 位（2.1e18），超过 JS 的安全整数上限（2^53 ≈ 9.007e15），
 * `JSON.parse` 会把尾数抹平——实测 `2118552452572348566` 变成 `…700`，
 * 结果就是「拿到的链接点开是别人的推」。gallery-dl 是 Python，输出里的数字是准的，
 * 所以在解析前先把 16 位以上的整数加上引号。
 */
export function quoteBigInts(text: string): string {
  return text.replace(/:\s*(\d{16,})(?=\s*[,}\]])/g, ': "$1"')
}

/** 调 gallery-dl 拿元数据（`-j`），返回原始条目数组。 */
export function galleryJson(url: string, limit: number, cred: XCredential): unknown[] {
  if (!existsSync(cookieTxtPath())) writeCookieFile(cred)
  const { stdout, stderr } = run(galleryBin(), [
    '-C', cookieTxtPath(),
    '--proxy', proxyUrl(),
    '-j',
    '--range', `1-${limit}`,
    '--retries', '3',
    url,
  ], cred, 180_000)
  const text = stdout.trim()
  if (!text) {
    // gallery-dl 没结果时退出码 1、stdout 为空；这不是故障
    if (/sso|login|auth|cookie/i.test(stderr)) {
      throw new AstraError('X_UNAUTHORIZED', 'gallery-dl 认为没有有效登录态', {
        exitCode: 3,
        hint: '重新导出 cookies.txt 再 `astra x login --cookie-file <file>`',
      })
    }
    return []
  }
  const parsed = parseJson(quoteBigInts(text), 'gallery-dl')
  return Array.isArray(parsed) ? parsed : []
}

// ---------- 环境自举 ----------
/**
 * 装/补那两个 Python 工具。
 *
 * 放在 astra 里而不是文档里，是因为「容器重建后 venv 没了」是必然会发生的：
 * 让 `astra x doctor --install` 一句修好，比让用户照着 README 手敲三条命令靠谱。
 */
export function installTools(): { venv: string; python: string; installed: boolean; output: string } {
  const bin = toolsDir()
  const venv = process.env.ASTRA_X_VENV?.trim() || path.dirname(bin)
  const python = process.env.ASTRA_X_PYTHON?.trim() || 'python3'
  const steps: string[] = []
  if (!existsSync(venv)) {
    const made = spawnSync(python, ['-m', 'venv', venv], { encoding: 'utf8', timeout: 180_000 })
    if (made.error || made.status !== 0) {
      throw new AstraError('X_INSTALL_FAILED', `创建 venv 失败：${(made.stderr ?? made.error?.message ?? '').trim()}`, {
        exitCode: 3,
        hint: `确认 ${python} 可用；也可以手工 \`python3 -m venv ${venv}\``,
      })
    }
    steps.push(`venv: ${venv}`)
  }
  const pip = path.join(venv, 'bin', 'pip')
  const install = spawnSync(pip, ['install', '-q', '--upgrade', 'twitter-cli', 'gallery-dl'], {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (install.error || install.status !== 0) {
    throw new AstraError('X_INSTALL_FAILED', `pip install 失败：${(install.stderr ?? install.error?.message ?? '').trim().slice(-400)}`, {
      exitCode: 5,
      hint: 'pypi 不通就先配代理；已经装过可以只跑 `astra x doctor` 看缺哪个',
    })
  }
  steps.push('pip install twitter-cli gallery-dl')
  return { venv, python, installed: missingTools().length === 0, output: steps.join('\n') }
}

// ---------- 纯函数：命令层与测试共用 ----------
export interface XMedia {
  type: string
  url: string
}

export interface XItem {
  id: string
  url: string
  text: string
  author: string
  authorName: string
  createdAt: string
  metrics: { likes: number; retweets: number; replies: number; quotes: number; views: number }
  media: XMedia[]
  lang: string
  isRetweet: boolean
}

function numOf(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** twitter-cli 的条目 → 统一形状；字段缺失一律给默认值，不抛。 */
export function toItem(raw: unknown): XItem | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  const id = String(t.id ?? '')
  const text = String(t.text ?? t.full_text ?? '')
  if (!id || !text) return null
  const author = (t.author ?? {}) as Record<string, unknown>
  const metrics = (t.metrics ?? {}) as Record<string, unknown>
  const media = Array.isArray(t.media) ? t.media : []
  return {
    id,
    url: `https://x.com/i/status/${id}`,
    text,
    author: String(author.screenName ?? author.screen_name ?? ''),
    authorName: String(author.name ?? ''),
    createdAt: String(t.createdAtLocal ?? t.createdAt ?? ''),
    metrics: {
      likes: numOf(metrics.likes),
      retweets: numOf(metrics.retweets),
      replies: numOf(metrics.replies),
      quotes: numOf(metrics.quotes),
      views: numOf(metrics.views),
    },
    media: media
      .map((m) => {
        const item = (m ?? {}) as Record<string, unknown>
        return { type: String(item.type ?? 'photo'), url: String(item.url ?? '') }
      })
      .filter((m) => m.url),
    lang: String(t.lang ?? ''),
    isRetweet: Boolean(t.isRetweet),
  }
}

export interface SearchQuery {
  q?: string
  type?: 'top' | 'latest' | 'photos' | 'videos'
  from?: string
  since?: string
  until?: string
  minLikes?: number
  has?: string[]
  exclude?: string[]
}

const F_MAP: Record<string, string> = { top: 'top', latest: 'live', photos: 'media', videos: 'videos' }

/** 拼 X 的搜索 URL（高级搜索语法原样塞进 `q`）。空查询只靠过滤器时也成立。 */
export function buildSearchUrl(input: SearchQuery): string {
  const parts: string[] = []
  if (input.q?.trim()) parts.push(input.q.trim())
  if (input.from?.trim()) parts.push(`from:${input.from.trim().replace(/^@/, '')}`)
  if (input.since?.trim()) parts.push(`since:${input.since.trim()}`)
  if (input.until?.trim()) parts.push(`until:${input.until.trim()}`)
  if (input.minLikes !== undefined) parts.push(`min_faves:${input.minLikes}`)
  for (const h of input.has ?? []) parts.push(`filter:${h}`)
  for (const e of input.exclude ?? []) parts.push(`-filter:${e}`)
  const f = F_MAP[input.type ?? 'latest'] ?? 'live'
  return `https://x.com/search?q=${encodeURIComponent(parts.join(' '))}&f=${f}`
}

/** gallery-dl 的图片能要原图：`?format=jpg&name=orig`。视频 URL 不动。 */
export function originalImageUrl(url: string): string {
  if (!url.includes('pbs.twimg.com')) return url
  const base = url.split('?')[0] ?? url
  const format = /\.(jpg|jpeg|png|webp)$/i.exec(base)?.[1]?.toLowerCase()
  if (format) return `${base}?format=${format === 'jpeg' ? 'jpg' : format}&name=orig`
  return url
}

/**
 * gallery-dl `-j` 的条目 → 统一形状。
 *
 * 每条是 `[序号, 元数据]`（推文）或 `[序号, url, 元数据]`（媒体文件）。
 * 媒体靠元数据里的 `tweet_id` 归到推文上；没有再退回「上一条推文」。
 */
export function parseGalleryEntries(entries: unknown[]): XItem[] {
  const order: string[] = []
  const tweets = new Map<string, XItem>()
  let lastId = ''
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue
    let meta: Record<string, unknown> | null = null
    const urls: string[] = []
    for (const part of entry) {
      if (typeof part === 'string') {
        if (/^https?:/.test(part)) urls.push(part)
      } else if (part && typeof part === 'object') {
        meta = part as Record<string, unknown>
      }
    }
    if (!meta) continue
    const tid = String(meta.tweet_id ?? meta.id ?? '')
    if (!tid) continue
    const isTweet = meta.content !== undefined
    if (isTweet && !tweets.has(tid)) {
      const user = (meta.user ?? meta.author ?? {}) as Record<string, unknown>
      const item: XItem = {
        id: tid,
        url: `https://x.com/i/status/${tid}`,
        text: String(meta.content ?? ''),
        author: String(user.name ?? ''),
        authorName: String(user.nick ?? user.name ?? ''),
        createdAt: String(meta.date ?? ''),
        metrics: {
          likes: numOf(meta.favorite_count),
          retweets: numOf(meta.retweet_count),
          replies: numOf(meta.reply_count),
          quotes: numOf(meta.quote_count),
          views: numOf(meta.view_count),
        },
        media: [],
        lang: String(meta.lang ?? ''),
        isRetweet: false,
      }
      tweets.set(tid, item)
      order.push(tid)
      lastId = tid
    }
    if (urls.length > 0) {
      const target = tid || lastId
      const item = tweets.get(target)
      if (item) {
        for (const url of urls) {
          const type = url.includes('video.twimg.com') || /\.mp4$/i.test(url) ? 'video' : 'photo'
          const normalized = type === 'photo' ? originalImageUrl(url) : url
          if (!item.media.some((m) => m.url === normalized)) item.media.push({ type, url: normalized })
        }
      }
    }
  }
  return order.map((id) => tweets.get(id)!).filter(Boolean)
}

/** 列表类统一的「口径」字段：上游不给总数，用 returned >= limit 推断是否还有更多。 */
export function listMeta(returned: number, limit: number): { returned: number; limit: number; truncated: boolean } {
  return { returned, limit, truncated: returned >= limit }
}

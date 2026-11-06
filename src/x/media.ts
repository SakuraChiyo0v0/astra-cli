/**
 * X 媒体落盘。
 *
 * 命名口径沿用 astra 的规矩：**只留不可变标识**——`<推文id>_<第几张>.<扩展名>`，
 * 不加日期、不加点赞数这类会过期/会变的东西。目录按账号平铺，最多一层。
 *
 * 去重靠 gallery-dl 的 archive（sqlite），不靠「文件是否存在」——同一张图换了尺寸不会重下。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { getConfig } from '../core/config.ts'
import { AstraError } from '../core/errors.ts'
import { homePath } from '../core/paths.ts'
import { galleryBin, proxyUrl, envFor } from './api.ts'
import { cookieTxtPath, writeCookieFile, type XCredential } from './auth.ts'

/** 媒体根：`--out` > `ASTRA_X_DIR` > 配置 `x.dir` > NAS 素材目录（不存在时回落 ASTRA_HOME）。 */
export function xRoot(override?: string): string {
  const explicit = override?.trim() || process.env.ASTRA_X_DIR?.trim() || getConfig('x.dir')?.trim()
  if (explicit) {
    mkdirSync(explicit, { recursive: true })
    return path.resolve(explicit)
  }
  const nas = '/host-root/volume1/素材/twitter'
  if (existsSync('/host-root/volume1')) {
    mkdirSync(nas, { recursive: true })
    return nas
  }
  const local = homePath('x-media')
  mkdirSync(local, { recursive: true })
  return local
}

/** 文件名安全化（账号名只允许 ASCII 可见字符）。 */
export function safeName(raw: string): string {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || 'x'
}

export interface MediaTarget {
  url: string
  dirName: string
}

/** 把用户给的目标翻译成 gallery-dl 能吃的 URL + 目录名。 */
export function resolveTarget(target: string): MediaTarget {
  const t = target.trim()
  if (!t) throw new AstraError('INVALID_INPUT', '缺少目标', { exitCode: 2, hint: '例如 `astra x media ArknightsStaff`' })
  if (/^https?:\/\//.test(t)) {
    if (t.includes('/search')) return { url: t, dirName: 'search' }
    const status = /\/status\/(\d+)/.exec(t)
    if (status) return { url: t, dirName: `tweet_${status[1]}` }
    const handle = /x\.com\/([A-Za-z0-9_]+)/.exec(t)?.[1]
    return { url: t, dirName: safeName(handle ?? 'x') }
  }
  // 裸数字当推文 id（用户从别处复制 id 是最常见的输入）
  if (/^\d+$/.test(t)) return { url: `https://x.com/i/status/${t}`, dirName: `tweet_${t}` }
  const handle = t.replace(/^@/, '')
  if (handle.includes('/')) {
    const [head] = handle.split('/')
    return { url: `https://x.com/${handle}`, dirName: safeName(head ?? 'x') }
  }
  return { url: `https://x.com/${handle}/media`, dirName: safeName(handle) }
}

export interface MediaResult {
  dir: string
  downloaded: string[]
  skipped: number
  total: number
}

/**
 * 下载。`--range 1-N` 按条目计数（一张图算一条），所以 N 是「文件数上限」不是「推文数上限」。
 */
export function downloadMedia(target: MediaTarget, limit: number, cred: XCredential, out?: string): MediaResult {
  const root = xRoot(out)
  const dir = path.join(root, target.dirName)
  mkdirSync(dir, { recursive: true })
  if (!existsSync(cookieTxtPath())) writeCookieFile(cred)
  const before = new Set(readdirSync(dir))
  const res = spawnSync(galleryBin(), [
    '-C', cookieTxtPath(),
    '--proxy', proxyUrl(),
    '--download-archive', path.join(root, '.archive.sqlite3'),
    '--filename', '{tweet_id}_{num}.{extension}',
    '--range', `1-${limit}`,
    '--sleep-request', '2.5',
    '--sleep', '1.0',
    '--retries', '3',
    '-D', dir,
    target.url,
  ], { encoding: 'utf8', timeout: 900_000, maxBuffer: 32 * 1024 * 1024, env: envFor(cred) })

  // 退出码 1 在 gallery-dl 里表示「没有新内容」，不是失败
  if (res.error) {
    throw new AstraError('X_MEDIA_FAILED', `gallery-dl 执行失败：${res.error.message}`, { exitCode: 5 })
  }
  const downloaded = readdirSync(dir).filter((name) => !before.has(name))
  const skipped = (res.stdout ?? '').split('\n').filter((l) => l.startsWith('#')).length
  if (downloaded.length === 0 && (res.status ?? 1) !== 0 && !skipped) {
    const tail = (res.stderr ?? '').trim().split('\n').slice(-3).join(' / ')
    throw new AstraError('X_MEDIA_FAILED', tail || 'gallery-dl 没下到东西', {
      exitCode: 5,
      retryable: true,
      hint: '先 `astra x status` 确认登录态；媒体接口有时要重新登录一次',
    })
  }
  return {
    dir,
    downloaded: downloaded.sort(),
    skipped,
    total: downloaded.length + skipped,
  }
}

/** 目录里已有多少文件（报告用）。 */
export function countFiles(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isFile()).length
  } catch {
    return 0
  }
}

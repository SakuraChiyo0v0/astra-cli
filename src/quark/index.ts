/**
 * 夸克网盘本地索引：把整棵目录树缓存到 `<ASTRA_HOME>/quark-index.json`。
 *
 * 为什么要缓存：`du` / `find` / `dup` 都要遍历全盘，实测 ~1500 个文件要几十次分页请求，
 * 每次都现扫会让命令等半分钟。索引一次、24 小时内复用；写操作前仍要按 fid 重新校验。
 *
 * 夸克的 `file/sort` 分页：`_page` 从 1 开始、`_size` 最大 100，响应带 `total`。
 * 列表里的 `md5` 字段**恒为 null**（实测），所以去重不能指望它。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homePath } from '../core/paths.ts'
import { httpRequest } from '../core/http.ts'
import { AstraError } from '../core/errors.ts'
import { loadQuarkCookie } from './auth.ts'

const BASE = 'https://drive-pc.quark.cn/1/clouddrive'
const REFERER = 'https://pan.quark.cn/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export interface DriveEntry {
  fid: string
  name: string
  dir: boolean
  size: number
  /** 相对根目录的路径，如 `来自：分享/foo/bar.zip` */
  path: string
  /** 顶层目录名；根目录下的文件为空串 */
  top: string
  updatedAt: number
  category: number
}

export interface DriveIndex {
  builtAt: string
  rootFid: string
  entries: DriveEntry[]
}

function indexFile(): string {
  return homePath('quark-index.json')
}

export function loadIndex(maxAgeHours = 24): DriveIndex | null {
  try {
    if (!existsSync(indexFile())) return null
    const parsed = JSON.parse(readFileSync(indexFile(), 'utf8')) as DriveIndex
    if (!Array.isArray(parsed.entries)) return null
    if (maxAgeHours > 0) {
      const ageHours = (Date.now() - Date.parse(parsed.builtAt)) / 3_600_000
      if (!Number.isFinite(ageHours) || ageHours > maxAgeHours) return null
    }
    return parsed
  } catch {
    return null
  }
}

export function saveIndex(index: DriveIndex): void {
  writeFileSync(indexFile(), JSON.stringify(index) + '\n', { encoding: 'utf8', mode: 0o600 })
}

interface SortItem {
  fid?: string
  file_name?: string
  dir?: number
  size?: number
  updated_at?: number
  category?: number
}

async function listFolder(fid: string, signal?: AbortSignal): Promise<SortItem[]> {
  const out: SortItem[] = []
  for (let page = 1; page <= 200; page += 1) {
    const params = new URLSearchParams({
      pr: 'ucpro',
      fr: 'pc',
      pdir_fid: fid,
      _page: String(page),
      _size: '100',
      _fetch_total: '1',
      _sort: 'file_type:asc,updated_at:desc',
    })
    const response = await httpRequest(`${BASE}/file/sort?${params}`, {
      headers: { 'user-agent': UA, referer: REFERER, cookie: loadQuarkCookie() ?? '' },
      timeoutMs: 20_000,
      retries: 2,
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) {
      throw new AstraError('QUARK_HTTP', `列目录失败 HTTP ${response.status}`, { exitCode: 5 })
    }
    const body = (await response.json()) as {
      code?: number
      message?: string
      data?: { list?: SortItem[]; total?: number }
    }
    if ((body.code ?? 0) !== 0) {
      throw new AstraError('QUARK_API_ERROR', `列目录失败（code=${body.code}）：${body.message ?? ''}`, { exitCode: 5 })
    }
    const items = body.data?.list ?? []
    const before = out.length
    out.push(...items)
    const total = Number(body.data?.total ?? 0)
    // 防止 total 缺失时死循环：本页没有带来新条目就停
    if (items.length < 100 || (total && out.length >= total) || out.length === before) break
    // 轻微限速，避免大批量遍历触发风控
    await new Promise((r) => setTimeout(r, 120))
  }
  return out
}

/**
 * 遍历整个网盘，构建索引。只读，不改任何东西。
 *
 * 并发 4 个目录同时列：实测大目录（860 文件、几十层子目录）串行要 3 分钟以上，
 * 4 路并发能压到 1 分钟内；并发太高会被夸克限流，所以固定小池子。
 */
export async function buildIndex(options: {
  signal?: AbortSignal
  onProgress?: (scanned: number, folders: number) => void
  concurrency?: number
} = {}): Promise<DriveIndex> {
  const entries: DriveEntry[] = []
  const queue: Array<{ fid: string; path: string; top: string }> = [{ fid: '0', path: '', top: '' }]
  let folders = 0
  const concurrency = Math.max(1, Math.min(6, options.concurrency ?? 4))

  const worker = async (): Promise<void> => {
    for (;;) {
      const current = queue.shift()
      if (!current) return
      if (options.signal?.aborted) return
      const items = await listFolder(current.fid, options.signal)
      folders += 1
      for (const item of items) {
        if (!item.fid || !item.file_name) continue
        const path = current.path ? `${current.path}/${item.file_name}` : item.file_name
        const isDir = Number(item.dir ?? 0) === 1
        const top = current.top || (isDir ? item.file_name : '')
        entries.push({
          fid: item.fid,
          name: item.file_name,
          dir: isDir,
          size: Number(item.size ?? 0),
          path,
          top,
          updatedAt: Number(item.updated_at ?? 0),
          category: Number(item.category ?? 0),
        })
        if (isDir) queue.push({ fid: item.fid, path, top })
      }
      options.onProgress?.(entries.length, folders)
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)

  const index: DriveIndex = {
    builtAt: new Date().toISOString(),
    rootFid: '0',
    entries,
  }
  saveIndex(index)
  return index
}

/** 取索引：够新就用缓存，否则重建。 */
export async function ensureIndex(options: {
  refresh?: boolean
  maxAgeHours?: number
  signal?: AbortSignal
  onProgress?: (scanned: number, folders: number) => void
} = {}): Promise<DriveIndex> {
  if (!options.refresh) {
    const cached = loadIndex(options.maxAgeHours ?? 24)
    if (cached) return cached
  }
  return buildIndex({ ...(options.signal ? { signal: options.signal } : {}), ...(options.onProgress ? { onProgress: options.onProgress } : {}) })
}

export function humanSize(bytes: number): string {
  if (!bytes) return '0'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)}${units[unit]}`
}

/** 扩展名（小写，无点）；没有扩展名返回 `(无扩展名)`。 */
export function extOf(name: string): string {
  const idx = name.lastIndexOf('.')
  if (idx <= 0 || idx === name.length - 1) return '(无扩展名)'
  return name.slice(idx + 1).toLowerCase()
}

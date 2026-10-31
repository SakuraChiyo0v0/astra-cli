/**
 * 夸克网盘本地索引：把整棵目录树缓存到 `<ASTRA_HOME>/quark-index.json`。
 *
 * 为什么要缓存：`du` / `find` / `dup` 都要遍历全盘，实测 ~1500 个文件要几十次分页请求，
 * 每次都现扫会让命令等半分钟。索引一次、24 小时内复用；写操作前仍要按 fid 重新校验。
 *
 * 夸克的 `file/sort` 分页：`_page` 从 1 开始、`_size` 最大 100，响应带 `total`。
 * 列表里的 `md5` 字段**恒为 null**（实测），所以去重不能指望它。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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
  /** false = 建到一半的断点（读命令不会用它） */
  done?: boolean
  /** 已扫过的目录 fid，用于断点续建 */
  visited?: string[]
  /** 本次扫描跳过的目录（被删/无权限/风控），读命令忽略即可 */
  skipped?: Array<{ path: string; fid: string; error: string }>
  /** 索引范围：'' = 全盘；否则是某个目录的路径 */
  scope?: string
  /** 最大深度：0 = 不限 */
  depth?: number
}

function indexFile(): string {
  return homePath('quark-index.json')
}

export function loadIndex(maxAgeHours = 24): DriveIndex | null {
  try {
    if (!existsSync(indexFile())) return null
    const parsed = JSON.parse(readFileSync(indexFile(), 'utf8')) as DriveIndex
    if (!Array.isArray(parsed.entries)) return null
    // 断点文件不能当完整索引用，否则 du/find 会拿到半份数据
    if (parsed.done === false) return null
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
  // 这台机器的挂载点会忽略 mode 参数，必须显式 chmod
  try {
    chmodSync(indexFile(), 0o600)
  } catch {
    /* 权限改不动就算了，索引不含凭证 */
  }
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
    // 夸克在大批量遍历时会直接回 HTTP 400（不是参数错，是限流）。
    // 遇到 400/429/5xx 就退避重试，否则几千次请求后整轮扫描前功尽弃。
    let response = await httpRequest(`${BASE}/file/sort?${params}`, {
      headers: { 'user-agent': UA, referer: REFERER, cookie: loadQuarkCookie() ?? '' },
      timeoutMs: 20_000,
      retries: 0,
      ...(signal ? { signal } : {}),
    })
    for (let attempt = 1; attempt <= 6 && !response.ok; attempt += 1) {
      if (!(response.status === 400 || response.status === 429 || response.status >= 500)) break
      await new Promise((r) => setTimeout(r, 1500 * attempt + Math.random() * 800))
      if (signal?.aborted) break
      response = await httpRequest(`${BASE}/file/sort?${params}`, {
        headers: { 'user-agent': UA, referer: REFERER, cookie: loadQuarkCookie() ?? '' },
        timeoutMs: 20_000,
        retries: 0,
        ...(signal ? { signal } : {}),
      })
    }
    if (!response.ok) {
      let preview = ''
      try {
        preview = (await response.text()).slice(0, 200)
      } catch {
        /* ignore */
      }
      throw new AstraError(
        'QUARK_HTTP',
        `列目录失败 HTTP ${response.status}（pdir_fid=${fid}）${preview ? `：${preview}` : ''}`,
        {
          exitCode: 5,
          hint: '歇一会儿再跑，索引有断点会接着来；或把 --depth 调小',
        },
      )
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
  scope?: string
  rootFid?: string
  depth?: number
  signal?: AbortSignal
  onProgress?: (scanned: number, folders: number) => void
  concurrency?: number
  /** 有断点就从断点接着扫 */
  resume?: boolean
  /** 增量：只下钻 updated_at 变过的目录 */
  incremental?: boolean
} = {}): Promise<DriveIndex> {
  const concurrency = Math.max(1, Math.min(6, options.concurrency ?? 3))
  const maxDepth = options.depth ?? 0
  const skipped: Array<{ path: string; fid: string; error: string }> = []
  let entries: DriveEntry[] = []
  const visited = new Set<string>()
  const queue: Array<{ fid: string; path: string; top: string }> = []

  // 增量：基于上一份完整索引，只重扫「自己或子项变过」的目录
  if (options.incremental) {
    const cached = loadIndex(0)
    if (cached?.done) {
      const builtAt = Date.parse(cached.builtAt) || 0
      const byPath = new Map<string, DriveEntry>()
      for (const e of cached.entries) byPath.set(e.path, e)
      const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
      const freshParents = new Set<string>()
      const queue: Array<{ fid: string; path: string; top: string }> = [
        { fid: options.rootFid ?? '0', path: options.scope ?? '', top: '' },
      ]
      const seen = new Set<string>()
      let visitedCount = 0
      let sinceCheckpoint = 0
      const checkpoint = (done: boolean): void => {
        saveIndex({
          builtAt: done ? new Date().toISOString() : cached.builtAt,
          rootFid: '0',
          entries: [...byPath.values()],
          done,
          visited: [...seen],
          ...(options.scope ? { scope: options.scope } : {}),
          ...(maxDepth ? { depth: maxDepth } : {}),
        })
      }

      const worker = async (): Promise<void> => {
        for (;;) {
          const current = queue.shift()
          if (!current) return
          if (options.signal?.aborted) return
          let items: SortItem[] = []
          try {
            items = await listFolder(current.fid, options.signal)
          } catch (error) {
            skipped.push({ path: current.path, fid: current.fid, error: (error as Error).message.slice(0, 140) })
            seen.add(current.fid)
            continue
          }
          visitedCount += 1
          freshParents.add(current.path)
          const freshNames = new Set<string>()
          const currentDepth = current.path ? current.path.split('/').length : 0
          for (const item of items) {
            if (!item.fid || !item.file_name) continue
            freshNames.add(item.file_name)
            const path = current.path ? `${current.path}/${item.file_name}` : item.file_name
            const isDir = Number(item.dir ?? 0) === 1
            const top = current.top || (isDir ? item.file_name : '')
            const updatedAt = Number(item.updated_at ?? 0)
            const previous = byPath.get(path)
            byPath.set(path, {
              fid: item.fid,
              name: item.file_name,
              dir: isDir,
              size: Number(item.size ?? 0),
              path,
              top,
              updatedAt,
              category: Number(item.category ?? 0),
            })
            seen.add(item.fid)
            // 只有「新目录」或「updated_at 变新」才继续下钻
            const changed = !previous || updatedAt > builtAt
            if (isDir && changed && (maxDepth === 0 || currentDepth < maxDepth)) {
              queue.push({ fid: item.fid, path, top })
            }
          }
          // 这个目录里已经不存在的子项，从索引里删掉
          for (const [path, entry] of [...byPath.entries()]) {
            if (parentOf(path) === current.path && !freshNames.has(entry.name)) byPath.delete(path)
          }
          sinceCheckpoint += 1
          if (sinceCheckpoint >= 50) {
            sinceCheckpoint = 0
            checkpoint(false)
          }
          options.onProgress?.(byPath.size, visitedCount)
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()))
      checkpoint(true)
      return {
        builtAt: new Date().toISOString(),
        rootFid: '0',
        entries: [...byPath.values()],
        done: true,
        visited: [...seen],
        skipped,
        ...(options.scope ? { scope: options.scope } : {}),
        ...(maxDepth ? { depth: maxDepth } : {}),
      }
    }
  }

  // 断点续建：上次扫到一半就接着扫，不用从零开始
  if (options.resume) {
    try {
      const partial = JSON.parse(readFileSync(indexFile(), 'utf8')) as DriveIndex
      if (partial.done === false && Array.isArray(partial.entries)) {
        entries = partial.entries
        for (const fid of partial.visited ?? []) visited.add(fid)
        for (const e of entries) {
          if (e.dir && !visited.has(e.fid)) queue.push({ fid: e.fid, path: e.path, top: e.top })
        }
        if (!visited.has('0')) queue.unshift({ fid: '0', path: '', top: '' })
        options.onProgress?.(entries.length, visited.size)
      }
    } catch {
      /* 断点坏了就从零开始 */
    }
  }
  if (!queue.length && !visited.size) queue.push({ fid: options.rootFid ?? '0', path: options.scope ?? '', top: '' })

  let folders = visited.size
  let sinceCheckpoint = 0
  const checkpoint = (done: boolean): void => {
    saveIndex({
      builtAt: new Date().toISOString(),
      rootFid: '0',
      entries,
      done,
      visited: [...visited],
      ...(options.scope ? { scope: options.scope } : {}),
      ...(maxDepth ? { depth: maxDepth } : {}),
    })
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      const current = queue.shift()
      if (!current) return
      if (options.signal?.aborted) return
      let items: SortItem[] = []
      try {
        items = await listFolder(current.fid, options.signal)
      } catch (error) {
        // 单个目录失败（被删/无权限/风控）不能拖垮整轮，跳过并记账
        skipped.push({ path: current.path, fid: current.fid, error: (error as Error).message.slice(0, 140) })
        visited.add(current.fid)
        continue
      }
      folders += 1
      visited.add(current.fid)
      sinceCheckpoint += 1
      if (sinceCheckpoint >= 50) {
        sinceCheckpoint = 0
        checkpoint(false)   // 中途落盘，被杀也能续
      }
      const currentDepth = current.path ? current.path.split('/').length : 0
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
        // maxDepth>0 时只下钻到该层：超出的目录只记账、不再展开
        if (isDir && (maxDepth === 0 || currentDepth < maxDepth)) {
          queue.push({ fid: item.fid, path, top })
        }
      }
      options.onProgress?.(entries.length, folders)
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)

  checkpoint(true)
  return {
    builtAt: new Date().toISOString(),
    rootFid: '0',
    entries,
    done: true,
    visited: [...visited],
    skipped,
  }
}

/** 取索引：够新就用缓存，否则重建。 */
export async function ensureIndex(options: {
  scope?: string
  rootFid?: string
  depth?: number
  concurrency?: number
  refresh?: boolean
  /** 强制全量重扫（默认在有完整旧索引时走增量） */
  maxAgeHours?: number
  signal?: AbortSignal
  onProgress?: (scanned: number, folders: number) => void
} = {}): Promise<DriveIndex> {
  const sameScopeAs = (index: DriveIndex | null): boolean =>
    !!index && (index.scope ?? '') === (options.scope ?? '') && (index.depth ?? 0) === (options.depth ?? 0)

  if (!options.refresh) {
    const cached = loadIndex(options.maxAgeHours ?? 24)
    if (sameScopeAs(cached)) return cached!
    // 索引过期但有完整旧版本 → 增量更新（只重扫变过的目录），比全量快一个数量级
    const stale = loadIndex(0)
    if (sameScopeAs(stale) && stale?.done) {
      return buildIndex({
        incremental: true,
        ...(options.concurrency ? { concurrency: options.concurrency } : {}),
        ...(options.scope ? { scope: options.scope } : {}),
        ...(options.rootFid ? { rootFid: options.rootFid } : {}),
        ...(options.depth ? { depth: options.depth } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      })
    }
  }
  return buildIndex({
    resume: !options.refresh,
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.rootFid ? { rootFid: options.rootFid } : {}),
    ...(options.depth ? { depth: options.depth } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  })
}

/** 把 `来自：分享/AI模型` 这样的路径解析成 fid；找不到返回 null。 */
export async function resolvePath(path: string, signal?: AbortSignal): Promise<{ fid: string; path: string } | null> {
  const segments = path.split('/').map((x) => x.trim()).filter(Boolean)
  let fid = '0'
  const walked: string[] = []
  for (const segment of segments) {
    const items = await listFolder(fid, signal)
    const hit = items.find((x) => x.file_name === segment)
    if (!hit?.fid) return null
    fid = hit.fid
    walked.push(segment)
  }
  return { fid, path: walked.join('/') }
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

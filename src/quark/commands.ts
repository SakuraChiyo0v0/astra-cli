/**
 * `astra quark ...`：夸克网盘分享的列目录与下载。
 *
 * 典型用法：
 *   astra quark ls "https://pan.quark.cn/s/e92c3b3afb31"
 *   astra quark get <链接> --out /host-root/volume1/AI模型/MOSS --only vae,loras
 *   astra quark cookie set "<cookie>"
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AstraError, invalidInput } from '../core/errors.ts'
import type { Command } from '../core/command.ts'
import { getConfig } from '../core/config.ts'
import { checkWritable } from '../core/doctor.ts'
import { loadQuarkCookie, normalizeCookieInput, saveQuarkCookie, clearQuarkCookie } from './auth.ts'
import { ensureIndex, extOf, humanSize as humanSize2, resolvePath } from './index.ts'
import { buildPlan, type Plan } from './organize.ts'
import { makeFolder, moveFiles } from './api.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { homePath } from '../core/paths.ts'
import {
  deleteFiles,
  downloadToFile,
  downloadUrls,
  openShare,
  parseShareUrl,
  saveShare,
  walkShare,
  waitSaveTask,
  type QuarkShare,
  type ShareItem,
} from './api.ts'

function humanSize(bytes: number): string {
  if (!bytes) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)}${units[unit]}`
}

function defaultOutDir(): string | null {
  const configured = String(getConfig('quark.dir') ?? '').trim()
  return configured || null
}

const ls: Command = {
  name: 'quark ls',
  summary: '列出夸克分享的目录（不需要登录）',
  usage: 'astra quark ls <分享链接|id> [--tree] [--extract 提取码]',
  notes: [
    'data.files[] 每项含 path / size / sizeText；--tree 时带 dir 节点',
    '列目录不需要 cookie；只有下载才要',
  ],
  options: {
    tree: { type: 'boolean', description: '递归列出完整树' },
    depth: { type: 'string', description: '递归深度：默认 3，--tree 时默认 8', valueName: 'n' },
    extract: { type: 'string', description: '提取码（链接里没带时用）', valueName: 'code' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const parsed = parseShareUrl(positionals[0]!)
    const passcode = typeof values.extract === 'string' ? values.extract : parsed.passcode
    const share = await openShare(parsed.pwdId, passcode, signal)
    // 不做 --tree 时也递归到 3 层（分享根目录通常只是一个壳目录，只看一层什么都看不到）
    const depth = Math.max(1, Number(values.depth ?? (values.tree ? '8' : '3')) || 3)
    const files = await walkShare(share, { signal, maxDepth: depth })
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
    return {
      data: {
        pwdId: share.pwdId,
        title: share.title,
        author: share.author,
        fileCount: files.length,
        totalBytes,
        totalText: humanSize(totalBytes),
        files: files.map((f) => ({ path: f.path, size: f.size, sizeText: humanSize(f.size) })),
      },
    }
  },
}

interface DownloadOutcome {
  path: string
  bytes: number
  skipped: boolean
}

interface PullOptions {
  force: boolean
  concurrency: number
  signal?: AbortSignal
  onFile?: (item: ShareItem, index: number) => void
  onDone?: (item: ShareItem, ok: boolean, bytes: number, error?: string) => void
}

/** 转存必须串行：并发调 `share/sharepage/save` 时，后一个任务拿到的 fid 在网盘里并不存在
 *  （取直链恒 21001 file not found，重试 20 秒也等不到）。下载才是慢的那一段，串行转存不影响速度。 */
let saveChain: Promise<unknown> = Promise.resolve()

function withSaveLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = saveChain.then(fn, fn)
  saveChain = run.catch(() => undefined)
  return run
}

/**
 * 并发下载：每个 worker 独立走「转存单个 → 轮询 → 取直链 → 下载 → 删副本」。
 *
 * 为什么按文件而不是按批：一批 10 个文件的转存任务要等全部完成才能取直链，
 * 大文件会把小文件一起拖住；单文件粒度下 N 个 worker 真正并行，尾延迟小很多。
 */
async function pullFiles(
  share: QuarkShare,
  files: ShareItem[],
  outDir: string,
  options: PullOptions,
): Promise<{ downloaded: DownloadOutcome[]; failed: Array<{ path: string; error: string }> }> {
  const downloaded: DownloadOutcome[] = []
  const failed: Array<{ path: string; error: string }> = []
  const queue: Array<{ item: ShareItem; target: string; index: number }> = []

  files.forEach((item, index) => {
    const target = join(outDir, item.path)
    if (!options.force && existsSync(target) && statSync(target).size === item.size) {
      downloaded.push({ path: target, bytes: item.size, skipped: true })
      options.onDone?.(item, true, item.size)
      return
    }
    queue.push({ item, target, index })
  })

  const worker = async (): Promise<void> => {
    for (;;) {
      const job = queue.shift()
      if (!job) return
      if (options.signal?.aborted) return
      const { item, target, index } = job
      options.onFile?.(item, index)
      let newFid: string | undefined
      try {
        // 转存串行（见 withSaveLock 注释）；拿到直链后下载可以并行
        const urls = await withSaveLock(async () => {
          const taskId = await saveShare(share, [item], options.signal)
          const fids = await waitSaveTask(taskId, options.signal)
          newFid = fids[0]
          if (!newFid) throw new Error('转存没有返回 fid')
          return downloadUrls([newFid], options.signal)
        })
        const url = urls.get(newFid!)
        if (!url) throw new Error('没拿到直链')
        const result = await downloadToFile(url, target, { signal: options.signal })
        downloaded.push({ path: result.path, bytes: result.bytes, skipped: false })
        options.onDone?.(item, true, result.bytes)
      } catch (error) {
        const message = (error as Error).message
        failed.push({ path: item.path, error: message })
        options.onDone?.(item, false, 0, message)
      } finally {
        // 无论成败都要删副本，否则失败的文件会一直占着用户网盘
        if (newFid) await deleteFiles([newFid], options.signal)
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency, queue.length)) }, () => worker())
  await Promise.all(workers)

  // 兜底：并发转存在夸克侧并不稳定（实测两个任务并行时，后一个的 fid 有时永远不落地，
  // 取直链恒 21001）。失败的再串行重试一次，代价只是一点点时间，换来「不漏文件」。
  if (failed.length) {
    const retry = failed.splice(0, failed.length)
    for (const miss of retry) {
      const item = files.find((f) => f.path === miss.path)
      if (!item || options.signal?.aborted) {
        failed.push(miss)
        continue
      }
      const target = join(outDir, item.path)
      let fid: string | undefined
      try {
        const taskId = await saveShare(share, [item], options.signal)
        const fids = await waitSaveTask(taskId, options.signal)
        fid = fids[0]
        if (!fid) throw new Error('转存没有返回 fid')
        const urls = await downloadUrls([fid], options.signal)
        const url = urls.get(fid)
        if (!url) throw new Error('没拿到直链')
        const result = await downloadToFile(url, target, { signal: options.signal })
        downloaded.push({ path: result.path, bytes: result.bytes, skipped: false })
        options.onDone?.(item, true, result.bytes)
      } catch (error) {
        failed.push({ path: miss.path, error: (error as Error).message })
      } finally {
        if (fid) await deleteFiles([fid], options.signal)
      }
    }
  }
  return { downloaded, failed }
}

const get: Command = {
  name: 'quark get',
  summary: '下载夸克分享里的文件（转存 → 直链 → 落盘 → 删副本）',
  usage: 'astra quark get <分享链接> [--out <目录>] [--only 关键词1,关键词2] [--force] [--dry]',
  notes: [
    'data.status：downloaded / nothing / dry_run',
    '落盘保留分享里的相对路径；目录看 quark.dir 或 --out',
    '下载需要 cookie（`astra quark cookie set`），且会员才有正常速度',
    '转存副本下载完立即删除；进程被杀时可能残留在网盘根目录，手工删掉即可',
  ],
  options: {
    out: { type: 'string', description: '落盘目录（绝对路径）', valueName: 'dir' },
    only: { type: 'string', description: '只下路径里含这些关键词的文件，逗号分隔', valueName: 'k1,k2' },
    force: { type: 'boolean', description: '已有同尺寸文件也重下' },
    dry: { type: 'boolean', description: '只列要下什么，不真下' },
    extract: { type: 'string', description: '提取码', valueName: 'code' },
    concurrency: { type: 'string', description: '并发下载数 1..3，默认看 quark.concurrency', valueName: 'n' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    if (!loadQuarkCookie()) {
      throw invalidInput('还没配置夸克 cookie', '先跑 `astra quark cookie set "<cookie>"`（浏览器 F12 复制）')
    }
    const parsed = parseShareUrl(positionals[0]!)
    const passcode = typeof values.extract === 'string' ? values.extract : parsed.passcode
    const share = await openShare(parsed.pwdId, passcode, signal)
    const all = await walkShare(share, { signal })

    const keywords = typeof values.only === 'string'
      ? values.only.split(',').map((s) => s.trim()).filter(Boolean)
      : []
    const picked = keywords.length ? all.filter((f) => keywords.some((k) => f.path.includes(k))) : all
    if (!picked.length) {
      return { data: { status: 'nothing', message: '没有匹配的文件', fileCount: all.length } }
    }
    const totalBytes = picked.reduce((sum, f) => sum + f.size, 0)
    if (values.dry === true) {
      return {
        data: {
          status: 'dry_run',
          title: share.title,
          fileCount: picked.length,
          totalBytes,
          totalText: humanSize(totalBytes),
          files: picked.map((f) => ({ path: f.path, sizeText: humanSize(f.size) })),
        },
      }
    }

    const outDir = (typeof values.out === 'string' ? values.out : defaultOutDir()) ?? ''
    if (!outDir) throw invalidInput('没有落盘目录', '加 `--out <绝对路径>`，或先 `astra config set quark.dir <目录>`')
    checkWritable(outDir)

    // 默认 1：实测并发不提速（单账号带宽封顶 15MB/s/流，多流不叠加），
    // 且夸克并发转存偶尔让后一个任务的 fid 永远不落地，反而要跑兜底重试。
    const configured = Number(getConfig('quark.concurrency') ?? '1')
    const concurrency = Math.max(
      1,
      Math.min(3, Number(values.concurrency ?? configured) || configured || 1),
    )
    let finished = 0
    const { downloaded, failed } = await pullFiles(share, picked, outDir, {
      force: values.force === true,
      concurrency,
      signal,
      onFile: (item) => {
        process.stderr.write(`↓ ${item.path} (${humanSize(item.size)})\n`)
      },
      onDone: (item, ok, bytes, error) => {
        finished += 1
        const tag = ok ? `✓ ${humanSize(bytes)}` : `✗ ${error ?? ''}`
        process.stderr.write(`[${finished}/${picked.length}] ${tag}  ${item.path}\n`)
      },
    })

    return {
      data: {
        status: 'downloaded',
        out: outDir,
        concurrency,
        downloaded: downloaded.filter((d) => !d.skipped).length,
        skipped: downloaded.filter((d) => d.skipped).length,
        failed: failed.length,
        bytes: downloaded.reduce((sum, d) => sum + d.bytes, 0),
        failures: failed,
      },
    }
  },
}


const du: Command = {
  name: 'quark du',
  summary: '空间体检：按顶层目录 / 扩展名 / 大小区间看谁最占地方',
  usage: 'astra quark du [--path 目录] [--depth 2] [--deep] [--refresh] [--top 12] [--by dir|ext|size]',
  notes: [
    '只读，不动任何文件',
    '默认只下钻 2 层，几秒出结果；--deep 扫全树（3.5 万条目要几分钟，带断点续建）',
    '可以只扫某个目录：astra quark du --path "来自：分享"（位置参数写法也支持）',
    '索引缓存在 <ASTRA_HOME>/quark-index.json，范围/深度变了会自动重建',
    'data.totals / data.byTop / data.byExt / data.bySize',
  ],
  maxArgs: 1,
  options: {
    refresh: { type: 'boolean', description: '强制重建索引' },
    deep: { type: 'boolean', description: '扫全树（默认只下钻 2 层）' },
    concurrency: { type: 'string', description: '并发列目录数 1..6，默认 3；被限流时用 1', valueName: 'n' },
    path: { type: 'string', description: '只扫这个目录（相对网盘根）', valueName: '目录' },
    depth: { type: 'string', description: '自定义下钻层数', valueName: 'n' },
    top: { type: 'string', description: '每类显示前 N 条，默认 12', valueName: 'n' },
    by: { type: 'string', description: '只看某一维：dir / ext / size', valueName: 'dim' },
  },
  async run({ positionals, values, signal }) {
    if (!loadQuarkCookie()) {
      throw invalidInput('还没配置夸克 cookie', '先跑 `astra quark cookie set "<cookie>"`')
    }
    let scope = ''
    let rootFid = '0'
    const rawPath = (typeof values.path === 'string' && values.path.trim()) || positionals[0] || ''
    if (rawPath) {
      const resolved = await resolvePath(rawPath, signal)
      if (!resolved) throw invalidInput(`目录不存在：${rawPath}`, '先 `astra quark ls` 看看根目录有哪些')
      scope = resolved.path
      rootFid = resolved.fid
    }
    const depth = values.deep === true
      ? 0
      : Math.max(0, Math.min(20, Number(values.depth ?? '2') || 2))
    const index = await ensureIndex({
      scope,
      rootFid,
      depth,
      concurrency: Math.max(1, Math.min(6, Number(values.concurrency ?? '3') || 3)),
      refresh: values.refresh === true,
      ...(signal ? { signal } : {}),
      onProgress: (scanned, folders) => {
        if (folders % 10 === 0) process.stderr.write(`扫描中… ${folders} 个目录 / ${scanned} 项\n`)
      },
    })
    const files = index.entries.filter((e) => !e.dir)
    const dirs = index.entries.filter((e) => e.dir)
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
    const top = Math.max(1, Math.min(50, Number(values.top ?? '12') || 12))

    const group = (keyOf: (e: typeof files[number]) => string) => {
      const map = new Map<string, { count: number; bytes: number }>()
      for (const file of files) {
        const key = keyOf(file)
        const row = map.get(key) ?? { count: 0, bytes: 0 }
        row.count += 1
        row.bytes += file.size
        map.set(key, row)
      }
      return [...map.entries()]
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .slice(0, top)
        .map(([key, row]) => ({ key, count: row.count, bytes: row.bytes, text: humanSize2(row.bytes) }))
    }

    const bucket = (size: number): string => {
      if (size === 0) return '0 B（空文件）'
      if (size < 1024 * 1024) return '< 1 MB'
      if (size < 100 * 1024 * 1024) return '1–100 MB'
      if (size < 1024 * 1024 * 1024) return '100 MB – 1 GB'
      if (size < 10 * 1024 * 1024 * 1024) return '1–10 GB'
      return '> 10 GB'
    }

    const byTop = group((e) => e.top || '(根目录散文件)')
    const byExt = group((e) => extOf(e.name))
    const bySize = group((e) => bucket(e.size))
    const dim = typeof values.by === 'string' ? values.by : ''
    const pick = (name: string, rows: typeof byTop) => (dim && dim !== name ? [] : rows)

    return {
      data: {
        builtAt: index.builtAt,
        totals: {
          files: files.length,
          dirs: dirs.length,
          bytes: totalBytes,
          text: humanSize2(totalBytes),
        },
        byTop: pick('dir', byTop),
        byExt: pick('ext', byExt),
        bySize: pick('size', bySize),
      },
    }
  },
}


const find: Command = {
  name: 'quark find',
  summary: '在网盘索引里搜文件（名称 / 扩展名 / 大小 / 时间）',
  usage: 'astra quark find <关键词> [--ext zip,mp4] [--min 1GB] [--limit 30] [--refresh]',
  notes: [
    '读本地索引（24 小时内有效），秒回；--refresh 强制重建',
    'data.matches[] 含 path / sizeText / updatedAt',
  ],
  options: {
    ext: { type: 'string', description: '扩展名过滤，逗号分隔', valueName: 'zip,mp4' },
    min: { type: 'string', description: '最小体积，如 100MB / 1GB', valueName: 'size' },
    max: { type: 'string', description: '最大体积', valueName: 'size' },
    limit: { type: 'string', description: '最多返回条数，默认 30', valueName: 'n' },
    refresh: { type: 'boolean', description: '强制重建索引' },
    dirs: { type: 'boolean', description: '只列目录' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    if (!loadQuarkCookie()) throw invalidInput('还没配置夸克 cookie', '先跑 `astra quark cookie set "<cookie>"`')
    const index = await ensureIndex({ refresh: values.refresh === true, ...(signal ? { signal } : {}) })
    const keyword = positionals[0]!.toLowerCase()
    const exts = typeof values.ext === 'string'
      ? values.ext.split(',').map((x) => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean)
      : []
    const parseSize = (raw: unknown): number => {
      if (typeof raw !== 'string' || !raw.trim()) return 0
      const m = raw.trim().match(/^([\d.]+)\s*([kmgt]?b?)$/i)
      if (!m) return 0
      const value = Number(m[1])
      const unit = (m[2] ?? '').toLowerCase()
      const mult: Record<string, number> = {
        '': 1, b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2,
        g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4,
      }
      return Math.round(value * (mult[unit] ?? 1))
    }
    const minBytes = parseSize(values.min)
    const maxBytes = parseSize(values.max)
    const limit = Math.max(1, Math.min(500, Number(values.limit ?? '30') || 30))

    const matches = index.entries
      .filter((e) => (values.dirs === true ? e.dir : true))
      .filter((e) => e.path.toLowerCase().includes(keyword))
      .filter((e) => (exts.length ? !e.dir && exts.includes(extOf(e.name)) : true))
      .filter((e) => (minBytes ? e.size >= minBytes : true))
      .filter((e) => (maxBytes ? e.size <= maxBytes : true))
      .sort((a, b) => b.size - a.size)

    return {
      data: {
        keyword,
        total: matches.length,
        bytes: matches.reduce((sum, m) => sum + m.size, 0),
        text: humanSize2(matches.reduce((sum, m) => sum + m.size, 0)),
        matches: matches.slice(0, limit).map((m) => ({
          path: m.path,
          fid: m.fid,
          size: m.size,
          sizeText: humanSize2(m.size),
          updatedAt: m.updatedAt ? new Date(m.updatedAt).toISOString() : null,
        })),
      },
    }
  },
}

const dup: Command = {
  name: 'quark dup',
  summary: '找重复文件（同体积 + 同名），算出能省多少空间',
  usage: 'astra quark dup [--min 100MB] [--limit 20] [--refresh]',
  notes: [
    '夸克列表接口的 md5 恒为 null，所以只能按「体积 + 归一化文件名」判定，属于**保守近似**：',
    '同体积同名的才算重复，宁漏不误杀',
    'data.groups[] 每项含 keep（建议保留）与 duplicates[]',
  ],
  options: {
    min: { type: 'string', description: '只统计大于该体积的文件，默认 10MB', valueName: 'size' },
    limit: { type: 'string', description: '最多返回多少组，默认 20', valueName: 'n' },
    refresh: { type: 'boolean', description: '强制重建索引' },
  },
  async run({ values, signal }) {
    if (!loadQuarkCookie()) throw invalidInput('还没配置夸克 cookie', '先跑 `astra quark cookie set "<cookie>"`')
    const index = await ensureIndex({ refresh: values.refresh === true, ...(signal ? { signal } : {}) })
    const rawMin = typeof values.min === 'string' ? values.min : '10MB'
    const m = rawMin.match(/^([\d.]+)\s*([kmgt]?b?)$/i)
    const mult: Record<string, number> = { '': 1, b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4 }
    const minBytes = m ? Math.round(Number(m[1]) * (mult[(m[2] ?? '').toLowerCase()] ?? 1)) : 10 * 1024 ** 2
    const limit = Math.max(1, Math.min(500, Number(values.limit ?? '20') || 20))

    const norm = (name: string) => name
      .replace(/\(\d+\)/g, '')
      .replace(/[\s_\-]+/g, '')
      .replace(/副本|copy|Copy/g, '')
      .toLowerCase()

    const groups = new Map<string, typeof index.entries>()
    for (const e of index.entries) {
      if (e.dir || e.size < minBytes) continue
      const key = `${e.size}::${norm(e.name)}`
      const list = groups.get(key) ?? []
      list.push(e)
      groups.set(key, list)
    }

    const allDup = [...groups.values()].filter((g) => g.length > 1)
    const dupGroups = allDup
      .sort((a, b) => b.length * b[0]!.size - a.length * a[0]!.size)
      .slice(0, limit)
      .map((g) => ({
        size: g[0]!.size,
        sizeText: humanSize2(g[0]!.size),
        count: g.length,
        wastedBytes: g[0]!.size * (g.length - 1),
        wastedText: humanSize2(g[0]!.size * (g.length - 1)),
        keep: g[0]!.path,
        duplicates: g.slice(1).map((x) => ({ path: x.path, fid: x.fid })),
      }))

    return {
      data: {
        scanned: index.entries.filter((e) => !e.dir).length,
        minSize: humanSize2(minBytes),
        groupCount: allDup.length,
        shown: dupGroups.length,
        wastedBytes: allDup.reduce((sum, g) => sum + g[0]!.size * (g.length - 1), 0),
        wastedText: humanSize2(allDup.reduce((sum, g) => sum + g[0]!.size * (g.length - 1), 0)),
        note: '按体积+归一化文件名判定，保守近似；确认后可用 `quark apply` 删除（进回收站）',
        groups: dupGroups,
      },
    }
  },
}


const plan: Command = {
  name: 'quark plan',
  summary: '生成网盘整理清单（只读，不改任何文件）',
  usage: 'astra quark plan [--path 目录] [--depth 2] [--deep] [--out 文件] [--refresh]',
  notes: [
    '**只输出建议，不动文件**；确认后用 `astra quark apply <清单>` 执行',
    '规则：散文件按类型归档 / 重复文件只提示（无 md5，不自动删）/ 空目录建议清理',
    '清单默认写到 <ASTRA_HOME>/quark-plan.json',
  ],
  options: {
    path: { type: 'string', description: '整理这个目录（默认全盘根）', valueName: '目录' },
    depth: { type: 'string', description: '下钻层数，默认 2', valueName: 'n' },
    deep: { type: 'boolean', description: '扫全树' },
    out: { type: 'string', description: '清单输出路径', valueName: 'file' },
    'dup-min': { type: 'string', description: '重复文件最小体积，默认 100MB', valueName: 'size' },
    'no-empty': { type: 'boolean', description: '不包含空目录清理建议' },
    refresh: { type: 'boolean', description: '强制重建索引' },
  },
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    if (!loadQuarkCookie()) throw invalidInput('还没配置夸克 cookie', '先跑 `astra quark cookie set "<cookie>"`')
    let scope = ''
    let rootFid = '0'
    const rawPath = (typeof values.path === 'string' && values.path.trim()) || positionals[0] || ''
    if (rawPath) {
      const resolved = await resolvePath(rawPath, signal)
      if (!resolved) throw invalidInput(`目录不存在：${rawPath}`, '先 `astra quark ls` 看看根目录有哪些')
      scope = resolved.path
      rootFid = resolved.fid
    }
    const depth = values.deep === true ? 0 : Math.max(0, Math.min(20, Number(values.depth ?? '2') || 2))
    const index = await ensureIndex({ scope, rootFid, depth, refresh: values.refresh === true, ...(signal ? { signal } : {}) })
    const rawDupMin = typeof values['dup-min'] === 'string' ? values['dup-min'] : '100MB'
    const m = rawDupMin.match(/^([\d.]+)\s*([kmgt]?b?)$/i)
    const mult: Record<string, number> = { '': 1, b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4 }
    const dupMin = m ? Math.round(Number(m[1]) * (mult[(m[2] ?? '').toLowerCase()] ?? 1)) : 100 * 1024 ** 2

    const built = buildPlan({
      entries: index.entries,
      scope,
      dupMinBytes: dupMin,
      includeEmpty: values['no-empty'] !== true,
      indexComplete: depth === 0,
    })
    const outPath = typeof values.out === 'string' ? values.out : homePath('quark-plan.json')
    writeFileSync(outPath, JSON.stringify(built, null, 2) + '\n', 'utf8')

    return {
      data: {
        planPath: outPath,
        scope: scope || '(根目录)',
        indexed: index.entries.length,
        summary: built.summary,
        actionTotal: built.actions.length,
        // 只回显前 40 条，完整清单在 planPath 里
        actions: built.actions.slice(0, 40).map((a) => ({
          id: a.id,
          op: a.op,
          label: a.label,
          count: a.fids?.length ?? 0,
          bytes: a.bytes ?? 0,
        })),
        review: built.review.slice(0, 10),
      },
    }
  },
}

const apply: Command = {
  name: 'quark apply',
  summary: '执行整理清单（move 会真移动；删除只在加 --purge-empty 时进回收站）',
  usage: 'astra quark apply [清单文件] [--dry] [--purge-empty] [--yes]',
  notes: [
    '默认只执行 mkdir + move；空目录删除需要显式 --purge-empty',
    '--dry 只打印将执行什么',
    '所有删除都进夸克回收站（不是永久删除），可恢复',
    '操作间隔 300ms，避免触发风控',
  ],
  options: {
    dry: { type: 'boolean', description: '只打印，不执行' },
    'purge-empty': { type: 'boolean', description: '连空目录清理建议一起执行' },
    yes: { type: 'boolean', description: '跳过确认（非交互环境必须带）' },
  },
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    if (!loadQuarkCookie()) throw invalidInput('还没配置夸克 cookie', '先跑 `astra quark cookie set "<cookie>"`')
    const file = positionals[0] || homePath('quark-plan.json')
    let parsed: Plan
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as Plan
    } catch (error) {
      throw invalidInput(`读不了清单 ${file}`, '先跑 `astra quark plan` 生成清单')
    }

    const dry = values.dry === true
    const purgeEmpty = values['purge-empty'] === true
    const results: Array<{ id: number; op: string; ok: boolean; detail: string }> = []

    // 目录 fid 缓存：同一路径只 resolve/建一次
    const dirCache = new Map<string, string>()
    dirCache.set('', '0')

    const resolveDir = async (path: string): Promise<string> => {
      const cached = dirCache.get(path)
      if (cached) return cached
      const segments = path.split('/').filter(Boolean)
      let fid = '0'
      const walked: string[] = []
      for (const segment of segments) {
        const below = [...walked, segment].join('/')
        const hit = dirCache.get(below)
        if (hit) {
          fid = hit
          walked.push(segment)
          continue
        }
        fid = await makeFolder(fid, segment, signal)
        dirCache.set(below, fid)
        walked.push(segment)
      }
      dirCache.set(path, fid)
      return fid
    }

    for (const action of parsed.actions) {
      if (signal?.aborted) break
      if (action.op === 'remove' && (!purgeEmpty || action.advisory)) {
        results.push({ id: action.id, op: action.op, ok: true, detail: '跳过（需人工确认或未加 --purge-empty）' })
        continue
      }
      if (dry) {
        results.push({ id: action.id, op: action.op, ok: true, detail: `[dry] ${action.label}` })
        continue
      }
      try {
        if (action.op === 'mkdir' && action.dir) {
          await resolveDir(action.dir)
          results.push({ id: action.id, op: action.op, ok: true, detail: `已建 ${action.dir}` })
        } else if (action.op === 'move' && action.to && action.fids?.length) {
          const target = await resolveDir(action.to)
          await moveFiles(action.fids, target, signal)
          results.push({ id: action.id, op: action.op, ok: true, detail: `移动 ${action.fids.length} 个 → ${action.to}` })
        } else if (action.op === 'remove' && action.fids?.length) {
          await deleteFiles(action.fids, signal)
          results.push({ id: action.id, op: action.op, ok: true, detail: `已删除 ${action.fids.length} 项（进回收站）` })
        }
        await new Promise((r) => setTimeout(r, 300))
      } catch (error) {
        results.push({ id: action.id, op: action.op, ok: false, detail: (error as Error).message })
      }
    }

    return {
      data: {
        plan: file,
        dry,
        total: parsed.actions.length,
        ok: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      },
    }
  },
}

const cookie: Command = {
  name: 'quark cookie',
  summary: '管理夸克登录态：set / show / clear',
  usage: 'astra quark cookie <set|show|clear> [cookie 串]',
  notes: ['存 <ASTRA_HOME>/quark.json（600）；只需要 pan.quark.cn 这个域的 cookie'],
  minArgs: 1,
  maxArgs: 2,
  async run({ positionals }) {
    const action = positionals[0]!
    if (action === 'set') {
      const raw = positionals[1]
      if (!raw) throw invalidInput('缺少 cookie 串', 'astra quark cookie set "b-user-id=...; __puus=..."')
      const normalized = normalizeCookieInput(raw)
      const saved = saveQuarkCookie(normalized)
      return {
        data: {
          status: 'saved',
          savedAt: saved.savedAt,
          length: normalized.length,
          hasPuus: normalized.includes('__puus='),
        },
      }
    }
    if (action === 'show') {
      const current = loadQuarkCookie()
      if (!current) return { data: { configured: false } }
      return {
        data: {
          configured: true,
          length: current.length,
          preview: `${current.slice(0, 24)}…${current.slice(-8)}`,
          hasPuus: current.includes('__puus='),
        },
      }
    }
    if (action === 'clear') {
      return { data: { cleared: clearQuarkCookie() } }
    }
    throw invalidInput(`不认识的子命令：${action}`, '可用：set / show / clear')
  },
}

const doctor: Command = {
  name: 'quark doctor',
  summary: '检查 cookie 是否有效、会员等级、接口连通性',
  usage: 'astra quark doctor',
  async run({ signal }) {
    const cookieValue = loadQuarkCookie()
    if (!cookieValue) {
      return { data: { ok: false, cookie: 'missing', hint: '先 `astra quark cookie set "<cookie>"`' } }
    }
    const response = await (
      await import('../core/http.ts')
    ).httpRequest('https://pan.quark.cn/1/clouddrive/member?pr=ucpro&fr=pc', {
      headers: { 'user-agent': 'Mozilla/5.0', cookie: cookieValue, referer: 'https://pan.quark.cn/' },
      timeoutMs: 15_000,
      retries: 1,
      ...(signal ? { signal } : {}),
    })
    const body = (await response.json()) as { code?: number; data?: { member_type?: string } }
    return {
      data: {
        ok: body.code === 0,
        cookie: 'present',
        memberType: body.data?.member_type ?? null,
        speedHint: body.data?.member_type && body.data.member_type !== 'NORMAL' ? 'VIP 生效，下载走会员速度' : '非会员，速度受限',
      },
    }
  },
}

export const quarkCommands: Command[] = [ls, get, du, find, dup, plan, apply, cookie, doctor]

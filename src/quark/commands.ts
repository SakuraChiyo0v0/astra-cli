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

export const quarkCommands: Command[] = [ls, get, cookie, doctor]

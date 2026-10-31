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
    depth: { type: 'string', description: '递归深度，默认 3', valueName: 'n' },
    extract: { type: 'string', description: '提取码（链接里没带时用）', valueName: 'code' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const parsed = parseShareUrl(positionals[0]!)
    const passcode = typeof values.extract === 'string' ? values.extract : parsed.passcode
    const share = await openShare(parsed.pwdId, passcode, signal)
    const files = await walkShare(share, {
      signal,
      maxDepth: values.tree ? Math.max(1, Number(values.depth ?? '3') || 3) : 0,
    })
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

async function pullFiles(
  share: QuarkShare,
  files: ShareItem[],
  outDir: string,
  options: { force: boolean; signal?: AbortSignal; onFile?: (item: ShareItem, index: number) => void },
): Promise<{ downloaded: DownloadOutcome[]; failed: Array<{ path: string; error: string }> }> {
  const downloaded: DownloadOutcome[] = []
  const failed: Array<{ path: string; error: string }> = []
  const BATCH = 10

  for (let i = 0; i < files.length; i += BATCH) {
    const chunk = files.slice(i, i + BATCH)
    const pending: Array<{ item: ShareItem; target: string }> = []
    for (const item of chunk) {
      const target = join(outDir, item.path)
      if (!options.force && existsSync(target) && statSync(target).size === item.size) {
        downloaded.push({ path: target, bytes: item.size, skipped: true })
        continue
      }
      pending.push({ item, target })
    }
    if (!pending.length) continue

    let newFids: string[] = []
    try {
      const taskId = await saveShare(share, pending.map((p) => p.item), options.signal)
      newFids = await waitSaveTask(taskId, options.signal)
    } catch (error) {
      for (const p of pending) failed.push({ path: p.item.path, error: (error as Error).message })
      continue
    }
    if (newFids.length !== pending.length) {
      for (const p of pending) failed.push({ path: p.item.path, error: '转存返回的 fid 数量不匹配' })
      continue
    }

    let urls: Map<string, string>
    try {
      urls = await downloadUrls(newFids, options.signal)
    } catch (error) {
      for (const p of pending) failed.push({ path: p.item.path, error: (error as Error).message })
      continue
    }

    for (let idx = 0; idx < pending.length; idx += 1) {
      const { item, target } = pending[idx]!
      const url = urls.get(newFids[idx]!)
      if (!url) {
        failed.push({ path: item.path, error: '没拿到直链' })
        continue
      }
      try {
        options.onFile?.(item, i + idx)
        const result = await downloadToFile(url, target, { signal: options.signal })
        downloaded.push({ path: result.path, bytes: result.bytes, skipped: false })
      } catch (error) {
        failed.push({ path: item.path, error: (error as Error).message })
      }
    }
    // 立刻删掉网盘里的副本，不占用户空间
    await deleteFiles(newFids, options.signal)
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
    '转存副本下载完立即删除；进程被杀可能残留，用 `astra quark clean` 清理',
  ],
  options: {
    out: { type: 'string', description: '落盘目录（绝对路径）', valueName: 'dir' },
    only: { type: 'string', description: '只下路径里含这些关键词的文件，逗号分隔', valueName: 'k1,k2' },
    force: { type: 'boolean', description: '已有同尺寸文件也重下' },
    dry: { type: 'boolean', description: '只列要下什么，不真下' },
    extract: { type: 'string', description: '提取码', valueName: 'code' },
    concurrency: { type: 'string', description: '预留：并发数（当前串行）', valueName: 'n' },
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

    const { downloaded, failed } = await pullFiles(share, picked, outDir, {
      force: values.force === true,
      signal,
      onFile: (item, index) => {
        process.stderr.write(`[${index + 1}/${picked.length}] ${item.path} (${humanSize(item.size)})\n`)
      },
    })

    return {
      data: {
        status: 'downloaded',
        out: outDir,
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

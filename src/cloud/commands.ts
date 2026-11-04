/**
 * `astra cloud ...` —— 跨网盘的统一命令层。
 *
 * 设计取舍：**命令只依赖 CloudDrive 接口**，具体是夸克还是百度由 `--drive` 决定。
 * 夸克原来的 `astra quark ...` 子命令一个都不动（它们已经跑通、有索引缓存、有测过的行为），
 * 这里只提供"两家都能用"的那几条：ls / stat / mkdir / mv / rm / get。
 *
 * 为什么不把 quark 的命令整体迁过来：那套命令依赖夸克专属的索引文件和分享转存流程，
 * 抽象成通用接口会把两边的差异磨平（百度没有分享直链、转存语义也不同），得不偿失。
 */
import { createWriteStream } from 'node:fs'
import { mkdir as mkdirFs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { invalidInput, AstraError } from '../core/errors.ts'
import { humanSize } from '../quark/index.ts'
import type { Command, CommandResult } from '../core/command.ts'
import { baiduDrive } from './baidu.ts'
import { clearCloudCredential, loadCloudCredential, maskSecret, saveCloudCredential, type CloudId } from './auth-store.ts'
import { quarkDrive } from './quark.ts'
import { loadQuarkCookie } from '../quark/auth.ts'
import { normalizePath, type CloudDrive } from './types.ts'
import { authUrlCommand } from './auth-url.ts'

const DRIVES: Record<CloudId, CloudDrive> = { quark: quarkDrive, baidu: baiduDrive }

function driveOf(name: unknown): CloudDrive {
  if (name === undefined) {
    // 默认按配置的默认盘走，没配就夸克（本机主力）
    return quarkDrive
  }
  const key = String(name).toLowerCase() as CloudId
  const drive = DRIVES[key]
  if (!drive) throw invalidInput(`不认识的网盘：${name}`, '可选：quark / baidu')
  return drive
}

function rowsOf(nodes: { name: string; dir: boolean; size: number; path: string }[]): (string | number)[][] {
  return nodes.map((n) => [n.dir ? '目录' : '文件', n.name, n.dir ? '-' : humanSize(n.size), n.path])
}

export const cloudCommands: Command[] = [
  authUrlCommand,
  {
    name: 'cloud ls',
    summary: '列网盘目录（夸克 / 百度通用）',
    usage: 'astra cloud ls [路径] [--drive quark|baidu] [--table]',
    notes: [
      '--drive 不给就走夸克（本机主力盘）；百度要先用 `cloud login baidu <token>` 配 access_token。',
      '路径按 `/` 分隔，根目录写 `/` 或省略。',
    ],
    options: {
      drive: { type: 'string', description: '哪个网盘：quark / baidu', valueName: 'name' },
    },
    maxArgs: 1,
    run: async (ctx): Promise<CommandResult> => {
      const drive = driveOf(ctx.values.drive)
      const path = normalizePath(ctx.positionals[0] ?? '/')
      const nodes = await drive.list(path, ctx.signal)
      return {
        data: { drive: drive.id, path, count: nodes.length, items: nodes },
        table: { headers: ['类型', '名称', '大小', '路径'], rows: rowsOf(nodes) },
      }
    },
  },
  {
    name: 'cloud stat',
    summary: '查单个文件/目录是否存在及大小',
    usage: 'astra cloud stat <路径> [--drive quark|baidu]',
    options: {
      drive: { type: 'string', description: '哪个网盘：quark / baidu', valueName: 'name' },
    },
    minArgs: 1,
    maxArgs: 1,
    run: async (ctx): Promise<CommandResult> => {
      const drive = driveOf(ctx.values.drive)
      const node = await drive.stat(normalizePath(ctx.positionals[0]!), ctx.signal)
      if (!node) {
        return {
          data: { exists: false, path: ctx.positionals[0] },
          warnings: ['这个路径在网盘里不存在（不是"大小为 0"）'],
        }
      }
      return { data: { exists: true, ...node } }
    },
  },
  {
    name: 'cloud mkdir',
    summary: '建目录（父级不存在自动建）',
    usage: 'astra cloud mkdir <路径> [--drive quark|baidu]',
    options: {
      drive: { type: 'string', description: '哪个网盘：quark / baidu', valueName: 'name' },
    },
    minArgs: 1,
    maxArgs: 1,
    run: async (ctx): Promise<CommandResult> => {
      const drive = driveOf(ctx.values.drive)
      const path = await drive.mkdir(normalizePath(ctx.positionals[0]!), ctx.signal)
      return { data: { drive: drive.id, created: path } }
    },
  },
  {
    name: 'cloud mv',
    summary: '移动文件/目录到目标目录',
    usage: 'astra cloud mv <源...> <目标目录> [--drive quark|baidu]',
    options: {
      drive: { type: 'string', description: '哪个网盘：quark / baidu', valueName: 'name' },
    },
    minArgs: 2,
    run: async (ctx): Promise<CommandResult> => {
      const drive = driveOf(ctx.values.drive)
      const dest = normalizePath(ctx.positionals[ctx.positionals.length - 1]!)
      const sources = ctx.positionals.slice(0, -1).map(normalizePath)
      await drive.move(sources, dest, ctx.signal)
      return {
        data: { drive: drive.id, moved: sources, dest, async: drive.capabilities.asyncMove },
        ...(drive.capabilities.asyncMove
          ? { warnings: ['百度是异步任务，这里只提交成功；要确认结果再跑一次 `cloud ls`'] }
          : {}),
      }
    },
  },
  {
    name: 'cloud rm',
    summary: '删除（进回收站，可恢复）',
    usage: 'astra cloud rm <路径...> [--drive quark|baidu] [--yes]',
    notes: ['两家网盘的删除都是进回收站，不是永久删。非交互环境必须带 --yes。'],
    options: {
      drive: { type: 'string', description: '哪个网盘：quark / baidu', valueName: 'name' },
      yes: { type: 'boolean', description: '确认删除' },
    },
    minArgs: 1,
    run: async (ctx): Promise<CommandResult> => {
      const drive = driveOf(ctx.values.drive)
      const paths = ctx.positionals.map(normalizePath)
      if (ctx.values.yes !== true) {
        return {
          data: { dry_run: true, would_delete: paths, drive: drive.id },
          warnings: ['没带 --yes，只列了清单；确认后加 --yes 再跑一次'],
        }
      }
      await drive.remove(paths, ctx.signal)
      return { data: { drive: drive.id, deleted: paths, trash: true } }
    },
  },
  {
    name: 'cloud get',
    summary: '下载网盘里的文件到本地',
    usage: 'astra cloud get <路径> --out <本地文件或目录> [--drive quark|baidu]',
    notes: [
      '--out 给目录时用原文件名。',
      '百度非会员限速很狠（几十 KB/s），这个域主要用来整理，不当作主力下载源。',
    ],
    options: {
      drive: { type: 'string', description: '哪个网盘：quark / baidu', valueName: 'name' },
      out: { type: 'string', description: '落盘路径（文件或目录）', valueName: 'path' },
    },
    minArgs: 1,
    maxArgs: 1,
    run: async (ctx): Promise<CommandResult> => {
      const drive = driveOf(ctx.values.drive)
      const path = normalizePath(ctx.positionals[0]!)
      const node = await drive.stat(path, ctx.signal)
      if (!node) throw new AstraError('CLOUD_NOT_FOUND', `网盘里找不到：${path}`, { exitCode: 4 })
      if (node.dir) throw invalidInput('这是目录，不能直接下载', '用 `cloud ls` 看里面有什么，再逐个 get')
      const outArg = typeof ctx.values.out === 'string' ? ctx.values.out : ''
      if (!outArg) throw invalidInput('缺少 --out', 'astra cloud get <路径> --out /path/to/file')
      const isDirTarget = outArg.endsWith('/') || !/\.[A-Za-z0-9]{1,8}$/.test(outArg)
      const dest = isDirTarget ? `${outArg.replace(/\/$/, '')}/${node.name}` : outArg
      const target = await drive.downloadTarget(node, ctx.signal)
      await mkdirFs(dirname(dest), { recursive: true })
      const response = await fetch(target.url, { headers: target.headers, signal: ctx.signal })
      if (!response.ok || !response.body) {
        throw new AstraError('CLOUD_DOWNLOAD_FAILED', `下载失败：HTTP ${response.status}`, {
          exitCode: 5,
          retryable: response.status >= 500,
        })
      }
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(dest))
      return { data: { drive: drive.id, saved: dest, bytes: node.size, source: path } }
    },
  },
  {
    name: 'cloud login',
    summary: '配置网盘凭证（夸克 cookie / 百度 access_token）',
    usage: 'astra cloud login <quark|baidu> <凭证>',
    notes: [
      '夸克：整段 pan.quark.cn 的 cookie。',
      '百度：OAuth2 的 access_token（30 天有效）；刷新令牌请用 `--refresh`。',
      '凭证只落在 <ASTRA_HOME>/cloud-<id>.json（600），不会回显完整值。',
    ],
    options: {
      refresh: { type: 'string', description: '百度 refresh_token（可选，用于续期记录）', valueName: 'token' },
      cookie: { type: 'boolean', description: '百度：把参数当 cookie 存（只能列目录/整理，不能下载直链）' },
      'app-key': { type: 'string', description: '百度：开放平台 AppKey（存起来，供 cloud auth-url 生成授权链接）', valueName: 'key' },
    },
    minArgs: 2,
    maxArgs: 2,
    run: async (ctx): Promise<CommandResult> => {
      const id = String(ctx.positionals[0]).toLowerCase() as CloudId
      if (!DRIVES[id]) throw invalidInput(`不认识的网盘：${ctx.positionals[0]}`, '可选：quark / baidu')
      const secret = ctx.positionals[1]!.trim()
      if (!secret) throw invalidInput('凭证是空的')
      // 百度两种凭证：OAuth access_token（能下载）或整段 cookie（只能列目录/整理）。
      // 自动识别：带 BDUSS= 的当 cookie，否则当 token。
      const looksCookie = /BDUSS=|STOKEN=/.test(secret)
      const asCookie = id === 'quark' || ctx.values.cookie === true || looksCookie
      const appKey = typeof ctx.values['app-key'] === 'string' ? ctx.values['app-key'] : undefined
      const cred = asCookie
        ? { cookie: secret, ...(appKey ? { appKey } : {}) }
        : {
            accessToken: secret,
            ...(typeof ctx.values.refresh === 'string' ? { refreshToken: ctx.values.refresh } : {}),
            ...(appKey ? { appKey } : {}),
          }
      const saved = saveCloudCredential(id, cred)
      return {
        data: {
          drive: id,
          saved: true,
          savedAt: saved.savedAt,
          preview: maskSecret(saved.accessToken ?? saved.cookie),
          kind: saved.accessToken ? 'access_token' : 'cookie',
          hasRefresh: Boolean(saved.refreshToken),
        },
      }
    },
  },
  {
    name: 'cloud status',
    summary: '看各网盘凭证状态（不回显完整值）',
    usage: 'astra cloud status',
    run: async (): Promise<CommandResult> => {
      const rows = (['quark', 'baidu'] as CloudId[]).map((id) => {
        const cred = loadCloudCredential(id)
        // 夸克老版本把 cookie 存在 quark.json，这里做兼容，避免"明明能用却显示未配置"
        const secret = id === 'quark' ? (cred?.cookie ?? loadQuarkCookie() ?? undefined) : cred?.accessToken
        return {
          drive: id,
          configured: Boolean(secret),
          preview: maskSecret(secret),
          savedAt: cred?.savedAt ?? null,
        }
      })
      return {
        data: { drives: rows },
        table: {
          headers: ['网盘', '已配置', '凭证', '保存时间'],
          rows: rows.map((r) => [r.drive, r.configured ? '是' : '否', r.preview, r.savedAt ?? '-']),
        },
      }
    },
  },
  {
    name: 'cloud logout',
    summary: '清掉某个网盘的本地凭证',
    usage: 'astra cloud logout <quark|baidu>',
    minArgs: 1,
    maxArgs: 1,
    run: async (ctx): Promise<CommandResult> => {
      const id = String(ctx.positionals[0]).toLowerCase() as CloudId
      if (!DRIVES[id]) throw invalidInput(`不认识的网盘：${ctx.positionals[0]}`, '可选：quark / baidu')
      const removed = clearCloudCredential(id)
      return { data: { drive: id, removed } }
    },
  },
]

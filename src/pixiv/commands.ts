/**
 * `astra pixiv ...`：Pixiv 的查询与单作品下载。
 *
 * 落盘规范跟媒体库其他部分一致：**只存不可变标识**——
 * `<pixiv.dir>/<userId>/<illustId>_p<N>.<ext>`，不建系列目录、不存标题快照。
 *
 * 这一批只做「查得到 + 单作品下得下来」，画师全量 / 订阅留到后面加，
 * 免得一次铺太开、把上游改动撞得稀碎。
 */
import { existsSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AstraError, invalidInput } from '../core/errors.ts'
import type { Command } from '../core/command.ts'
import { getConfig } from '../core/config.ts'
import {
  clearCookie,
  cookieDigest,
  downloadImage,
  illustDetail,
  loadCookie,
  pageUrls,
  ranking,
  saveCookie,
  searchWorks,
  userWorks,
  type RankMode,
} from './api.ts'

const RANK_MODES: RankMode[] = ['daily', 'weekly', 'monthly', 'rookie', 'original', 'male', 'female']

function num(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw invalidInput(`${label} 必须是 ${min}..${max} 的整数`)
  return n
}

function requireId(raw: string | undefined, label: string): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw invalidInput(`${label} 要是正整数`, 'pixiv 的 id 是纯数字，比如 123456789')
  }
  return n
}

/** 落盘根目录：`--out` > `pixiv.dir` > 报错。没有默认值是有意的。 */
function resolveDir(out: unknown): string {
  if (typeof out === 'string' && out.trim()) return out.trim()
  const configured = getConfig('pixiv.dir').trim()
  if (configured) return configured
  throw new AstraError('NO_OUTPUT_DIR', '没有指定落盘目录', {
    exitCode: 2,
    hint: '`astra config set pixiv.dir /host-root/volume1/图片/pixiv`，或本次用 `--out <目录>`',
  })
}

const info: Command = {
  name: 'pixiv info',
  summary: '看单个作品详情（作者、页数、尺寸、标签、是否 R-18）',
  usage: 'astra pixiv info <illustId>',
  notes: [
    '只读，不下载。R-18 作品会照实返回 xRestrict=1，但 `pull` 默认跳过。',
    '拿不到详情通常是作品已删除或仅登录可见（需要 `pixiv cookie set`）。',
  ],
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const id = requireId(positionals[0], 'illustId')
    const d = await illustDetail(id)
    return {
      data: {
        illustId: Number(d.id),
        title: d.title,
        userId: Number(d.userId),
        userName: d.userName,
        pages: d.pageCount,
        size: `${d.width}x${d.height}`,
        xRestrict: d.xRestrict,
        r18: d.xRestrict > 0,
        tags: d.tags,
        original: d.urls.original,
      },
    }
  },
}

const rank: Command = {
  name: 'pixiv rank',
  summary: '排行榜作品 id 列表（daily / weekly / monthly / rookie …）',
  usage: 'astra pixiv rank [--mode daily] [--pages 1] [--limit 50]',
  notes: ['只返回 id 和作者，要看详情用 `pixiv info <id>`；要下载用 `pixiv pull <id>`。'],
  options: {
    mode: { type: 'string', description: `榜种，默认 daily；可选 ${RANK_MODES.join(' / ')}`, valueName: 'm' },
    pages: { type: 'string', description: '翻几页（每页 50），默认 1', valueName: 'n' },
    limit: { type: 'string', description: '最多返回多少条，默认 50', valueName: 'n' },
  },
  maxArgs: 0,
  async run({ values }) {
    const mode = (typeof values.mode === 'string' ? values.mode : 'daily') as RankMode
    if (!RANK_MODES.includes(mode)) throw invalidInput(`不认识的榜种：${mode}`, `可选 ${RANK_MODES.join(' / ')}`)
    const pages = num(values.pages, 1, 1, 10, '--pages')
    const limit = num(values.limit, 50, 1, 200, '--limit')
    const ids = (await ranking(mode, pages)).slice(0, limit)
    return {
      data: { mode, count: ids.length, illustIds: ids },
      table: { headers: ['#', 'illustId'], rows: ids.map((id, i) => [i + 1, id]) },
    }
  },
}

const user: Command = {
  name: 'pixiv user',
  summary: '看画师的作品 id 列表（插画 + 漫画，新的在前）',
  usage: 'astra pixiv user <userId> [--limit 20]',
  notes: ['只读，返回 id 列表；批量下载留到 `pixiv pull` 后续扩展。'],
  options: {
    limit: { type: 'string', description: '最多返回多少条，默认 20', valueName: 'n' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    const uid = requireId(positionals[0], 'userId')
    const limit = num(values.limit, 20, 1, 500, '--limit')
    const all = await userWorks(uid)
    const ids = all.slice(0, limit)
    return {
      data: { userId: uid, total: all.length, count: ids.length, illustIds: ids },
      table: { headers: ['#', 'illustId'], rows: ids.map((id, i) => [i + 1, id]) },
    }
  },
}

const search: Command = {
  name: 'pixiv search',
  summary: '按关键词搜作品（按时间倒序）',
  usage: 'astra pixiv search <关键词> [--page 1] [--limit 20]',
  options: {
    page: { type: 'string', description: '页码，默认 1', valueName: 'n' },
    limit: { type: 'string', description: '最多返回多少条，默认 20', valueName: 'n' },
  },
  minArgs: 1,
  async run({ positionals, values }) {
    const keyword = positionals.join(' ')
    const page = num(values.page, 1, 1, 100, '--page')
    const limit = num(values.limit, 20, 1, 100, '--limit')
    const ids = (await searchWorks(keyword, page)).slice(0, limit)
    return {
      data: { keyword, page, count: ids.length, illustIds: ids },
      table: { headers: ['#', 'illustId'], rows: ids.map((id, i) => [i + 1, id]) },
    }
  },
}

const pull: Command = {
  name: 'pixiv pull',
  summary: '下载单个作品的全部页（原图优先，失败回落 1200px）',
  usage: 'astra pixiv pull <illustId> [--out 目录] [--r18] [--dry]',
  notes: [
    '落盘 `<目录>/<userId>/<illustId>_p<N>.<ext>`，已存在的文件跳过（只认 id + 页号）。',
    'R-18 作品默认跳过，要下得显式加 `--r18`。',
    '目录优先 `--out`，其次 `pixiv.dir`；两者都没配会直接报错，不会瞎写到一个默认路径。',
  ],
  options: {
    out: { type: 'string', description: '落盘目录（覆盖 pixiv.dir）', valueName: 'dir' },
    r18: { type: 'boolean', description: '允许下载 R-18 作品（默认跳过）' },
    dry: { type: 'boolean', description: '只打印会写哪些文件，不真下' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    const id = requireId(positionals[0], 'illustId')
    const dir = resolveDir(values.out)
    const detail = await illustDetail(id)
    if (detail.xRestrict > 0 && values.r18 !== true) {
      throw new AstraError('R18_BLOCKED', '这是 R-18 作品，默认不下载', {
        exitCode: 4,
        hint: '确实要下就加 `--r18`',
        details: { illustId: id, xRestrict: detail.xRestrict },
      })
    }
    const pages = pageUrls(detail)
    const target = join(dir, detail.userId)
    const planned = pages.map((p) => join(target, `${detail.id}_p${p.page}.${p.ext}`))

    if (values.dry === true) {
      return { data: { illustId: id, userId: Number(detail.userId), pages: pages.length, dry: true, files: planned } }
    }

    await mkdir(target, { recursive: true })
    const downloaded: string[] = []
    const skipped: string[] = []
    const failed: { file: string; error: string }[] = []

    for (let i = 0; i < pages.length; i += 1) {
      const page = pages[i]!
      const file = planned[i]!
      if (existsSync(file) && statSync(file).size > 0) {
        skipped.push(file)
        continue
      }
      try {
        let buf: Buffer
        try {
          buf = await downloadImage(page.original)
        } catch {
          // 原图偶尔 403/404，回落到 1200px 版本
          buf = await downloadImage(page.regular)
        }
        await writeFile(`${file}.part`, buf)
        await writeFile(file, buf)
        const { rm } = await import('node:fs/promises')
        await rm(`${file}.part`, { force: true })
        downloaded.push(file)
      } catch (err) {
        failed.push({ file, error: err instanceof Error ? err.message : String(err) })
      }
    }

    return {
      data: {
        illustId: id,
        title: detail.title,
        userId: Number(detail.userId),
        pages: pages.length,
        downloaded: downloaded.length,
        skipped: skipped.length,
        failed: failed.length,
        files: downloaded,
        ...(failed.length ? { errors: failed } : {}),
      },
    }
  },
}

const cookieSet: Command = {
  name: 'pixiv cookie set',
  summary: '保存浏览器 cookie（可选，用于看登录可见的作品）',
  usage: 'astra pixiv cookie set "<cookie 字符串>"',
  notes: [
    '匿名就能查公开作品，cookie 只在需要看受限内容时才要。',
    '存在 <ASTRA_HOME>/pixiv-cookie.txt，权限 600；只回显有没有 PHPSESSID，不回显值。',
  ],
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const raw = positionals[0]!.trim()
    if (!raw.includes('=')) throw invalidInput('这不像 cookie 字符串', '从浏览器 DevTools 复制整行 `k=v; k2=v2`')
    saveCookie(raw)
    return { data: { saved: true, ...cookieDigest(raw) } }
  },
}

const cookieShow: Command = {
  name: 'pixiv cookie show',
  summary: '看 cookie 状态（不回显值）',
  usage: 'astra pixiv cookie show',
  maxArgs: 0,
  async run() {
    const raw = loadCookie()
    return { data: { configured: Boolean(raw), ...cookieDigest(raw) } }
  },
}

const cookieClear: Command = {
  name: 'pixiv cookie clear',
  summary: '删掉保存的 cookie',
  usage: 'astra pixiv cookie clear',
  maxArgs: 0,
  async run() {
    return { data: { removed: clearCookie() } }
  },
}

export const pixivCommands: Command[] = [info, rank, user, search, pull, cookieSet, cookieShow, cookieClear]

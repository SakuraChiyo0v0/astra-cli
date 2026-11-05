/**
 * `astra heybox ...`：小黑盒社区只读查询。
 *
 * v1 只做匿名可用的两条：首页信息流、全站搜索。
 * 帖子详情/评论（`/bbs/app/link/tree`）匿名会被要求人机验证，等接了登录态再加。
 */
import type { Command } from '../core/command.ts'
import { invalidInput } from '../core/errors.ts'
import { okResult } from '../core/output.ts'
import { listFeeds, mapLink, searchLinks, getLinkTree, fetchSession } from './api.ts'
import { clearCredential, loadCredential, saveCredential } from './auth.ts'

function num(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) {
    throw invalidInput(`${name} 必须是 ${min}..${max} 的整数`, `收到：${String(value)}`)
  }
  return Math.trunc(n)
}

const feed: Command = {
  name: 'heybox feed',
  summary: '小黑盒首页信息流（帖子列表）',
  usage: 'astra heybox feed [--limit 20] [--offset 0]',
  notes: ['匿名接口，不需要登录；返回 linkId / 标题 / 摘要 / 赞 / 评论数 / 话题。'],
  options: {
    limit: { type: 'string', description: '取多少条，默认 20，上限 50', valueName: 'n' },
    offset: { type: 'string', description: '偏移，翻页用', valueName: 'n' },
  },
  maxArgs: 0,
  async run({ values }) {
    const limit = num(values.limit, 20, 1, 50, '--limit')
    const offset = num(values.offset, 0, 0, 10_000, '--offset')
    const items = (await listFeeds(limit, offset)).map(mapLink)
    return {
      ...okResult({ count: items.length, offset, items }),
      table: {
        headers: ['linkId', '标题', '话题', '赞', '评论', '时间'],
        rows: items.map((i) => [
          String(i.linkId ?? ''),
          String(i.title ?? '').slice(0, 34),
          String(i.topic ?? '-'),
          String(i.up ?? 0),
          String(i.comments ?? 0),
          String(i.createdAt ?? '-'),
        ]),
      },
    }
  },
}

const search: Command = {
  name: 'heybox search',
  summary: '搜小黑盒社区帖子（攻略、评测、资讯）',
  usage: 'astra heybox search <关键词> [--limit 20] [--offset 0]',
  notes: [
    '匿名接口。结果只保留帖子类，过滤掉「相关游戏 / 筛选器」这些占位块。',
    '关键词可以是游戏名、攻略主题，中文直接传，不用转义。',
  ],
  options: {
    limit: { type: 'string', description: '取多少条，默认 20，上限 50', valueName: 'n' },
    offset: { type: 'string', description: '偏移，翻页用', valueName: 'n' },
  },
  minArgs: 1,
  maxArgs: 10,
  async run({ positionals, values }) {
    const keyword = positionals.join(' ').trim()
    if (!keyword) throw invalidInput('要给搜索关键词', '例：astra heybox search 艾尔登法环')
    const limit = num(values.limit, 20, 1, 50, '--limit')
    const offset = num(values.offset, 0, 0, 10_000, '--offset')
    const items = (await searchLinks(keyword, limit, offset)).map(mapLink)
    return {
      ...okResult({ keyword, count: items.length, offset, items }),
      table: {
        headers: ['linkId', '标题', '话题', '赞', '评论', '时间'],
        rows: items.map((i) => [
          String(i.linkId ?? ''),
          String(i.title ?? '').slice(0, 34),
          String(i.topic ?? '-'),
          String(i.up ?? 0),
          String(i.comments ?? 0),
          String(i.createdAt ?? '-'),
        ]),
      },
    }
  },
}

const LOGIN_HINT = '浏览器打开 xiaoheihe.cn → F12 → Network → 任一请求的 Cookie 整条复制'

/** 登录态下的请求之间至少隔 5 秒：小黑盒写/读详情接口频率高了就弹验证码。 */
let lastAuthedAt = 0
async function throttle(): Promise<void> {
  const gap = 5000 - (Date.now() - lastAuthedAt)
  if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap))
  lastAuthedAt = Date.now()
}

function mask(cookie: string): string {
  return cookie.length <= 24 ? '***' : `${cookie.slice(0, 8)}…${cookie.slice(-6)}（${cookie.length} 字符）`
}

const login: Command = {
  name: 'heybox login',
  summary: '保存小黑盒登录 cookie（600 权限，供帖子详情/评论用）',
  usage: 'astra heybox login <cookie 字符串>',
  notes: [
    '整条 cookie 一起传（`k=v; k2=v2`），只存本机 ASTRA_HOME/heybox.json，权限 600。',
    `从哪拿：${LOGIN_HINT}`,
    '存完会用「消息列表」这条最轻的接口验一次登录态。',
  ],
  minArgs: 1,
  maxArgs: 40,
  async run({ positionals }) {
    const raw = positionals.join(' ')
    const cred = saveCredential(raw)
    const session = await fetchSession(cred).catch(() => ({ loggedIn: false, heyboxId: cred.heyboxId }))
    return {
      ...okResult({
        saved: true,
        loggedIn: session.loggedIn,
        heyboxId: session.heyboxId || null,
        cookie: mask(cred.cookie),
      }),
      table: {
        headers: ['项', '值'],
        rows: [
          ['cookie', mask(cred.cookie)],
          ['heybox_id', session.heyboxId || '（未识别，不影响读取）'],
          ['登录态', session.loggedIn ? '有效' : '未验证通过（可能已过期）'],
        ],
      },
    }
  },
}

const status: Command = {
  name: 'heybox status',
  summary: '看小黑盒登录态',
  usage: 'astra heybox status',
  maxArgs: 0,
  async run() {
    const cred = loadCredential()
    if (!cred) {
      return {
        ...okResult({ loggedIn: false, saved: false }),
        table: { headers: ['项', '值'], rows: [['登录态', '未登录（只读接口仍可用）']] },
      }
    }
    const session = await fetchSession(cred).catch(() => ({ loggedIn: false, heyboxId: cred.heyboxId }))
    return {
      ...okResult({
        saved: true,
        loggedIn: session.loggedIn,
        heyboxId: session.heyboxId || null,
        savedAt: cred.savedAt,
        cookie: mask(cred.cookie),
      }),
      table: {
        headers: ['项', '值'],
        rows: [
          ['登录态', session.loggedIn ? '有效' : '失效/未验证'],
          ['heybox_id', session.heyboxId || '-'],
          ['保存时间', cred.savedAt.slice(0, 19).replace('T', ' ')],
          ['cookie', mask(cred.cookie)],
        ],
      },
    }
  },
}

const logout: Command = {
  name: 'heybox logout',
  summary: '清除本机保存的小黑盒 cookie',
  usage: 'astra heybox logout',
  maxArgs: 0,
  async run() {
    const cleared = clearCredential()
    return {
      ...okResult({ cleared }),
      table: { headers: ['项', '值'], rows: [['cookie', cleared ? '已清除' : '本来就没有']] },
    }
  },
}

const post: Command = {
  name: 'heybox post',
  summary: '看单个帖子：正文 + 图片 + 首屏评论（需登录）',
  usage: 'astra heybox post <linkId> [--comments 10]',
  notes: ['需要 `heybox login` 保存过 cookie；匿名调用会被人机验证拦下。', '请求间自动限速 5 秒。'],
  options: {
    comments: { type: 'string', description: '带多少条评论，默认 10，0 表示只看正文', valueName: 'n' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    const cred = loadCredential()
    if (!cred) throw invalidInput('没有登录态', '先跑 astra heybox login <cookie>')
    const linkId = requireLinkId(positionals[0])
    const limit = num(values.comments, 10, 0, 50, '--comments')
    await throttle()
    const { link, comments } = await getLinkTree(linkId, { limit: Math.max(limit, 1), credential: cred })
    if (!link) throw invalidInput('没拿到帖子', '链接 id 可能不存在，或登录态已失效')

    const text = cleanText(String(link.text ?? link.description ?? ''))
    const images = (link.imgs as string[] | undefined) ?? []
    const picked = comments.slice(0, limit).map((c) => ({
      user: String((c.user as Record<string, unknown> | undefined)?.username ?? ''),
      text: cleanText(String(c.text ?? '')),
      up: Number((c.up as number | undefined) ?? 0),
      floor: Number((c.floor as number | undefined) ?? 0),
    }))
    const data = {
      linkId,
      title: cleanText(String(link.title ?? '')),
      author: String((link.user as Record<string, unknown> | undefined)?.username ?? ''),
      topic: (link.topics as Array<{ name?: string }> | undefined)?.[0]?.name ?? null,
      text,
      images,
      up: Number(link.up ?? 0),
      comments: Number(link.comment_num ?? 0),
      createdAt: link.create_at ? new Date(Number(link.create_at) * 1000).toISOString().slice(0, 16).replace('T', ' ') : null,
      url: `https://www.xiaoheihe.cn/app/bbs/link/${linkId}`,
      commentPreview: picked,
    }
    return {
      ...okResult(data),
      table: {
        headers: ['项', '值'],
        rows: [
          ['标题', data.title.slice(0, 40)],
          ['作者', data.author || '-'],
          ['话题', data.topic ?? '-'],
          ['赞/评论', `${data.up} / ${data.comments}`],
          ['图片', String(images.length)],
          ['时间', data.createdAt ?? '-'],
        ],
      },
    }
  },
}

const comments: Command = {
  name: 'heybox comments',
  summary: '看帖子评论区（需登录）',
  usage: 'astra heybox comments <linkId> [--limit 20] [--page 1]',
  notes: ['需要 `heybox login`；分页从 1 开始，每页最多 50 条。'],
  options: {
    limit: { type: 'string', description: '每页多少条，默认 20，上限 50', valueName: 'n' },
    page: { type: 'string', description: '页码，默认 1', valueName: 'n' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    const cred = loadCredential()
    if (!cred) throw invalidInput('没有登录态', '先跑 astra heybox login <cookie>')
    const linkId = requireLinkId(positionals[0])
    const limit = num(values.limit, 20, 1, 50, '--limit')
    const page = num(values.page, 1, 1, 200, '--page')
    await throttle()
    const { comments: raw } = await getLinkTree(linkId, { page, limit, credential: cred })
    const items = raw.map((c) => ({
      user: String((c.user as Record<string, unknown> | undefined)?.username ?? ''),
      text: cleanText(String(c.text ?? '')),
      up: Number((c.up as number | undefined) ?? 0),
      floor: Number((c.floor as number | undefined) ?? 0),
    }))
    return {
      ...okResult({ linkId, page, count: items.length, items }),
      table: {
        headers: ['#', '用户', '内容', '赞'],
        rows: items.map((i, idx) => [String(idx + 1), i.user.slice(0, 14), i.text.slice(0, 46), String(i.up)]),
      },
    }
  },
}

function requireLinkId(raw: string | undefined): string {
  const value = String(raw ?? '').trim()
  const fromUrl = value.match(/link\/(\d+)/)?.[1]
  const id = fromUrl ?? value
  if (!/^\d+$/.test(id)) throw invalidInput('linkId 要是纯数字', '可以直接粘帖子 URL，会自动取末尾 id')
  return id
}

function cleanText(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[cube_[^\]]+\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const heyboxCommands: Command[] = [feed, search, login, status, logout, post, comments]

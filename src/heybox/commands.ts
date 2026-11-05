/**
 * `astra heybox ...`：小黑盒社区只读查询。
 *
 * v1 只做匿名可用的两条：首页信息流、全站搜索。
 * 帖子详情/评论（`/bbs/app/link/tree`）匿名会被要求人机验证，等接了登录态再加。
 */
import type { Command } from '../core/command.ts'
import { invalidInput } from '../core/errors.ts'
import { okResult } from '../core/output.ts'
import { listFeeds, mapLink, searchLinks } from './api.ts'

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

export const heyboxCommands: Command[] = [feed, search]

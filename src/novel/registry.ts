/**
 * 书源注册与「输入 → 哪本书」的解析。
 *
 * 搜索结果排序：书名完全一致 > 以关键词开头 > 包含；同级按书名长度、再按书源顺序。
 * 比较前统一成简体、去标点（`normalizeTitle`），所以「活著」能命中「活着」。
 */
import { AstraError, invalidInput } from '../core/errors.ts'
import { progress } from '../core/output.ts'
import { eightnovel } from './sources/eightnovel.ts'
import { kanunu } from './sources/kanunu.ts'
import { lnovel } from './sources/lnovel.ts'
import type { NovelSource, SearchHit } from './sources/types.ts'
import { normalizeTitle } from './text.ts'

/** 顺序 = 搜索顺序 = 同分时的优先级。 */
export const SOURCES: NovelSource[] = [eightnovel, lnovel, kanunu]

/** 对外的书源名（--source 用）。内部 id 用 `eightnovel` 是为了做合法标识符。 */
export const SOURCE_ALIASES: Record<string, string> = { '8novel': 'eightnovel', eightnovel: 'eightnovel', lnovel: 'lnovel', kanunu: 'kanunu' }

export function sourceByName(name: string): NovelSource {
  const id = SOURCE_ALIASES[name.trim().toLowerCase()]
  const source = SOURCES.find((s) => s.name === name || (id && sourceId(s) === id))
  if (!source) throw invalidInput(`没有这个书源：${name}`, `可用：${SOURCES.map((s) => s.name).join(' / ')}`)
  return source
}

/** 存库 / 任务 meta 里用的稳定 id。 */
export function sourceId(source: NovelSource): string {
  return SOURCE_ALIASES[source.name] ?? source.name
}

export function sourceById(id: string): NovelSource {
  const source = SOURCES.find((s) => sourceId(s) === id)
  if (!source) throw new AstraError('INTERNAL', `未知书源 id：${id}`, { exitCode: 1 })
  return source
}

export interface Ref {
  source: NovelSource
  id: string
}

/** 链接 / 书号 → 书；认不出返回 null（交给搜索）。 */
export function matchRef(input: string, only?: NovelSource): Ref | null {
  const pool = only ? [only] : SOURCES
  for (const source of pool) {
    const id = source.match(input.trim())
    if (id) return { source, id }
  }
  if (/^https?:\/\//.test(input.trim())) {
    throw invalidInput(`不认识这个链接：${input.slice(0, 80)}`, `支持的书源：${SOURCES.map((s) => s.name).join(' / ')}`)
  }
  return null
}

export function rankHits(keyword: string, hits: SearchHit[]): SearchHit[] {
  const kw = normalizeTitle(keyword)
  const order = new Map(SOURCES.map((s, i) => [sourceId(s), i]))
  const tier = (t: string): number => (t === kw ? 0 : t.startsWith(kw) ? 1 : 2)
  return [...hits].sort((a, b) => {
    const ta = normalizeTitle(a.title)
    const tb = normalizeTitle(b.title)
    return tier(ta) - tier(tb) || ta.length - tb.length || (order.get(a.source) ?? 9) - (order.get(b.source) ?? 9)
  })
}

export interface SearchOutcome {
  hits: SearchHit[]
  /** 各书源命中数；失败的写错误原因。 */
  perSource: Record<string, number | string>
}

export async function searchAll(keyword: string, only?: NovelSource, signal?: AbortSignal): Promise<SearchOutcome> {
  const pool = only ? [only] : SOURCES
  const perSource: Record<string, number | string> = {}
  const results = await Promise.all(pool.map(async (source) => {
    try {
      const hits = await source.search(keyword, signal)
      perSource[source.name] = hits.length
      return hits
    } catch (err) {
      perSource[source.name] = (err as Error).message.slice(0, 120)
      progress('novel.search_failed', { source: source.name, error: (err as Error).message.slice(0, 120) })
      return []
    }
  }))
  return { hits: rankHits(keyword, results.flat()), perSource }
}

/** 搜索结果里展示用的书源名。 */
export function displaySource(id: string): string {
  return sourceById(id).name
}

/**
 * 书名 → 一本书。只在「书名完全一致的只有一条」时自动选；否则返回候选让调用方交给用户。
 * `pick` 给了就按序号取。
 */
export async function resolveBook(input: string, options: { source?: string; pick?: number; signal?: AbortSignal } = {}): Promise<Ref> {
  const only = options.source ? sourceByName(options.source) : undefined
  const direct = matchRef(input, only)
  if (direct) return direct
  const { hits, perSource } = await searchAll(input, only, options.signal)
  if (hits.length === 0) {
    throw new AstraError('NOT_FOUND', `没搜到「${input}」`, {
      exitCode: 4,
      hint: '换个关键词；努努书坊的书也可以直接给书页链接；索引过旧时 `astra novel index --rebuild`',
      details: { perSource },
    })
  }
  const view = hits.slice(0, 20).map((h, i) => ({ n: i + 1, source: displaySource(h.source), id: h.id, title: h.title, author: h.author }))
  if (options.pick !== undefined) {
    const hit = hits[options.pick - 1]
    if (!hit) throw invalidInput(`--pick 超出范围：共 ${hits.length} 条`)
    return { source: sourceById(hit.source), id: hit.id }
  }
  const exact = hits.filter((h) => normalizeTitle(h.title) === normalizeTitle(input))
  if (exact.length === 1) return { source: sourceById(exact[0]!.source), id: exact[0]!.id }
  throw new AstraError('AMBIGUOUS', `「${input}」有 ${hits.length} 个候选，${exact.length > 1 ? `其中 ${exact.length} 个同名` : '没有完全同名的'}`, {
    exitCode: 2,
    hint: '让用户从候选里选，再加 `--pick <n>`，或直接给书页链接',
    details: { candidates: view },
  })
}

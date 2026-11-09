/**
 * 漫画源注册与「输入 → 哪部作品」的解析。规则与小说一致：
 * 书名完全一致 > 以关键词开头 > 包含；比较前繁简统一、去标点。
 */
import { AstraError, invalidInput } from '../core/errors.ts'
import { progress } from '../core/output.ts'
import { normalizeTitle } from '../novel/text.ts'
import { copymanga } from './sources/copymanga.ts'
import { komiic } from './sources/komiic.ts'
import type { MangaSource, SearchHit } from './sources/types.ts'

/** 顺序 = 搜索结果同分时的优先级。 */
export const SOURCES: MangaSource[] = [komiic, copymanga]

export function sourceByName(name: string): MangaSource {
  const source = SOURCES.find((s) => s.name === name.trim().toLowerCase())
  if (!source) throw invalidInput(`没有这个漫画源：${name}`, `可用：${SOURCES.map((s) => s.name).join(' / ')}`)
  return source
}

export interface Ref {
  source: MangaSource
  id: string
}

export function matchRef(input: string, only?: MangaSource): Ref | null {
  for (const source of only ? [only] : SOURCES) {
    const id = source.match(input.trim())
    if (id) return { source, id }
  }
  if (/^https?:\/\//.test(input.trim())) {
    throw invalidInput(`不认识这个链接：${input.slice(0, 80)}`, `支持的源：${SOURCES.map((s) => s.name).join(' / ')}`)
  }
  return null
}

export function rankHits(keyword: string, hits: SearchHit[]): SearchHit[] {
  const kw = normalizeTitle(keyword)
  const order = new Map(SOURCES.map((s, i) => [s.name, i]))
  const tier = (t: string): number => (t === kw ? 0 : t.startsWith(kw) ? 1 : 2)
  return [...hits].sort((a, b) => {
    const ta = normalizeTitle(a.title)
    const tb = normalizeTitle(b.title)
    return tier(ta) - tier(tb) || ta.length - tb.length || (order.get(a.source) ?? 9) - (order.get(b.source) ?? 9)
  })
}

export async function searchAll(keyword: string, only?: MangaSource, signal?: AbortSignal): Promise<{ hits: SearchHit[]; perSource: Record<string, number | string> }> {
  const perSource: Record<string, number | string> = {}
  const results = await Promise.all((only ? [only] : SOURCES).map(async (source) => {
    try {
      const hits = await source.search(keyword, signal)
      perSource[source.name] = hits.length
      return hits
    } catch (err) {
      perSource[source.name] = (err as Error).message.slice(0, 120)
      progress('manga.search_failed', { source: source.name, error: (err as Error).message.slice(0, 120) })
      return []
    }
  }))
  return { hits: rankHits(keyword, results.flat()), perSource }
}

/**
 * 作品名 → 一部作品。完全同名的只有一条时自动选（多个源都有同名作品时取源顺序靠前的）；
 * 否则返回候选让调用方交给用户。
 */
export async function resolveComic(input: string, options: { source?: string; pick?: number; signal?: AbortSignal } = {}): Promise<Ref> {
  const only = options.source ? sourceByName(options.source) : undefined
  const direct = matchRef(input, only)
  if (direct) return direct
  const { hits, perSource } = await searchAll(input, only, options.signal)
  if (hits.length === 0) {
    throw new AstraError('NOT_FOUND', `没搜到「${input}」`, { exitCode: 4, hint: '换个关键词（繁简都行），或直接给作品链接', details: { perSource } })
  }
  if (options.pick !== undefined) {
    const hit = hits[options.pick - 1]
    if (!hit) throw invalidInput(`--pick 超出范围：共 ${hits.length} 条`)
    return { source: sourceByName(hit.source), id: hit.id }
  }
  const exact = hits.filter((h) => normalizeTitle(h.title) === normalizeTitle(input))
  const exactSources = new Set(exact.map((h) => h.source))
  if (exact.length > 0 && exact.length === exactSources.size) return { source: sourceByName(exact[0]!.source), id: exact[0]!.id }
  throw new AstraError('AMBIGUOUS', `「${input}」有 ${hits.length} 个候选，${exact.length > 1 ? `其中 ${exact.length} 个同名` : '没有完全同名的'}`, {
    exitCode: 2,
    hint: '让用户从候选里选，再加 `--pick <n>`，或直接给作品链接',
    details: { candidates: hits.slice(0, 20).map((h, i) => ({ n: i + 1, source: h.source, id: h.id, title: h.title, author: h.author })) },
  })
}

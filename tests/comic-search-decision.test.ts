/**
 * 搜索有歧义时只列候选，不替用户挑。用 2026-10-30 抓的真实搜索结果。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { searchDecision } from '../src/comic/commands.ts'
import type { SearchHit } from '../src/comic/client.ts'

function fixture(name: string): { total: number; redirectId: string | null; items: SearchHit[] } {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}

test('关键词搜出很多条：ambiguous，不给 pick', () => {
  const f = fixture('comic-search-multi.json')
  assert.ok(f.items.length > 1)
  const d = searchDecision(f.redirectId, f.items, f.total)
  assert.equal(d.status, 'ambiguous')
  assert.equal(d.pick, null)
  assert.match(d.next, /不要替用户挑/)
})

test('--limit 1 截成一条但全站很多条：仍是 ambiguous', () => {
  const f = fixture('comic-search-multi.json')
  const d = searchDecision(null, f.items.slice(0, 1), f.total)
  assert.equal(d.status, 'ambiguous')
  assert.equal(d.pick, null)
})

test('搜车号被上游跳转：exact，pick 是那一本', () => {
  const f = fixture('comic-search-redirect.json')
  assert.ok(f.redirectId)
  const d = searchDecision(f.redirectId, f.items, f.total)
  assert.equal(d.status, 'exact')
  assert.equal(d.pick, f.redirectId)
})

test('全站只有一条：exact', () => {
  const f = fixture('comic-search-multi.json')
  const d = searchDecision(null, f.items.slice(0, 1), 1)
  assert.equal(d.status, 'exact')
  assert.equal(d.pick, f.items[0]!.id)
})

test('没搜到：empty', () => {
  assert.equal(searchDecision(null, [], 0).status, 'empty')
})

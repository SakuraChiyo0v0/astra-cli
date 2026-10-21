/**
 * 版本判断用的是 2026-10-21 抓的真实搜索结果（tests/fixtures），不是手编的样本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decide, variantFlags } from '../src/music/match.ts'
import { toTrack, type Track } from '../src/music/netease.ts'

function fixture(name: string): { keyword: string; tracks: Track[] } {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as {
    keyword: string
    body: { result: { songs: Parameters<typeof toTrack>[0][] } }
  }
  return { keyword: raw.keyword, tracks: raw.body.result.songs.map(toTrack) }
}

test('晴天 周杰伦：原唱已下架，前排全是翻唱 → 必须问，不能直接下', () => {
  const { keyword, tracks } = fixture('search-qingtian.json')
  const d = decide(keyword, tracks)
  assert.equal(d.pick, null)
  assert.ok(d.candidates.length > 0)
})

test('アイドル YOASOBI：单曲版直接选中，专辑版作为其它版本', () => {
  const { keyword, tracks } = fixture('search-idol.json')
  const d = decide(keyword, tracks)
  assert.equal(d.pick?.track.id, '2034742057')
  assert.ok(d.alternatives.some((c) => c.track.id === '2083870325'))
})

test('光年之外 邓紫棋：原版明确，热爱版 / Live / 重生版都不算同一首', () => {
  const { keyword, tracks } = fixture('search-guangnian.json')
  const d = decide(keyword, tracks)
  assert.equal(d.pick?.track.id, '449818741')
  assert.ok(!d.alternatives.some((c) => /live|热爱|重生/i.test(c.track.title)))
})

test('海阔天空 Beyond：多张精选同名同歌手，选一个并给出其它专辑版本', () => {
  const { keyword, tracks } = fixture('search-haikuo.json')
  const d = decide(keyword, tracks)
  assert.ok(d.pick, d.reason)
  assert.equal(d.pick.track.title, '海阔天空')
  // 精选集排在搜索前面，但应该选原专辑《乐与怒》（1993-05-30）
  assert.equal(d.pick.track.id, '347351')
  assert.ok(d.alternatives.length >= 1)
  assert.ok(d.alternatives.every((c) => !/live/i.test(c.track.title)))
})

test('起风了（不带歌手）：买辣椒版与周深版都是热门原创向 → 问', () => {
  const { keyword, tracks } = fixture('search-qifengle.json')
  const d = decide(keyword, tracks)
  assert.equal(d.pick, null)
  const ids = d.candidates.map((c) => c.track.id)
  assert.ok(ids.includes('1330348068') && ids.includes('1475596788'))
})

test('版本标记识别', () => {
  const base = { id: '1', artists: ['x'], album: null, albumId: null, durationMs: 200_000, coverUrl: null, aliases: [], translations: [], trackNo: null, discNo: null, publishTime: null, popularity: null, fee: null }
  assert.deepEqual(variantFlags({ ...base, title: '海阔天空 (Live)' }), ['Live'])
  assert.deepEqual(variantFlags({ ...base, title: '起风了 (伴奏)' }), ['伴奏'])
  assert.ok(variantFlags({ ...base, title: '晴天 (原唱 周杰伦)' }).includes('翻唱'))
  assert.ok(variantFlags({ ...base, title: '起风了(DJ版)' }).includes('Remix'))
  assert.deepEqual(variantFlags({ ...base, title: '光年之外' }), [])
})

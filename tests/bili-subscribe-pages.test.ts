/**
 * 订阅的分 P 规划（P0#1）。
 *
 * 线上踩到的真实问题：`BV1GEn26uEDT` 有 P1「绿色」+ P2「纯享版」，
 * 订阅只落了 P1，而且**因为基线只记 bvid，P2 永远不会再被补**。
 *
 * 所以这里钉两件事：
 * 1. 新视频默认下**全部**分 P
 * 2. **老视频后来新增的分 P 也能被发现** —— 这是只记 bvid 做不到的
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planPages, type SeenPages } from '../src/bili/subscribe.ts'

const pagesOf = (bvid: string, count: number): { cid: number; page: number }[] =>
  Array.from({ length: count }, (_, i) => ({ cid: 1000 + i, page: i + 1 }))

const current = (...bvids: string[]): { bvid: string; title: string }[] =>
  bvids.map((b) => ({ bvid: b, title: `视频 ${b}` }))

test('新视频默认下全部分 P（不是只 P1）', () => {
  const { tasks } = planPages(
    current('BV1new'),
    new Map([['BV1new', pagesOf('BV1new', 2)]]),
    ['BV1old'],
    { BV1old: [1] },
    { pagesMode: 'all' },
  )
  assert.deepEqual(tasks.map((t) => t.page), [1, 2], '两个分 P 都该排进任务')
})

test('pagesMode=first 时只下 P1', () => {
  const { tasks } = planPages(
    current('BV1new'),
    new Map([['BV1new', pagesOf('BV1new', 3)]]),
    ['BV1old'],
    { BV1old: [1] },
    { pagesMode: 'first' },
  )
  assert.deepEqual(tasks.map((t) => t.page), [1])
})

test('老视频补了新分 P 能被发现并只补缺的那个（P0#1 的核心）', () => {
  // 线上原样：BV1GEn26uEDT 进了基线、只下过 P1，后来发现它其实有 2 个 P
  const { tasks } = planPages(
    current('BV1GEn26uEDT'),
    new Map([['BV1GEn26uEDT', pagesOf('BV1GEn26uEDT', 2)]]),
    ['BV1GEn26uEDT'],
    { BV1GEn26uEDT: [1] },
    { pagesMode: 'all' },
  )
  assert.equal(tasks.length, 1, '只该补 P2')
  assert.equal(tasks[0]!.page, 2)
  assert.equal(tasks[0]!.bvid, 'BV1GEn26uEDT')
})

test('老视频分 P 齐全时不重复下载', () => {
  const { tasks } = planPages(
    current('BV1done'),
    new Map([['BV1done', pagesOf('BV1done', 2)]]),
    ['BV1done'],
    { BV1done: [1, 2] },
    { pagesMode: 'all' },
  )
  assert.deepEqual(tasks, [], '都下过了就不该再排')
})

test('老数据没有分 P 记录时当作已下全部，不批量重下', () => {
  // 升级前建的订阅只有 bvid 基线，没见过 seenPages
  const { tasks } = planPages(
    current('BV1legacy'),
    new Map([['BV1legacy', pagesOf('BV1legacy', 3)]]),
    ['BV1legacy'],
    {},
    { pagesMode: 'all' },
  )
  assert.deepEqual(tasks, [], '默认不重下；要核对存量得显式 --rescan-pages')
})

test('--rescan-pages 才对存量基线重新核对', () => {
  const { tasks } = planPages(
    current('BV1legacy'),
    new Map([['BV1legacy', pagesOf('BV1legacy', 3)]]),
    ['BV1legacy'],
    {},
    { pagesMode: 'all', rescanPages: true },
  )
  assert.deepEqual(tasks.map((t) => t.page), [1, 2, 3], '重新核对时该把全部 P 都排上')
})

test('第一次检查（空基线）只记基线，不排任务', () => {
  const { tasks, baseline } = planPages(
    current('BV1', 'BV2'),
    new Map([['BV1', pagesOf('BV1', 2)], ['BV2', pagesOf('BV2', 1)]]),
    [],
    {},
    { pagesMode: 'all' },
  )
  assert.equal(baseline, true)
  assert.deepEqual(tasks, [])
})

test('查不到分 P 的视频直接跳过，不让整次检查失败', () => {
  const { tasks } = planPages(
    current('BV1unknown', 'BV1ok'),
    new Map([['BV1ok', pagesOf('BV1ok', 1)]]),
    ['BV1seed'],
    { BV1seed: [1] },
    { pagesMode: 'all' },
  )
  assert.deepEqual(tasks.map((t) => t.bvid), ['BV1ok'])
})

test('SeenPages 的记录是按 P 号（1-based），不是 pageIndex', () => {
  const seen: SeenPages = { BV1x: [1] }
  const { tasks } = planPages(
    current('BV1x'),
    new Map([['BV1x', pagesOf('BV1x', 2)]]),
    ['BV1x'],
    seen,
    { pagesMode: 'all' },
  )
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.page, 2, 'P1 下过了，只补 P2')
})

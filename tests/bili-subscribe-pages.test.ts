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

test('没有分 P 记录 = 一页都没下过（不是"全都下过"）', () => {
  // 这正是 P0#1b 的根因：旧实现把"记录缺失"当成"已完成"，
  // 于是 --rescan-pages 清空记录后反而什么都不补
  const { tasks } = planPages(
    current('BV1legacy'),
    new Map([['BV1legacy', pagesOf('BV1legacy', 3)]]),
    ['BV1legacy'],
    {},
    { pagesMode: 'all' },
  )
  assert.deepEqual(tasks.map((t) => t.page), [1, 2, 3], '没有记录就该全补')
})

test('记录存在但为空数组也按"一页都没下过"处理', () => {
  const { tasks } = planPages(
    current('BV1x'),
    new Map([['BV1x', pagesOf('BV1x', 2)]]),
    ['BV1x'],
    { BV1x: [] },
    { pagesMode: 'all' },
  )
  assert.deepEqual(tasks.map((t) => t.page), [1, 2])
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

test('复现 P0#1b：set --rescan-pages 之后 run 能补回 P2', () => {
  // 用户报的完整操作序列：
  //   astra bili subscribe set b0e020c5 --rescan-pages   → seen_pages 清成 {}
  //   astra bili subscribe run --force --id b0e020c5     → 期望补回 P2
  //
  // v0.12.15 断在这里：run 只给"有 seenPages 记录的" bvid 查 pages，
  // 清空后一个都不查 → planPages 拿到空 pages → 跳过 → "没有新视频"。
  const clearedSeenPages = {}                                   // set --rescan-pages 的结果
  const lastSeen = ['BV1GEn26uEDT']                             // bvid 仍在基线里
  const pagesByBvid = new Map([['BV1GEn26uEDT', [{ cid: 1, page: 1 }, { cid: 2, page: 2 }]]])

  const { tasks } = planPages(
    current('BV1GEn26uEDT'),
    pagesByBvid,
    lastSeen,
    clearedSeenPages,
    { pagesMode: 'all' },
  )
  assert.equal(tasks.length, 2, `清空后应当把两个分 P 都排上，实际 ${tasks.length}`)
  assert.deepEqual(tasks.map((t) => t.page), [1, 2])
})

// ---- P0#1c：--rescan-pages 不能触发全量重下 ----

test('核对模式以磁盘为准：文件都在就不排任何任务', () => {
  // 0.12.16 的回归：--rescan-pages 清空记录 → 201 个视频全被判"没下过" → 重下 209 项
  const videos = Array.from({ length: 5 }, (_, i) => ({ bvid: `BV${i}`, title: `v${i}` }))
  const pagesByBvid = new Map(videos.map((v) => [v.bvid, pagesOf(v.bvid, 2)]))
  const lastSeen = videos.map((v) => v.bvid)

  const { tasks } = planPages(videos, pagesByBvid, lastSeen, {}, {
    pagesMode: 'all',
    // 磁盘上两个分 P 都在
    existsOnDisk: () => true,
  })
  assert.deepEqual(tasks, [], `文件都在就不该重下，实际排了 ${tasks.length} 项`)
})

test('核对模式只补磁盘上缺的那些分 P', () => {
  const videos = [{ bvid: 'BV1GEn26uEDT', title: 'x' }]
  const pagesByBvid = new Map([['BV1GEn26uEDT', pagesOf('BV1GEn26uEDT', 2)]])
  const { tasks } = planPages(videos, pagesByBvid, ['BV1GEn26uEDT'], {}, {
    pagesMode: 'all',
    // 只有 P1 在磁盘上
    existsOnDisk: (_bvid, page) => page === 1,
  })
  assert.deepEqual(tasks.map((t) => t.page), [2], '只该补 P2 —— 这正是验收要的结果')
})

test('核对模式覆盖"手动删了某个分 P"的情况', () => {
  const { tasks } = planPages(
    current('BV1x'),
    new Map([['BV1x', pagesOf('BV1x', 3)]]),
    ['BV1x'],
    { BV1x: [1, 2, 3] },   // 基线说都下过
    { pagesMode: 'all', existsOnDisk: (_b, page) => page !== 2 },  // 但 P2 被删了
  )
  assert.deepEqual(tasks.map((t) => t.page), [2], '以磁盘为准就该把被删的补回来')
})

test('核对模式用的是历史下载记录，不是磁盘路径', () => {
  // 为什么不用磁盘：路径取决于**下载当时**的模板。模板改过一次
  // （{uploader}/{title}/ → Bilibili/{uploader}/），按现模板算老文件全对不上，
  // 核对就变成"全都没下过"→ 整个合集中下，正是 P0#1c 要避免的事。
  //
  // makeHistoryProbe 的判据是 job_items 里真实下成功过的项，
  // 这里用一个等价的存在性函数验证 planPages 的对接是对的。
  const videos = [{ bvid: 'BV1GEn26uEDT', title: 'x' }]
  const pagesByBvid = new Map([['BV1GEn26uEDT', pagesOf('BV1GEn26uEDT', 2)]])

  // 线上真实状态：历史里只有 P1
  const { tasks } = planPages(videos, pagesByBvid, ['BV1GEn26uEDT'], {}, {
    pagesMode: 'all',
    existsOnDisk: (b, p) => b === 'BV1GEn26uEDT' && p === 1,
  })
  assert.deepEqual(tasks.map((t) => t.page), [2], '只补 P2 —— 与 NAS 真实数据一致')
})

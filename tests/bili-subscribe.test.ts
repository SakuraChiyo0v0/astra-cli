/**
 * B 站订阅的"新视频"判定。
 *
 * 核心风险：第一次跑如果把整个合集当新视频，会一次下几百个视频。
 * 所以判定逻辑单独抽出来测：只有"上次没见过的"才算新。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { pickFresh } from '../src/bili/subscribe.ts'

const current = [{ bvid: 'BV1' }, { bvid: 'BV2' }, { bvid: 'BV3' }]

test('第一次跑（lastSeen 为空）只记基线，不把整个合集当新视频', () => {
  const { fresh, baseline } = pickFresh(current, [], false)
  assert.equal(baseline, true)
  assert.equal(fresh.length, 0, '第一次绝不能返回任何"新视频"')
})

test('-force 也走基线路径，不倒灌', () => {
  const { fresh } = pickFresh(current, ['BV1'], true)
  assert.equal(fresh.length, 0)
})

test('正常检查：只有上次没见过的才算新', () => {
  const { fresh } = pickFresh(current, ['BV1', 'BV2'], false)
  assert.deepEqual(fresh.map((v) => v.bvid), ['BV3'])
})

test('没有变化时返回空', () => {
  const { fresh } = pickFresh(current, ['BV1', 'BV2', 'BV3'], false)
  assert.equal(fresh.length, 0)
})

test('合集内容变少（UP 删了视频）不产生新的', () => {
  const { fresh } = pickFresh([{ bvid: 'BV1' }], ['BV1', 'BV2', 'BV3'], false)
  assert.equal(fresh.length, 0)
})

test('全部是新的（换了一个合集）会全下 —— 但建订阅时已记基线，不会走到这', () => {
  const { fresh } = pickFresh(current, ['BVX'], false)
  assert.equal(fresh.length, 3)
})

test('订阅命令确实注册在 bili 下', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'astra-sub-'))
  const prev = process.env.ASTRA_HOME
  process.env.ASTRA_HOME = home
  try {
    const { listBiliSubscriptions } = await import('../src/bili/subscribe.ts')
    // 空库时返回空数组而不是抛 —— 说明表结构对得上、查询能跑
    assert.deepEqual(listBiliSubscriptions(), [])
  } finally {
    if (prev === undefined) delete process.env.ASTRA_HOME
    else process.env.ASTRA_HOME = prev
  }
})

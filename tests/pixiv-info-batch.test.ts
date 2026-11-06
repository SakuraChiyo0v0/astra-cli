/**
 * `pixiv info` 多 id 的并发调度。
 *
 * 不碰网络：只测「结果顺序与入参一致」「并发数不超过上限」「单个任务抛错不会拖垮整批」
 * 这三件容易悄悄错掉的事。真实耗时靠 `astra pixiv info <id> <id>` 手工验。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapLimit } from '../src/pixiv/commands.ts'

test('mapLimit 保持入参顺序', async () => {
  const items = [5, 1, 3, 2, 4]
  const out = await mapLimit(items, 2, async (n) => {
    await new Promise((r) => setTimeout(r, n))
    return n * 10
  })
  assert.deepEqual(out, [50, 10, 30, 20, 40])
})

test('mapLimit 的并发不超过上限', async () => {
  let active = 0
  let peak = 0
  await mapLimit(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 5))
    active -= 1
  })
  assert.ok(peak <= 3, `并发峰值 ${peak} 超过上限 3`)
  assert.ok(peak >= 2, `并发峰值 ${peak} 说明根本没并发`)
})

test('mapLimit 单项抛错会向上抛（由调用方决定如何兜底）', async () => {
  await assert.rejects(
    mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      return n
    }),
    /boom/,
  )
})

test('mapLimit 空数组直接返回', async () => {
  assert.deepEqual(await mapLimit([], 2, async (n: number) => n), [])
})

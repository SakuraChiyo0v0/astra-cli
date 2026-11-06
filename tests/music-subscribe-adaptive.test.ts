/**
 * 自适应订阅间隔：5 → 10 → 20 … 封顶，有新增立刻回基准。
 *
 * 这几条是纯函数，但错了的代价很实在：算小了等于没退避（每 5 分钟白跑一次请求），
 * 算大了就是「点了红心一小时才下」。所以边界都钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { intervalMinutesOf, nextInterval } from '../src/music/subscribe.ts'

const base = { base: 5, max: 640, factor: 2 }

test('没有任何新增时按倍数拉长', () => {
  assert.equal(nextInterval({ ...base, current: 5, changed: false }), 10)
  assert.equal(nextInterval({ ...base, current: 10, changed: false }), 20)
  assert.equal(nextInterval({ ...base, current: 320, changed: false }), 640)
})

test('封顶后再跑一次仍然是封顶值', () => {
  assert.equal(nextInterval({ ...base, current: 640, changed: false }), 640)
  assert.equal(nextInterval({ ...base, current: 5000, changed: false }), 640)
})

test('有新增立刻回到基准', () => {
  assert.equal(nextInterval({ ...base, current: 640, changed: true }), 5)
  assert.equal(nextInterval({ ...base, current: 20, changed: true }), 5)
})

test('current 还没初始化（0）时按 base 起算，不会变成 0', () => {
  assert.equal(nextInterval({ ...base, current: 0, changed: false }), 10)
})

test('factor 被夹在 2..10，异常值不会把间隔算成负数或 1 倍死循环', () => {
  assert.equal(nextInterval({ base: 5, max: 640, factor: 1, current: 5, changed: false }), 10)
  assert.equal(nextInterval({ base: 5, max: 640, factor: 100, current: 5, changed: false }), 50)
})

test('间隔口径：开了退避用 currentMin，关了用 everyHours', () => {
  assert.equal(intervalMinutesOf({ everyHours: 24, baseMin: 0, currentMin: 0 }), 24 * 60)
  assert.equal(intervalMinutesOf({ everyHours: 24, baseMin: 5, currentMin: 40 }), 40)
  assert.equal(intervalMinutesOf({ everyHours: 24, baseMin: 5, currentMin: 0 }), 5)
})

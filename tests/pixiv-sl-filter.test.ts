/**
 * `--sl` / `--min-sl` / `--max-sl` 的本地过滤。
 *
 * pixiv 搜索接口不接受 sl 参数（实测 `&sl=4` 被忽略），所以等级筛选只能本地做；
 * 这些用例锁的是「边界别写反」和「非法值要报错」，不依赖网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slFilter } from '../src/pixiv/commands.ts'

test('不传参数时返回 null（不过滤）', () => {
  assert.equal(slFilter({}), null)
})

test('--sl 精确匹配，支持逗号分隔', () => {
  const f = slFilter({ sl: '2' })
  assert.ok(f)
  assert.deepEqual([2, 4, 6].filter(f), [2])

  const g = slFilter({ sl: '2,4' })
  assert.ok(g)
  assert.deepEqual([0, 2, 4, 6].filter(g), [2, 4])
})

test('--min-sl / --max-sl 是闭区间', () => {
  const min = slFilter({ 'min-sl': '4' })
  assert.ok(min)
  assert.deepEqual([2, 4, 6].filter(min), [4, 6])

  const max = slFilter({ 'max-sl': '2' })
  assert.ok(max)
  assert.deepEqual([0, 2, 4, 6].filter(max), [0, 2])

  const both = slFilter({ 'min-sl': '4', 'max-sl': '4' })
  assert.ok(both)
  assert.deepEqual([2, 4, 6].filter(both), [4])
})

test('--sl 和 --min-sl 同时给时取交集', () => {
  const f = slFilter({ sl: '2,6', 'min-sl': '4' })
  assert.ok(f)
  assert.deepEqual([2, 4, 6].filter(f), [6])
})

test('--sl 非数字要报错，不能静默放过', () => {
  assert.throws(() => slFilter({ sl: 'abc' }), /--sl/)
})

test('--min-sl 超出范围要报错', () => {
  assert.throws(() => slFilter({ 'min-sl': '99' }), /min-sl/)
})

/**
 * 调度纯函数：间隔解析与命令拆分。真实调度行为靠真机 `schedule run/tick` 验收。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInterval, splitCommand } from '../src/core/schedule.ts'

test('间隔：纯数字按分钟', () => {
  assert.equal(parseInterval('30'), 30)
  assert.equal(parseInterval('1'), 1)
})

test('间隔：分钟 / 小时 / 天', () => {
  assert.equal(parseInterval('30m'), 30)
  assert.equal(parseInterval('6h'), 360)
  assert.equal(parseInterval('1d'), 1440)
})

test('间隔：秒向上取整到 1 分钟', () => {
  assert.equal(parseInterval('30s'), 1)
  assert.equal(parseInterval('90s'), 2)
})

test('间隔：非法输入报错', () => {
  assert.throws(() => parseInterval('abc'))
  assert.throws(() => parseInterval('0m'))
})

test('命令拆分：引号包住带空格的参数', () => {
  assert.deepEqual(splitCommand('music get 周杰伦 稻香'), ['music', 'get', '周杰伦', '稻香'])
  assert.deepEqual(splitCommand('x search "foo bar" --limit 5'), ['x', 'search', 'foo bar', '--limit', '5'])
  assert.deepEqual(splitCommand("bili get 'BV1 xx' --dry-run"), ['bili', 'get', 'BV1 xx', '--dry-run'])
})

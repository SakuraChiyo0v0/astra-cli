/**
 * `bili bulk --pages` 的解析。
 *
 * 差一位是这里最容易犯的错：用户看到的是 P1、P2（1-based），内部 `pageIndex` 是 0-based。
 * 单独测，别让它混在命令里靠试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePageSelection } from '../src/bili/pages.ts'

test('单个 P 号 → 0-based 下标', () => {
  assert.deepEqual(parsePageSelection('2').indexes, [1])
  assert.deepEqual(parsePageSelection('1').indexes, [0])
})

test('列表与区间', () => {
  assert.deepEqual(parsePageSelection('2,3').indexes, [1, 2])
  assert.deepEqual(parsePageSelection('1,3-5').indexes, [0, 2, 3, 4])
  assert.deepEqual(parsePageSelection('3-1').indexes, [0, 1, 2], '倒序区间也接受')
})

test('重复与乱序会归一', () => {
  assert.deepEqual(parsePageSelection('3,1,3,2').indexes, [0, 1, 2])
})

test('越界的分 P 单列出来，不当错误', () => {
  const r = parsePageSelection('2,9,10', 5)
  assert.deepEqual(r.indexes, [1])
  assert.deepEqual(r.outOfRange, [9, 10])
})

test('全部越界时 indexes 为空（调用方据此报错）', () => {
  const r = parsePageSelection('9,10', 5)
  assert.deepEqual(r.indexes, [])
  assert.deepEqual(r.outOfRange, [9, 10])
})

test('P 号从 1 开始，0 和负数直接拒绝', () => {
  assert.throws(() => parsePageSelection('0'), /从 1 开始/)
  assert.throws(() => parsePageSelection('0-3'), /从 1 开始/)
  assert.throws(() => parsePageSelection('-1'), /认不出|从 1 开始/)
})

test('非法写法抛错，而不是静默忽略', () => {
  // 静默忽略会让用户以为已经下过了
  for (const bad of ['', '  ', 'a', '1-', '-', 'x-y']) {
    assert.throws(() => parsePageSelection(bad), `应当拒绝「${bad}」`)
  }
})

test('多余逗号容忍（手写常有尾逗号）', () => {
  assert.deepEqual(parsePageSelection('1,,3').indexes, [0, 2])
  assert.deepEqual(parsePageSelection('1,').indexes, [0])
})

test('空白容错', () => {
  assert.deepEqual(parsePageSelection(' 1 , 3 - 5 ').indexes, [0, 2, 3, 4])
})

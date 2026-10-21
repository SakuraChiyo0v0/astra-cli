/**
 * UP 主空间的 mid 解析。
 *
 * 背景：B 站的全量投稿接口做不了（-352 / -412 风控，实测多种姿势都不行），
 * 替代方案是列这个 UP 的合集与系列。这个文件只测输入解析，网络部分靠真实验证。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMid, spaceFromUrl } from '../src/bili/space.ts'

test('mid：空间链接 / mid: 前缀 / 纯数字', () => {
  assert.equal(parseMid('https://space.bilibili.com/546195'), '546195')
  assert.equal(parseMid('https://space.bilibili.com/546195/video'), '546195')
  assert.equal(parseMid('https://space.bilibili.com/546195/channel/collectiondetail?sid=1'), '546195')
  assert.equal(parseMid('mid:546195'), '546195')
  assert.equal(parseMid('546195'), '546195')
})

test('mid：认不出时不硬猜', () => {
  assert.equal(parseMid('老番茄'), null)
  assert.equal(parseMid('https://www.bilibili.com/video/BV17x411w7KC'), null)
  assert.equal(parseMid(''), null)
})

test('spaceFromUrl 与 parseMid 行为一致', () => {
  assert.equal(spaceFromUrl('https://space.bilibili.com/123456'), '123456')
  assert.equal(spaceFromUrl('随便'), null)
})

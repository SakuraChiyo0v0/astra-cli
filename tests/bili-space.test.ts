/**
 * UP 主空间的输入解析。
 *
 * 背景：B 站自己的投稿接口 `space/wbi/arc/search` 有风控（-352/-412，试遍签名与设备指纹都不行）。
 * 可行替代是从社区文档翻到的 `series/recArchivesByKeywords`（keywords 留空 = 全部投稿，免签名）。
 * 网络部分靠真实验证，这里只测纯解析。
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

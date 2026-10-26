/**
 * pixiv 搜索回退计划。
 *
 * 核心风险：pixiv 的 tag 是全词精确匹配，角色全名经常查不到
 * （绝区零凯撒的真实 tag 是 `キング・シーザー`，`カエサル・キング` 是 0 条）。
 * 回退顺序错了会导致「一搜就搜出一堆不相干的东西」，所以顺序单独锁死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { searchPlan, searchTokens } from '../src/pixiv/api.ts'

test('分词：按 ・ / 空格 / 斜杠 拆，且去重', () => {
  assert.deepEqual(searchTokens('カエサル・キング'), ['カエサル', 'キング'])
  assert.deepEqual(searchTokens('绝区零 凯撒'), ['绝区零', '凯撒'])
  assert.deepEqual(searchTokens('a/b／c'), ['a', 'b', 'c'])
  assert.deepEqual(searchTokens('あめ ちゃん あめ'), ['あめ', 'ちゃん'])
})

test('分词：单片段没有可拆的，返回空数组', () => {
  assert.deepEqual(searchTokens('カエサル'), [])
  assert.deepEqual(searchTokens('   '), [])
})

test('回退顺序：精确 tag → 部分 tag → 标题说明 → 分词', () => {
  const plan = searchPlan('カエサル・キング')
  assert.deepEqual(
    plan.map((p) => [p.keyword, p.sMode, p.matchedBy]),
    [
      ['カエサル・キング', 's_tag_full', 'tag'],
      ['カエサル・キング', 's_tag', 'tag_partial'],
      ['カエサル・キング', 's_tc', 'caption'],
      ['カエサル', 's_tag_full', 'token'],
      ['キング', 's_tag_full', 'token'],
    ],
  )
})

test('单片段关键词只试三种匹配模式，不做分词回退', () => {
  const plan = searchPlan('カエサル')
  assert.equal(plan.length, 3)
  assert.equal(plan[0]?.matchedBy, 'tag')
})

test('翻页时不带分词回退（换词会让页数语义错乱）', () => {
  const plan = searchPlan('カエサル・キング', 2)
  assert.equal(plan.length, 3)
  assert.ok(plan.every((p) => p.keyword === 'カエサル・キング'))
})

test('第一项永远是用户原词 + 精确 tag，不能先放宽再精确', () => {
  for (const kw of ['カエサル・キング', '绝区零 凯撒', '単語']) {
    const first = searchPlan(kw)[0]!
    assert.equal(first.keyword, kw)
    assert.equal(first.sMode, 's_tag_full')
  }
})

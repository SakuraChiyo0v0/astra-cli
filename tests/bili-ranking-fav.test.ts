/**
 * 分区排行榜 + 收藏夹写入的纯函数部分。
 *
 * 这两块都有「接口字段名和输出不一样」和「cookie 解析」的坑，
 * 出错不会抛异常只会静默错位，所以单独钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapRank, parseRid, RID_MAP } from '../src/bili/ranking.ts'
import { csrfFromCookie } from '../src/bili/favorites.ts'

test('分区名 → rid：常用分区都能认', () => {
  assert.equal(parseRid('全站'), 0)
  assert.equal(parseRid('动画'), 1)
  assert.equal(parseRid('游戏'), 4)
  assert.equal(parseRid('知识'), 36)
})

test('分区名大小写不敏感；数字直接当 rid 透传', () => {
  assert.equal(parseRid('虚拟up'), RID_MAP['虚拟UP'])
  assert.equal(parseRid(' 211 '), 211)
})

test('认不出的分区返回 null，不瞎猜', () => {
  assert.equal(parseRid('不存在的分区'), null)
  assert.equal(parseRid(''), null)
})

test('排行榜条目拍平：stat 里的数字搬出来，缺字段不崩', () => {
  const item = mapRank({
    bvid: 'BV1xx',
    title: '  标题  ',
    owner: { name: 'UP' },
    stat: { view: 100, like: 10, danmaku: 5 },
    duration: 300,
    pubdate: 1793464124,
    score: 12345,
  })
  assert.deepEqual(item, {
    bvid: 'BV1xx',
    title: '标题',
    owner: 'UP',
    view: 100,
    like: 10,
    danmaku: 5,
    duration: 300,
    pubdate: 1793464124,
    score: 12345,
  })
  const empty = mapRank({})
  assert.equal(empty.bvid, '')
  assert.equal(empty.view, 0)
})

test('从 cookie 串里取 csrf：中间 / 开头 / 没有三种情况', () => {
  assert.equal(csrfFromCookie('SESSDATA=abc; bili_jct=deadbeef; DedeUserID=1'), 'deadbeef')
  assert.equal(csrfFromCookie('bili_jct=xyz'), 'xyz')
  assert.equal(csrfFromCookie('SESSDATA=abc; DedeUserID=1'), null)
  assert.equal(csrfFromCookie(''), null)
})

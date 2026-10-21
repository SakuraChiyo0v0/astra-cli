/**
 * 合集 / 系列 / 收藏夹 ref 的三种写法。
 *
 * 回归目标：v0.12.0 之前 `season:<sid>` 这条简写会报 `-503`，v0.12.2 修好了。
 * 这类"以前能用的写法突然不能用了"最容易悄悄退化，所以把全部入口钉住。
 *
 * 实测（2026-10-21）：`seasons_archives_list` 只给 season_id 也能返回，
 * mid 是可选的 —— 之前以为必须两个参数，是因为当时用的 sid 本身不存在，
 * 404 被误读成"缺 mid"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCollectionRef, assertCollectionRef } from '../src/bili/collection.ts'

test('合集：三种写法都认', () => {
  // 1. 纯 sid 简写（v0.12.0 前会 -503 的那种）
  assert.deepEqual(parseCollectionRef('season:1049571'), { kind: 'season', mid: null, seasonId: '1049571' })
  // 2. 带 mid 的复合写法（subscribe list 回显的就是这个形状，必须能直接复用）
  assert.deepEqual(parseCollectionRef('season:1060544882/1049571'), { kind: 'season', mid: '1060544882', seasonId: '1049571' })
  // 3. collectiondetail 链接
  assert.deepEqual(
    parseCollectionRef('https://space.bilibili.com/1060544882/channel/collectiondetail?sid=1049571'),
    { kind: 'season', mid: '1060544882', seasonId: '1049571' },
  )
})

test('合集的其它等价写法', () => {
  assert.deepEqual(parseCollectionRef('collection:1049571'), { kind: 'season', mid: null, seasonId: '1049571' })
  assert.deepEqual(
    parseCollectionRef('https://space.bilibili.com/1060544882/lists/1049571?type=season'),
    { kind: 'season', mid: '1060544882', seasonId: '1049571' },
  )
})

test('系列：写法和合集区分得开', () => {
  // seriesdetail 与 collectiondetail 是两套接口，不能互相认错
  assert.deepEqual(parseCollectionRef('series:1049571'), { kind: 'series', mid: null, seriesId: '1049571' })
  assert.deepEqual(parseCollectionRef('series:1060544882/1049571'), { kind: 'series', mid: '1060544882', seriesId: '1049571' })
  assert.deepEqual(
    parseCollectionRef('https://space.bilibili.com/1060544882/channel/seriesdetail?sid=1049571'),
    { kind: 'series', mid: '1060544882', seriesId: '1049571' },
  )
})

test('收藏夹：ref 与链接', () => {
  assert.deepEqual(parseCollectionRef('fav:123456'), { kind: 'fav', id: '123456' })
  assert.deepEqual(
    parseCollectionRef('https://space.bilibili.com/1060544882/favlist?fid=123456&ftype=create'),
    { kind: 'fav', id: '123456' },
  )
})

test('认不出的输入返回 kind: null，而不是抛错或猜一个', () => {
  for (const bad of ['', '随便什么', 'BV1xx411c7mD', 'season:', 'season:abc']) {
    assert.equal(parseCollectionRef(bad).kind, null, bad)
  }
})

test('assertCollectionRef 对坏输入给出可执行的提示', () => {
  assert.doesNotThrow(() => assertCollectionRef('season:1049571'))
  assert.throws(() => assertCollectionRef('这不是ref'), /认不出|收藏夹/)
})

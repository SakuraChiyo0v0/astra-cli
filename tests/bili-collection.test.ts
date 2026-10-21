/**
 * 收藏夹 / 合集链接解析。
 *
 * 回归用例：`bili bulk` 的 help 说过支持合集链接，但实现只认 `fav:` 和 `favlist`，
 * 传 space.bilibili.com/<mid>/channel/collectiondetail?sid=xxx 会报 BILI_BAD_TARGET。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCollectionRef, readSeason } from '../src/bili/collection.ts'

test('收藏夹：ref 与链接都认', () => {
  assert.deepEqual(parseCollectionRef('fav:123456'), { kind: 'fav', id: '123456' })
  assert.deepEqual(parseCollectionRef('https://space.bilibili.com/546195/favlist?fid=98765&ftype=create'), { kind: 'fav', id: '98765' })
})

test('合集：collectiondetail 链接（用户报的那个格式）', () => {
  const r = parseCollectionRef('https://space.bilibili.com/546195/channel/collectiondetail?sid=1903592')
  assert.deepEqual(r, { kind: 'season', mid: '546195', seasonId: '1903592' })
})

test('合集：新版 lists 链接', () => {
  const r = parseCollectionRef('https://space.bilibili.com/546195/lists/1903592?type=season')
  assert.deepEqual(r, { kind: 'season', mid: '546195', seasonId: '1903592' })
})

test('合集：显式 ref', () => {
  assert.deepEqual(parseCollectionRef('season:546195/1903592'), { kind: 'season', mid: '546195', seasonId: '1903592' })
})

test('合集链接必须同时给出 mid 和 sid（只给 sid 接口会 404）', () => {
  // 没有 mid 的链接不该被当成合集
  assert.equal(parseCollectionRef('https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?season_id=1903592').kind, null)
})

test('认不出的一律 null，不硬猜', () => {
  assert.equal(parseCollectionRef('https://www.bilibili.com/video/BV17x411w7KC').kind, null)
  assert.equal(parseCollectionRef('随便一句话').kind, null)
  assert.equal(parseCollectionRef('fav:abc').kind, null)
})

test('readSeason：从视频详情的 ugc_season 里取分集', () => {
  const season = readSeason({
    ugc_season: {
      title: '某合集',
      sections: [
        { episodes: [{ bvid: 'BV1aa411c7aa', title: 'P1', arc: { title: '第一集', duration: 100 } }] },
        { episodes: [{ bvid: 'BV1bb411c7bb', title: 'P2', arc: { title: '第二集', duration: 200 } }] },
      ],
    },
  })
  assert.equal(season?.title, '某合集')
  assert.equal(season?.items.length, 2)
  assert.deepEqual(season?.items.map((x) => x.bvid), ['BV1aa411c7aa', 'BV1bb411c7bb'])
  assert.equal(season?.items[0]?.title, '第一集')
})

test('readSeason：没有 ugc_season 时返回 null', () => {
  assert.equal(readSeason({}), null)
  assert.equal(readSeason({ ugc_season: { sections: [] } }), null)
})

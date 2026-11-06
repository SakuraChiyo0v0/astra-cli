/**
 * X 搜索串拼装、口径字段、条目映射。
 *
 * 这三块都是纯函数，出错的代价却很高：搜索串拼错就是「搜不到任何东西」，
 * 条目映射错就是「有结果但正文空白」——两种都不会抛异常，只能靠测试钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSearchUrl, listMeta, originalImageUrl, parseGalleryEntries, quoteBigInts, toItem } from '../src/x/api.ts'

test('搜索 URL：关键词 + 全部过滤器都进 q，f 对应 tab', () => {
  const url = buildSearchUrl({
    q: '绝区零 建模',
    from: '@ArknightsStaff',
    since: '2026-01-01',
    until: '2026-02-01',
    minLikes: 100,
    has: ['images'],
    exclude: ['replies'],
    type: 'latest',
  })
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get('q'), '绝区零 建模 from:ArknightsStaff since:2026-01-01 until:2026-02-01 min_faves:100 filter:images -filter:replies')
  assert.equal(parsed.searchParams.get('f'), 'live')
})

test('搜索 tab 映射：top/photos/videos 不能都落成 live', () => {
  assert.equal(new URL(buildSearchUrl({ q: 'a', type: 'top' })).searchParams.get('f'), 'top')
  assert.equal(new URL(buildSearchUrl({ q: 'a', type: 'photos' })).searchParams.get('f'), 'media')
  assert.equal(new URL(buildSearchUrl({ q: 'a', type: 'videos' })).searchParams.get('f'), 'videos')
})

test('只给 --from 不给关键词也能成 URL', () => {
  const url = buildSearchUrl({ from: 'elonmusk' })
  assert.equal(new URL(url).searchParams.get('q'), 'from:elonmusk')
})

test('口径：returned >= limit 判 truncated', () => {
  assert.deepEqual(listMeta(3, 20), { returned: 3, limit: 20, truncated: false })
  assert.deepEqual(listMeta(20, 20), { returned: 20, limit: 20, truncated: true })
})

test('twitter-cli 条目映射：字段缺失不抛，指标归零', () => {
  const item = toItem({
    id: '2118553968339202249',
    text: '正文',
    author: { screenName: 'ArknightsStaff', name: 'アークナイツ公式' },
    metrics: { likes: 303, retweets: 70, views: 39157 },
    createdAtLocal: '2026-11-06 12:00',
    media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/x.jpg' }],
  })
  assert.ok(item)
  assert.equal(item.url, 'https://x.com/i/status/2118553968339202249')
  assert.equal(item.author, 'ArknightsStaff')
  assert.deepEqual(item.metrics, { likes: 303, retweets: 70, replies: 0, quotes: 0, views: 39157 })
  assert.equal(item.media.length, 1)

  assert.equal(toItem({ id: '1' }), null) // 没正文的条目直接丢
  assert.equal(toItem(null), null)
})

test('gallery-dl 条目：大整数 id 不丢精度，媒体按 tweet_id 归类', () => {
  const tid = '2118552452572348566'
  const raw = `[[2, {"content":"正文内容","tweet_id":${tid},"user":{"name":"monad1412565","nick":"禁漫软件"},"date":"2026-11-06 03:54:00","favorite_count":0,"view_count":23}],[3,"https://pbs.twimg.com/media/HWacOHtagAAAnuG?format=jpg&name=orig",{"tweet_id":${tid}}],[4,"https://pbs.twimg.com/media/HWacOIYbYAE8i8i?format=jpg&name=orig",{"tweet_id":${tid}}]]`
  // 裸 JSON.parse 会把 19 位 id 的尾数抹平（2^53 以上），这正是 quoteBigInts 存在的理由
  assert.notEqual(String((JSON.parse(raw) as Array<[number, { tweet_id: number }]>)[0]![1].tweet_id), tid)

  const entries = JSON.parse(quoteBigInts(raw)) as unknown[]
  const items = parseGalleryEntries(entries)
  assert.equal(items.length, 1)
  assert.equal(items[0]!.id, tid)
  assert.equal(items[0]!.text, '正文内容')
  assert.equal(items[0]!.author, 'monad1412565')
  assert.equal(items[0]!.authorName, '禁漫软件')
  assert.equal(items[0]!.metrics.views, 23)
  assert.equal(items[0]!.media.length, 2)
  assert.ok(items[0]!.url.endsWith(tid))
})

test('原图 URL 换成 name=orig，视频不动', () => {
  assert.equal(
    originalImageUrl('https://pbs.twimg.com/media/AAA.jpg?name=small'),
    'https://pbs.twimg.com/media/AAA.jpg?format=jpg&name=orig',
  )
  const video = 'https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/abc.mp4'
  assert.equal(originalImageUrl(video), video)
})

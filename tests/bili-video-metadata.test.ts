/**
 * 视频容器的溯源标签。
 *
 * 事故背景：视频侧原来一条标签都不写（只有 B 站自己的 `description`），
 * 认文件只能靠文件名 —— 改一次 `bili.video-template` 就全对不上。
 * 音频侧早就写了 SOURCE_ID / BILIBILI_BVID / BILIBILI_URL，这里要求视频对齐同一套键名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { videoMetadata } from '../src/bili/download.ts'
import type { VideoInfo } from '../src/bili/api.ts'

function info(over: Partial<VideoInfo> = {}): VideoInfo {
  return {
    bvid: 'BV19K421a7kx',
    aid: 1,
    title: '5:20AM',
    desc: '',
    owner: { mid: 1, name: '东洋雪莲' },
    duration: 200,
    pic: null,
    pubdate: 1711670400, // 2024-03-29 UTC
    pages: [{ page: 1, part: '5:20AM', cid: 1, duration: 200 }],
    ...over,
  }
}

test('单 P：title 用视频标题，溯源键齐全', () => {
  const meta = videoMetadata(info(), { page: 1, part: '5:20AM' })
  assert.equal(meta.title, '5:20AM')
  assert.equal(meta.artist, '东洋雪莲')
  assert.equal(meta.album, '5:20AM')
  assert.equal(meta.BILIBILI_BVID, 'BV19K421a7kx')
  assert.equal(meta.SOURCE_ID, 'BV19K421a7kx')
  assert.equal(meta.BILIBILI_URL, 'https://www.bilibili.com/video/BV19K421a7kx')
  assert.equal(meta.SOURCE, 'bilibili')
  assert.equal(meta.date, '2024-03-29')
})

test('多 P：title 用分 P 名，album 仍是视频标题', () => {
  const multi = info({
    title: '合集',
    pages: [
      { page: 1, part: '第一集', cid: 1, duration: 100 },
      { page: 2, part: '第二集', cid: 2, duration: 100 },
    ],
  })
  const meta = videoMetadata(multi, { page: 2, part: '第二集' })
  assert.equal(meta.title, '第二集')
  assert.equal(meta.album, '合集')
})

test('多 P 但分 P 名为空：退回视频标题，不写空串', () => {
  const multi = info({
    pages: [
      { page: 1, part: '', cid: 1, duration: 100 },
      { page: 2, part: '', cid: 2, duration: 100 },
    ],
  })
  const meta = videoMetadata(multi, { page: 1, part: '' })
  assert.equal(meta.title, '5:20AM')
})

test('pubdate 缺失时不写 date', () => {
  const meta = videoMetadata(info({ pubdate: 0 }), { page: 1, part: 'x' })
  assert.equal(meta.date, undefined)
})

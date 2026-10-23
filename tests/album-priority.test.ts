/**
 * 同曲多专辑的归属（P4#5）。
 *
 * 真实事故：给 Michael Jackson 一次下 5 张专辑，5 个 job 并行。astra 全局去重
 * （同一首只存一份），但判据只看"这首歌在不在库里" —— 于是胜负由下载完成顺序
 * 决定，等于随机。
 *
 * 结果是 HIStory(1995 精选集) 抢到了 Billie Jean / Man In the Mirror，
 * 而 Thriller(1982) / Bad(1987) 把这几首判成 skipped。播放器里点开 Thriller，
 * 缺了它最招牌的歌 —— 用户看到的是"专辑不完整"，不是"重复被去掉了"。
 *
 * 这里的判据必须**与下载顺序无关**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { albumTypeRank, pickOwnerAlbum, preferredAlbum, type AlbumCandidate } from '../src/music/album-priority.ts'

const album = (over: Partial<AlbumCandidate> = {}): AlbumCandidate => ({
  id: 'x',
  name: 'X',
  publishTime: null,
  type: null,
  trackNo: null,
  ...over,
})

/** 1982-11-30 / 1995-06-20 / 1987-08-31（毫秒） */
const THRILLER = Date.UTC(1982, 10, 30)
const BAD = Date.UTC(1987, 7, 31)
const HISTORY = Date.UTC(1995, 5, 20)

test('年份最早的胜：Thriller 1982 赢过 HIStory 1995', () => {
  const thriller = album({ id: 'thriller', name: 'Thriller', publishTime: THRILLER, type: '录音室版' })
  const history = album({ id: 'history', name: 'HIStory', publishTime: HISTORY, type: '精选集' })
  assert.equal(preferredAlbum(thriller, history), true)
  assert.equal(preferredAlbum(history, thriller), false, '反过来必须不成立 —— 否则顺序就还会影响结果')
})

test('同年时录音室 > 精选集', () => {
  const studio = album({ id: 's', publishTime: BAD, type: '录音室版' })
  const best = album({ id: 'c', publishTime: BAD, type: '精选集' })
  assert.equal(preferredAlbum(studio, best), true)
  assert.equal(preferredAlbum(best, studio), false)
})

test('同年同类型时 tracknumber 靠前的胜', () => {
  const a = album({ id: 'a', publishTime: BAD, type: '录音室版', trackNo: 1 })
  const b = album({ id: 'b', publishTime: BAD, type: '录音室版', trackNo: 9 })
  assert.equal(preferredAlbum(a, b), true)
})

test('完全分不出时保持现状 —— 不因下载顺序翻转', () => {
  // 两条都不知道年份、同类型、都没 trackNo
  const a = album({ id: 'a' })
  const b = album({ id: 'b' })
  assert.equal(preferredAlbum(a, b), false, 'a 不比 b 优先')
  assert.equal(preferredAlbum(b, a), false, 'b 也不比 a 优先 —— 对称，所以顺序无关')
})

test('一方不知道年份时，知道的那方优先', () => {
  const known = album({ id: 'k', publishTime: THRILLER })
  const unknown = album({ id: 'u' })
  assert.equal(preferredAlbum(known, unknown), true)
  assert.equal(preferredAlbum(unknown, known), false)
})

test('专辑类型分档：录音室最原始，Remix 最靠后', () => {
  assert.ok(albumTypeRank('录音室版') < albumTypeRank('精选集'))
  assert.ok(albumTypeRank('录音室版') < albumTypeRank('现场版'))
  assert.ok(albumTypeRank('精选集') < albumTypeRank('Remix'))
  // 未知按中间档，遇到未知时退回看年份
  assert.equal(albumTypeRank(null), 2)
  assert.equal(albumTypeRank(''), 2)
  assert.equal(albumTypeRank('没见过的类型'), 2)
})

test('pickOwnerAlbum 从多个候选里挑出原专辑', () => {
  const list = [
    album({ id: 'history', name: 'HIStory', publishTime: HISTORY, type: '精选集' }),
    album({ id: 'thriller', name: 'Thriller', publishTime: THRILLER, type: '录音室版' }),
    album({ id: 'bad', name: 'Bad', publishTime: BAD, type: '录音室版' }),
  ]
  assert.equal(pickOwnerAlbum(list)?.id, 'thriller', '1982 最早')
  // 顺序无关：换个顺序结果一样
  assert.equal(pickOwnerAlbum([...list].reverse())?.id, 'thriller')
})

test('pickOwnerAlbum 空数组返回 null', () => {
  assert.equal(pickOwnerAlbum([]), null)
})

test('判据与顺序无关：任意排列都选出同一张', () => {
  const items = [
    album({ id: 'a', publishTime: HISTORY, type: '精选集' }),
    album({ id: 'b', publishTime: THRILLER, type: '录音室版' }),
    album({ id: 'c', publishTime: BAD, type: '录音室版' }),
  ]
  const perms = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ]
  const results = perms.map((p) => pickOwnerAlbum(p.map((i) => items[i]!))?.id)
  assert.deepEqual(new Set(results), new Set(['b']), `不同排列给出了不同答案：${results.join(',')}`)
})

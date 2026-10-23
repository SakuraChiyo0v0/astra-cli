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
import { albumTypeRank, deservesReassign, pickOwnerAlbum, preferredAlbum, type AlbumCandidate } from '../src/music/album-priority.ts'

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

// ---- P4#6：归位只允许"精选 → 原专辑"一个方向 ----

test('精选集里的歌遇到原专辑：允许归位', () => {
  const history = album({ id: 'history', publishTime: HISTORY, type: '精选集' })
  const thriller = album({ id: 'thriller', publishTime: THRILLER, type: '录音室版' })
  // 原专辑更早 → 优先
  assert.equal(preferredAlbum(thriller, history), true)
  // 反过来不成立
  assert.equal(preferredAlbum(history, thriller), false)
})

test('新专辑反而更"二手"时不归位（不动用户已整理的文件）', () => {
  // 已有的是录音室原专辑，这次下的是精选集 —— 绝不能把原专辑的歌搬走
  const original = album({ id: 'orig', publishTime: THRILLER, type: '录音室版' })
  const best = album({ id: 'best', publishTime: HISTORY, type: '精选集' })
  assert.equal(preferredAlbum(original, best), true, '原专辑更该拥有 → 应跳过，不搬文件')
})

test('两端信息不全时不动文件：类型判据的默认值是安全的', () => {
  // 老记录没存类型 → albumTypeRank(null) 是中间档 → 不会被判成"二手"
  assert.equal(albumTypeRank(null) >= 4, false, 'null 不该被判成精选/合辑档')
  // 因此"theirsSecondary"为 false，归位条件不成立 → 不动
})

// ---- P4#6：deservesReassign 是 downloadTrack 真正调用的那个判据 ----

test('值得归位：已有是精选集、新的是更早的录音室版', () => {
  const theirs = album({ id: 'history', publishTime: HISTORY, type: '精选集' })
  const mine = album({ id: 'thriller', publishTime: THRILLER, type: '录音室版' })
  assert.equal(deservesReassign(theirs, mine), true)
})

test('不值得：已有更早（绝不该被更晚的那张挤走）', () => {
  // 这正是实测丢歌的那个方向 —— 必须为 false
  const theirs = album({ id: 'orig', publishTime: THRILLER, type: '专辑' })
  const mine = album({ id: 'best', publishTime: HISTORY, type: '专辑' })
  assert.equal(deservesReassign(theirs, mine), false, '已有 1982、新的是 1995 → 不能动')
})

test('不值得：年份都不知道时不动文件', () => {
  const theirs = album({ id: 'unknown', publishTime: null, type: null })
  const mine = album({ id: 'mine', publishTime: null, type: '录音室版' })
  assert.equal(deservesReassign(theirs, mine), false, '没有年份就没有证据')
})

test('同年时看类型：已有是精选集、新的是普通专辑 → 值得', () => {
  const theirs = album({ id: 'a', publishTime: BAD, type: '精选集' })
  const mine = album({ id: 'b', publishTime: BAD, type: '专辑' })
  assert.equal(deservesReassign(theirs, mine), true, '类型能区分时用类型')
})

test('同年同类型 → 不动', () => {
  const theirs = album({ id: 'a', publishTime: BAD, type: '专辑' })
  const mine = album({ id: 'b', publishTime: BAD, type: '专辑' })
  assert.equal(deservesReassign(theirs, mine), false)
})

test('实测数据：网易云的 type 几乎永远是"专辑"，判据实际靠年份', () => {
  // 实测 沈香学(2023) 和 2026 Special Edition(2026) 都返回 type="专辑"
  assert.equal(albumTypeRank('专辑'), 1, '"专辑"该归到最原始档')
  const theirs = album({ id: 'a', publishTime: Date.UTC(2023, 5, 6), type: '专辑' })
  const mine = album({ id: 'b', publishTime: Date.UTC(2026, 0, 1), type: '专辑' })
  assert.equal(deservesReassign(theirs, mine), false, '同年同类型时靠年份 —— 更晚的不该抢')
  // 反过来（新的是更早的原专辑）才值得
  assert.equal(deservesReassign(mine, theirs), true, '2026 让位给 2023')
})

test('单位必须一致：秒和毫秒混用会让年份判据彻底错掉', () => {
  // 真实踩过：track.publishTime 是秒（1686067200），album.publishTime 是毫秒
  // （1686067200000）。把秒当毫秒乘/不乘搞反，存出来的年份是 55399 这种东西。
  const inSeconds = 1686067200
  const inMillis = inSeconds * 1000
  assert.equal(new Date(inMillis).getUTCFullYear(), 2023, '毫秒才能直接给 Date')
  // 秒不乘 1000 会得到 1970 年
  assert.equal(new Date(inSeconds).getUTCFullYear(), 1970, '秒直接给 Date 是错的')
  // 判断"更早"时两边必须都是同一单位 —— 用毫秒
  const earlier = inMillis
  const later = inMillis + 86400_000 * 365
  assert.ok(earlier < later)
})

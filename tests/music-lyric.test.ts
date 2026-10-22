/**
 * `music lyric`：不下载音频，单独取歌词。
 *
 * 这个命令的价值在于"库里已有音频、想补歌词"——尤其是 `bili get --audio-only`
 * 下来的翻唱 mp3，重下会重复占盘、还会打乱已整理好的标签。
 *
 * 两个容易做错的地方，都用真实搜索结果的形状钉住：
 * 1. **不替用户选版本**：搜"年轮"第一条是汪苏泷 4:06，张碧晨原版 4:35 排第二
 * 2. **逐字校验基准**：库里是 B 站音频时，网易云记录的时长不是这首歌的
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lyricFilePaths, pickLyricCandidates, pickUnique } from '../src/music/lyric-cmd.ts'
import { isCreditLine } from '../src/music/kugou-lyric.ts'
import type { Track } from '../src/music/netease.ts'

const track = (id: string, title: string, artists: string[], durationMs: number | null): Track => ({
  id, title, artists, album: null, albumId: null, durationMs, coverUrl: null,
  aliases: [], translations: [], trackNo: null, discNo: null, publishTime: null, popularity: null, fee: null,
})

/** 2026-10-22 实测的「年轮」搜索结果前几条。 */
const NIANLUN = [
  track('32897777', '年轮', ['汪苏泷'], 245822),
  track('32619064', '年轮', ['张碧晨'], 274504),
  track('2730161536', '年轮 (DJ版)', ['DJ小楷'], 277822),
  track('1304922103', '年轮', ['张碧晨', '周芷莹'], 113000),
  track('3348123746', '年轮', ['小雪'], 275000),
]

test('只给歌名：多个版本并列 → 报歧义，不替用户选', () => {
  const candidates = pickLyricCandidates(NIANLUN, { title: '年轮', durationMs: null })
  assert.ok(candidates.length > 1, '应当有多个候选')
  // 关键：不能因为"第一条"就定了。汪苏泷排第一但那是男声版。
  assert.equal(pickUnique(candidates), null, '并列时必须返回 null，交给调用方报歧义')
})

test('歌名 + 歌手：张碧晨原版胜出，不被翻唱/对唱版干扰', () => {
  const candidates = pickLyricCandidates(NIANLUN, { title: '年轮 张碧晨', durationMs: null })
  const picked = pickUnique(candidates)
  assert.ok(picked, `应当能定下唯一版本，实际候选=${candidates.map((c) => c.track.id)}`)
  assert.equal(picked.track.id, '32619064')
  assert.deepEqual(picked.track.artists, ['张碧晨'])
  // 「张碧晨/周芷莹」是对唱现场版（113s），不能也算完全匹配
  assert.ok(!candidates.some((c) => c.track.id === '1304922103' && c.titleScore >= 1))
})

test('给了基准时长：时长对不上的候选直接剔除', () => {
  const candidates = pickLyricCandidates(NIANLUN, { title: '年轮', durationMs: 274_000 })
  // 汪苏泷 246s、对唱 113s 都该被 3 秒容差剔除
  assert.ok(!candidates.some((c) => c.track.id === '32897777'), '汪苏泷版差 28 秒，必须剔除')
  assert.ok(!candidates.some((c) => c.track.id === '1304922103'), '对唱版差 161 秒，必须剔除')
  assert.ok(candidates.some((c) => c.track.id === '32619064'), '张碧晨原版 274.5s 应当保留')
})

test('搜不到就是空，不回退到第一条', () => {
  assert.deepEqual(pickLyricCandidates(NIANLUN, { title: '完全不存在的歌', durationMs: null }), [])
  assert.equal(pickUnique([]), null)
})

test('单曲 ref 走直取，候选只有一个时直接用它', () => {
  const only = pickLyricCandidates([track('1', '晴天', ['周杰伦'], 269000)], { title: '晴天', durationMs: null })
  assert.equal(pickUnique(only)?.track.id, '1')
})

test('歌词文件后缀约定：逐字写 .lrc，逐行写 .line.lrc', () => {
  // 与下载时的约定一致（v0.12.5）：播放器只按 <歌名>.lrc 找 sidecar，
  // 换个扩展名等于永远不被读取
  assert.deepEqual(lyricFilePaths('/m/a.lrc', true), { main: '/m/a.lrc', line: '/m/a.line.lrc' })
  // 只要逐行时只写一份
  assert.deepEqual(lyricFilePaths('/m/a.lrc', false), { main: '/m/a.lrc', line: '/m/a.lrc' })
  // 显式给了 .line.lrc 也认
  assert.deepEqual(lyricFilePaths('/m/a.line.lrc', true), { main: '/m/a.lrc', line: '/m/a.line.lrc' })
})

test('制作人员行不算歌词', () => {
  // 实测酷狗 KRC 把这三行带出来了，时间戳挤在开头几秒，
  // 播放器会当成第一句"歌词"高亮
  assert.equal(isCreditLine('[00:04.70] 词：汪苏泷'), true)
  assert.equal(isCreditLine('[00:09.40] 曲：汪苏泷'), true)
  assert.equal(isCreditLine('[00:14.10] 编曲：汪苏泷'), true)
  assert.equal(isCreditLine('作词 : 汪苏泷'), true)
  assert.equal(isCreditLine('制作人：某某'), true)
  // 正常歌词不能被误杀
  assert.equal(isCreditLine('[00:18.81] 圆圈勾勒成指纹'), false)
  assert.equal(isCreditLine('回忆苦涩的吻痕'), false)
})

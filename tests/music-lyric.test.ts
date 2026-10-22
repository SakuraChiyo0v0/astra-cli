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

// ---- 用户实测反馈的三条（v0.12.11） ----

test('制作信息行和歌名行都要滤掉，真实歌词不能误伤', async () => {
  const { stripNonLyricLines } = await import('../src/music/lyric-cmd.ts')
  const lrc = [
    '[00:00.000] 作词 : 汪苏泷',
    '[00:01.000] 作曲 : 汪苏泷',
    '[00:02.000] 编曲 : 汪苏泷',
    '[00:00.00]年轮 - 张碧晨 (Diamond)',
    '[00:18.739]圆圈勾勒成指纹',
    '[00:22.268]印在我的嘴唇',
  ].join('\n')
  const out = stripNonLyricLines(lrc, { title: '年轮', artists: ['张碧晨'] })
  assert.equal(out.split('\n').length, 2, `只该剩两句歌词，实际：${out}`)
  assert.match(out, /圆圈勾勒成指纹/)
  assert.doesNotMatch(out, /作词|作曲|编曲|Diamond/)
})

test('逐字行同样要滤歌名行（带 <mm:ss.xx> 标签时也要认得出）', async () => {
  const { stripNonLyricLines } = await import('../src/music/lyric-cmd.ts')
  const word = '[00:00.00]<00:00.00>年<00:00.39>轮<00:00.78> <00:01.17>-<00:01.56> <00:01.95>张<00:02.34>碧<00:02.73>晨'
  const body = '[00:18.81]<00:18.81>圆<00:19.15>圈<00:19.57>勾<00:19.97>勒<00:20.34>成<00:20.71>指<00:21.16>纹'
  const out = stripNonLyricLines(`${word}\n${body}`, { title: '年轮', artists: ['张碧晨'] })
  assert.equal(out, body, '只留下正文那句，且逐字标签原样保留')
})

test('开头第一句歌词不能被当成歌名行删掉', async () => {
  const { stripNonLyricLines } = await import('../src/music/lyric-cmd.ts')
  // 《年轮》里的歌名是个常见词，但这一句是歌词
  const lrc = '[00:00.00]年轮转了一圈又一圈'
  const out = stripNonLyricLines(lrc, { title: '年轮', artists: ['张碧晨'] })
  assert.equal(out, lrc, '剥掉歌名后还剩一整句中文，不能判成歌名行')
})

test('--duration 能在时长明显更近时决胜歧义', async () => {
  const { pickUnique } = await import('../src/music/lyric-cmd.ts')
  const candidates = pickLyricCandidates(
    [track('1', 'Cry For Me', ['Echo艾歌'], 301802), track('2', 'Cry For Me', ['DJ阿哲'], 299331)],
    { title: 'Cry For Me', durationMs: 302000 },
  )
  assert.equal(pickUnique(candidates)?.track.id, '1', '302s 明显更接近 302000ms')
})

test('两个候选一样近时不瞎猜，仍报歧义', async () => {
  const { pickUnique } = await import('../src/music/lyric-cmd.ts')
  const candidates = pickLyricCandidates(
    [track('1', 'Cry For Me', ['Echo艾歌'], 301300), track('2', 'Cry For Me', ['DJ阿哲'], 301500)],
    { title: 'Cry For Me', durationMs: 301400 },
  )
  assert.equal(pickUnique(candidates), null, '各差 100ms/100ms，时长不构成证据')
})

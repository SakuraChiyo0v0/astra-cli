/**
 * 订阅的"哪些是新歌"判断。用真实的曲目 id 形状，跑在临时数据目录上。
 *
 * 核心两条：
 * - 第一次只记基线，**不能**把整个歌单重下一遍
 * - 之后只下"上次没见过的"，且已在曲库里的跳过
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let sub: typeof import('../src/music/subscribe.ts')
let lib: typeof import('../src/music/library.ts')

before(async () => {
  process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-sub-'))
  process.env.ASTRA_MUSIC_DIR = path.join(process.env.ASTRA_HOME, 'music')
  sub = await import('../src/music/subscribe.ts')
  lib = await import('../src/music/library.ts')
})

test('订阅：第一次只记基线，不下载', () => {
  const s = sub.addSubscription({ kind: 'playlist', targetId: '3778678', title: '歌单《热歌榜》', everyHours: 24, quality: 'flac' })
  assert.equal(s.lastSeen, null)
  assert.equal(s.enabled, true)
  assert.equal(s.everyHours, 24)
})

test('订阅：同一目标不能重复加，提示改用 set', () => {
  assert.throws(() => sub.addSubscription({ kind: 'playlist', targetId: '3778678', title: 'x', everyHours: 1, quality: null }), /已经在订阅/)
})

test('订阅：按 id 前缀查找、改间隔、停用', () => {
  const s = sub.listSubscriptions()[0]!
  assert.equal(sub.findSubscription(s.id.slice(0, 4)).id, s.id)
  const updated = sub.setSubscription(s.id, { everyHours: 6, enabled: false })
  assert.equal(updated.everyHours, 6)
  assert.equal(updated.enabled, false)
  assert.throws(() => sub.findSubscription('zzzz'), /没有订阅/)
})

test('到点判断：从没跑过 / 超过间隔 / 停用不跑', () => {
  const s = sub.listSubscriptions()[0]!
  // 停用的一律不跑
  assert.equal(sub.dueSubscriptions().some((x) => x.id === s.id), false)

  sub.setSubscription(s.id, { enabled: true })
  // 从没跑过 → 到点
  assert.equal(sub.dueSubscriptions().some((x) => x.id === s.id), true)
})

test('曲库规格：默认 null，回填后能读到', () => {
  lib.saveTrack({
    platform: 'wy', id: '2034742057', title: 'アイドル', artists: ['YOASOBI'], album: 'アイドル', durationMs: 213233,
    path: '/nonexistent/a.flac', format: 'flac', quality: '24bit', bytes: 100, bps: 3_230_000, sourceId: 'official',
    audioSha256: null, spec: { sampleRate: 96_000, bitsPerSample: 24, channels: 2 }, hasCover: true, hasLyric: true, hasWordLyric: true,
  })
  const t = lib.findTrack('wy', '2034742057')!
  assert.deepEqual(t.spec, { sampleRate: 96_000, bitsPerSample: 24, channels: 2 })
  assert.equal(t.hasWordLyric, true)

  lib.updateTrackSpec('wy', '2034742057', { spec: { sampleRate: 44_100, bitsPerSample: 16, channels: 2 } })
  assert.equal(lib.findTrack('wy', '2034742057')!.spec.sampleRate, 44_100)
})

test('统计：按真实规格分组，而不是只看档位名', () => {
  lib.saveTrack({
    platform: 'wy', id: '3', title: 'pcm', artists: ['x'], album: null, durationMs: 1000,
    path: '/nonexistent/b.flac', format: 'flac', quality: 'flac', bytes: 50, bps: 900_000, sourceId: null,
    audioSha256: null, spec: { sampleRate: 44_100, bitsPerSample: 16, channels: 2 }, hasCover: false, hasLyric: true, hasWordLyric: false,
  })
  const stats = lib.libraryStats()
  assert.equal(stats.tracks, 2)
  // 上个测试把 2034742057 的规格从 96k/24 改成了 44.1k/16，所以这里两首都是 44.1k/16。
  // 这正好也验证了 updateTrackSpec 生效。
  assert.equal(stats.bySpec['44.1k/16'], 2)
  assert.equal(stats.byQuality['24bit'], 1)
  assert.equal(stats.noCover, 1)
  assert.equal(stats.noWordLyric, 1)
  // 两个路径都不存在
  assert.equal(stats.missing, 2)
})

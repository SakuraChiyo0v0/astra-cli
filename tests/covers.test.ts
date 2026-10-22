/**
 * `music covers`：给专辑目录补 cover.jpg。
 *
 * 用户实测反馈的缺口：**有内嵌封面却没写出来**时，返回里看不出漏了哪些。
 * 两类真实情形：
 * 1. 一个目录里第一首歌没有内嵌封面（纯音乐 / 翻唱），第二首有 ——
 *    只试第一首就会误报"这目录没封面"
 * 2. 同一张专辑的曲目分散在多个目录（合作曲按主歌手归目录后）
 *
 * 这里用真实的 FLAC 文件（ffmpeg 生成 + 真的写进 PICTURE 块），不 mock。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { archiveAlbumCovers } from '../src/music/library-io.ts'
import { saveTrack } from '../src/music/library.ts'
import { retagFlac } from '../src/music/tags.ts'

const PNG = readFileSync(new URL('./fixtures/cover.png', import.meta.url))

/** 造一个 FLAC：带封面或不带。 */
function makeFlac(dir: string, name: string, withCover: boolean): string {
  const file = path.join(dir, name)
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', file], { encoding: 'utf8' })
  if (made.error || made.status !== 0) throw new Error(`造夹具失败：${made.stderr}`)
  if (withCover) {
    const updated = retagFlac(readFileSync(file), {
      title: name, artists: ['测试'], album: '专辑', albumArtists: ['测试'],
      date: null, trackNo: null, trackTotal: null, discNo: null, publisher: null,
      lyrics: null, cover: { mime: 'image/png', data: PNG },
      source: { platform: 'netease', id: name },
    })
    writeFileSync(file, updated)
  }
  return file
}

function register(file: string, id: string): void {
  saveTrack({
    platform: 'netease', id, title: path.basename(file), artists: ['测试'], album: '专辑',
    durationMs: 1000, path: file, format: 'flac', quality: 'flac',
    bytes: null, bps: null, sourceId: null, audioSha256: null,
  })
}

process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-covers-home-'))

test('目录里排在前面的那首没封面、后面的有：仍应当写得出来', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-covers-a-'))
  const albumDir = path.join(dir, '专辑')
  mkdirSync(albumDir, { recursive: true })
  // 注意 allTracks() 是 `order by created_at desc` —— 后注册的排在前面。
  // 所以先注册"有封面"的、再注册"没封面"的，才能让**没封面的排第一**，
  // 真正复现"只试第一首就会误报"的场景。
  register(makeFlac(albumDir, '02-with-cover.flac', true), 'a2')
  register(makeFlac(albumDir, '01-no-cover.flac', false), 'a1')

  const result = await archiveAlbumCovers()
  assert.equal(existsSync(path.join(albumDir, 'cover.jpg')), true, '同目录里还有一首有封面，就该写得出来')
  assert.ok(!result.missing.some((m) => m.dir === albumDir), '写出来了就不该出现在 missing 里')
})

test('整目录都没有内嵌封面：列进 missing 并说明原因', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-covers-b-'))
  const albumDir = path.join(dir, '无封面专辑')
  mkdirSync(albumDir, { recursive: true })
  register(makeFlac(albumDir, '01.flac', false), 'b1')

  const result = await archiveAlbumCovers()
  const entry = result.missing.find((m) => m.dir === albumDir)
  assert.ok(entry, `没有封面的目录必须出现在 missing 里，实际：${JSON.stringify(result.missing)}`)
  assert.match(entry.reason, /没有内嵌封面/)
})

test('同一专辑散在两个目录：每个目录都要有自己的 cover.jpg', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-covers-c-'))
  const d1 = path.join(dir, '歌手A', '专辑')
  const d2 = path.join(dir, '歌手B', '专辑')
  mkdirSync(d1, { recursive: true })
  mkdirSync(d2, { recursive: true })
  register(makeFlac(d1, '01.flac', true), 'c1')
  register(makeFlac(d2, '02.flac', true), 'c2')

  await archiveAlbumCovers()
  assert.equal(existsSync(path.join(d1, 'cover.jpg')), true, '第一个目录要有')
  assert.equal(existsSync(path.join(d2, 'cover.jpg')), true, '第二个目录也要有 —— 不能因为专辑同名就跳过')
})

test('已有 cover.jpg 的目录跳过，不重复写', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-covers-d-'))
  const albumDir = path.join(dir, '有封面了')
  mkdirSync(albumDir, { recursive: true })
  writeFileSync(path.join(albumDir, 'cover.jpg'), PNG)
  register(makeFlac(albumDir, '01.flac', true), 'd1')

  const result = await archiveAlbumCovers()
  assert.equal(result.skipped >= 1, true)
  assert.ok(!result.missing.some((m) => m.dir === albumDir))
})

/**
 * `music covers`：给专辑目录补 cover.jpg。
 *
 * 清单 P2#13 的核心要求：**以目录为准，不以曲库记录为准**。
 * 原来的实现遍历 `allTracks()`，曲库没收录的专辑（手动放进去的、
 * 下载后没入库的、记录被 forget 掉的）根本不在遍历范围里 ——
 * `written` 看着全部成功，实际漏了目录，`failed` 还是空的。
 *
 * 这些测试用真实的 FLAC（ffmpeg 生成 + 真的写进 PICTURE 块），不 mock。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { archiveAlbumCovers, findAlbumDirs } from '../src/music/library-io.ts'
import { saveTrack } from '../src/music/library.ts'
import { retagFlac } from '../src/music/tags.ts'

const PNG = readFileSync(new URL('./fixtures/cover.png', import.meta.url))

process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-covers-home-'))

/** 造一个 FLAC：带封面或不带。 */
function makeFlac(dir: string, name: string, withCover: boolean): string {
  mkdirSync(dir, { recursive: true })
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

test('findAlbumDirs：只认直接装音频的目录，歌手那层不算', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'astra-covers-scan-'))
  makeFlac(path.join(root, '歌手', '专辑A'), '01.flac', false)
  makeFlac(path.join(root, '歌手', '专辑B'), '01.flac', false)
  const dirs = await findAlbumDirs(root).then((d) => d.map((x) => path.basename(x)).sort())
  assert.deepEqual(dirs, ['专辑A', '专辑B'], '歌手目录本身没有音频，不该算专辑目录')
})

test('曲库没收录的专辑也要覆盖（P2#13 的核心）', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'astra-covers-unreg-'))
  const albumDir = path.join(root, 'YOASOBI', 'アイドル')
  // 文件在磁盘上，但**完全不注册进曲库** —— 复现"手动放进来 / 下载后没入库"
  makeFlac(albumDir, '01 アイドル.flac', true)

  const result = await archiveAlbumCovers(undefined, undefined, { root })
  assert.equal(existsSync(path.join(albumDir, 'cover.jpg')), true, '以目录为准就该扫到它')
  assert.equal(result.dirs, 1)
  assert.equal(result.written, 1)
  assert.equal(result.missing.length, 0, `不该有漏的，实际：${JSON.stringify(result.missing)}`)
})

test('目录里排在前面的那首没封面、后面的有：仍应当写得出来', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'astra-covers-a-'))
  const albumDir = path.join(root, '专辑')
  // allTracks() 是 created_at desc —— 后注册的排前面。
  // 先注册有封面的、再注册没封面的，才能让"没封面的排第一"。
  makeFlac(albumDir, '02-with-cover.flac', true)
  makeFlac(albumDir, '01-no-cover.flac', false)

  const result = await archiveAlbumCovers(undefined, undefined, { root })
  assert.equal(existsSync(path.join(albumDir, 'cover.jpg')), true, '同目录里还有一首有封面，就该写得出来')
  assert.ok(!result.missing.some((m) => m.dir === albumDir))
})

test('整目录都没有内嵌封面：列进 missing 并说明原因', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'astra-covers-b-'))
  const albumDir = path.join(root, '无封面专辑')
  makeFlac(albumDir, '01.flac', false)

  const result = await archiveAlbumCovers(undefined, undefined, { root })
  const entry = result.missing.find((m) => m.dir === albumDir)
  assert.ok(entry, `没有封面的目录必须出现在 missing 里，实际：${JSON.stringify(result.missing)}`)
  assert.match(entry.reason, /没有内嵌封面/)
})

test('同一专辑散在两个目录：每个目录都要有自己的 cover.jpg', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'astra-covers-c-'))
  const d1 = path.join(root, '歌手A', '专辑')
  const d2 = path.join(root, '歌手B', '专辑')
  makeFlac(d1, '01.flac', true)
  makeFlac(d2, '02.flac', true)

  await archiveAlbumCovers(undefined, undefined, { root })
  assert.equal(existsSync(path.join(d1, 'cover.jpg')), true, '第一个目录要有')
  assert.equal(existsSync(path.join(d2, 'cover.jpg')), true, '第二个目录也要有 —— 不能因为专辑同名就跳过')
})

test('已有 cover.jpg 的目录跳过，dirs/hasCover 如实计数', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'astra-covers-d-'))
  const albumDir = path.join(root, '有封面了')
  makeFlac(albumDir, '01.flac', true)
  writeFileSync(path.join(albumDir, 'cover.jpg'), PNG)

  const result = await archiveAlbumCovers(undefined, undefined, { root })
  assert.equal(result.skipped, 1)
  assert.equal(result.dirs, 1)
  assert.equal(result.hasCover, 1, '原有 cover.jpg 也算 hasCover')
  assert.equal(result.missing.length, 0)
})

test('跑完之后 dirs == hasCover + missing.length（自检恒等式）', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'astra-covers-e-'))
  makeFlac(path.join(root, '有封面'), '01.flac', true)
  makeFlac(path.join(root, '没封面'), '01.flac', false)

  const result = await archiveAlbumCovers(undefined, undefined, { root })
  assert.equal(result.dirs, 2)
  assert.equal(result.hasCover + result.missing.length, result.dirs, '这两项加起来必须等于扫到的目录数')
})

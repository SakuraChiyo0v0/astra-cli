/**
 * 标签写入：用 ffmpeg 生成的真实 FLAC / MP3（带原有标签），写完再用 ffprobe 回读（本机有 ffprobe 时）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { audioPayload, parseFlacBlocks, retagFlac, retagMp3, writeTags, type TagData } from '../src/music/tags.ts'
import { detectFormat, parseFlacStreamInfo, summarize } from '../src/music/audio.ts'

const fixture = (name: string): Buffer => readFileSync(new URL(`./fixtures/${name}`, import.meta.url))

// ffmpeg 生成的 8x8 PNG（手写的字节解码会报错，混淆"音频坏了"和"封面坏了"）
const PNG = fixture('cover.png')

const tags: TagData = {
  title: 'アイドル',
  artists: ['YOASOBI', 'Ayase'],
  album: '测试专辑',
  albumArtists: ['YOASOBI'],
  date: '2023-04-12',
  trackNo: 3,
  trackTotal: 10,
  discNo: 1,
  publisher: 'Sony',
  lyrics: '第一行\n第二行',
  cover: { mime: 'image/png', data: PNG },
  source: { platform: 'netease', id: '2034742057' },
  extra: { BILIBILI_BVID: 'BV17x411w7KC', BILIBILI_URL: 'https://www.bilibili.com/video/BV17x411w7KC' },
}

function ffprobeTags(file: string): Record<string, string> | null {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', file], { encoding: 'utf8' })
  if (r.error || r.status !== 0) return null
  const tagsOut = (JSON.parse(r.stdout) as { format?: { tags?: Record<string, string> } }).format?.tags ?? {}
  return Object.fromEntries(Object.entries(tagsOut).map(([k, v]) => [k.toLowerCase(), v]))
}

function ffmpegDecodes(file: string): boolean | null {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-f', 'null', '-'], { encoding: 'utf8' })
  if (r.error) return null
  return r.status === 0 && r.stderr.trim() === ''
}

test('FLAC：替换标签，音频帧逐字节不变，可完整解码', () => {
  const original = fixture('tone.flac')
  const updated = retagFlac(original, tags)
  assert.deepEqual(audioPayload(updated, 'flac'), audioPayload(original, 'flac'))
  // 再写一次（覆盖已有的 VORBIS_COMMENT / PICTURE）也要稳定
  const twice = retagFlac(updated, tags)
  assert.deepEqual(audioPayload(twice, 'flac'), audioPayload(original, 'flac'))
  const types = parseFlacBlocks(twice).blocks.map((b) => b.type)
  assert.equal(types.filter((t) => t === 4).length, 1, '只能有一个 VORBIS_COMMENT')
  assert.equal(types.filter((t) => t === 6).length, 1, '只能有一个 PICTURE')

  const dir = mkdtempSync(path.join(tmpdir(), 'astra-tags-'))
  const file = path.join(dir, 'a.flac')
  writeFileSync(file, twice)
  const read = ffprobeTags(file)
  if (read) {
    assert.equal(read.title, 'アイドル')
    assert.equal(read.album, '测试专辑')
    assert.match(read.artist ?? '', /YOASOBI/)
    assert.equal(read.source_id, '2034742057')
    assert.equal(read.lyrics, '第一行\n第二行')
    // 自定义字段：FLAC 用同名 Vorbis 键，键名统一大写
    assert.equal(read.bilibili_bvid, 'BV17x411w7KC')
    assert.equal(read.bilibili_url, 'https://www.bilibili.com/video/BV17x411w7KC')
  }
  assert.notEqual(ffmpegDecodes(file), false)
})

test('MP3：去掉旧 ID3 写 v2.4，音频帧逐字节不变', () => {
  const original = fixture('tone.mp3')
  const updated = retagMp3(original, tags)
  assert.deepEqual(audioPayload(updated, 'mp3'), audioPayload(original, 'mp3'))
  assert.equal(updated.subarray(0, 4).toString('latin1'), 'ID3\u0004')

  const dir = mkdtempSync(path.join(tmpdir(), 'astra-tags-'))
  const file = path.join(dir, 'a.mp3')
  writeFileSync(file, retagMp3(updated, tags))
  const read = ffprobeTags(file)
  if (read) {
    assert.equal(read.title, 'アイドル')
    assert.equal(read.track, '3/10')
    assert.equal(read.album_artist, 'YOASOBI')
    assert.equal(read.source, 'netease')
    // 自定义字段：ID3 写在 TXXX 里，ffprobe 有的版本报成纯描述、有的报成 `TXXX:描述`
    assert.equal(read.bilibili_bvid ?? read['txxx:bilibili_bvid'], 'BV17x411w7KC')
  }
  assert.notEqual(ffmpegDecodes(file), false)
})

test('writeTags：m4a 等不支持的格式不改文件，给原因', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-tags-'))
  const file = path.join(dir, 'a.m4a')
  writeFileSync(file, Buffer.from('00000018667479704d344120', 'hex'))
  const r = await writeTags(file, 'm4a', tags)
  assert.equal(r.written, false)
  assert.match(r.reason ?? '', /m4a/)
})

test('格式探测：只看字节', () => {
  assert.equal(detectFormat(fixture('tone.flac')), 'flac')
  assert.equal(detectFormat(fixture('tone.mp3')), 'mp3')
  assert.equal(detectFormat(Buffer.from('<html><body>404</body></html>')), 'unknown')
  assert.equal(detectFormat(Buffer.alloc(0)), 'unknown')
  // 写过 ID3v2.4 的 MP3 仍识别为 mp3
  assert.equal(detectFormat(retagMp3(fixture('tone.mp3'), tags)), 'mp3')
})

test('FLAC STREAMINFO：区分 16bit/44.1k 与 24bit/96k', () => {
  const a = parseFlacStreamInfo(fixture('tone.flac'))
  assert.equal(a?.sampleRate, 44100)
  assert.equal(a?.bitsPerSample, 16)
  const b = parseFlacStreamInfo(fixture('tone24.flac'))
  assert.equal(b?.sampleRate, 96000)
  assert.equal(b?.bitsPerSample, 24)
  assert.equal(summarize(fixture('tone24.flac'), 114249, null).quality, '24bit')
  assert.equal(summarize(fixture('tone.flac'), 20669, null).quality, 'flac')
})

test('码率反推档位：按真实大小算，宁可低估', () => {
  const mp3 = fixture('tone.mp3')
  // 3412653 字节 / 213 秒 ≈ 128kbps —— 实测 qdy 请求 flac 拿到的就是这个
  assert.equal(summarize(mp3, 3412653, 213233).quality, '128k')
  assert.equal(summarize(mp3, 8_530_000, 213233).quality, '320k')
  assert.equal(summarize(mp3, null, 213233).quality, '128k')
  const html = summarize(Buffer.from('<html>404 Not Found</html>'), 300, 213233)
  assert.equal(html.format, 'unknown')
  assert.match(html.problem ?? '', /网页/)
})

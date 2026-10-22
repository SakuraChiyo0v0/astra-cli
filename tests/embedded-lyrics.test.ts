/**
 * 内嵌歌词必须是带时间戳的同步格式。
 *
 * 起因：`music.lyric = both` 时 `.lrc` / `.word.lrc` 都带时间戳，但写进文件的内嵌
 * `LYRICS` 是剥掉时间戳的纯文本 —— Navidrome 解析不出滚动歌词，直接显示"无歌词"。
 *
 * 真夹具：`tests/fixtures/idol.krc` 是酷狗「アイドル」的真实逐字歌词，
 * 经 `toEnhancedLrc` 出来是 `[00:00.03]<00:00.03>...` 这种增强 LRC。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { decodeKrc, parseKrc, toEnhancedLrc } from '../src/music/kugou-lyric.ts'
import { embedsLyric, writesLrcFile, pickEmbeddedLyrics, lyricText } from '../src/music/download.ts'
import { retagFlac, retagMp3, parseFlacBlocks, id3v2End, audioPayload } from '../src/music/tags.ts'

/** 写标签用的最小 TagData（不带封面 / 歌词）。 */
const BASE = {
  title: 'アイドル', artists: ['YOASOBI'], album: 'アイドル', albumArtists: ['YOASOBI'],
  date: '2023-04-12', trackNo: 1, trackTotal: 1, discNo: null, publisher: null,
  cover: null, source: { platform: 'netease', id: '1' },
}

const LRC = '[00:12.34]第一行\n[00:15.00]第二行'
const ENHANCED = '[00:12.34]<00:12.34>第一<00:12.80>行\n[00:15.00]<00:15.00>第二行'
const PLAIN = '第一行\n第二行'

const all = { enhanced: ENHANCED, lrc: LRC, plain: PLAIN }

test('embed 用带时间戳的，不用纯文本', () => {
  const picked = pickEmbeddedLyrics('embed', all)
  assert.equal(picked, ENHANCED, '逐字优先')
  assert.match(picked!, /<\d{2}:\d{2}\.\d{2}>/)
})

test('没有逐字时退回普通 LRC（仍带 [mm:ss.xx]）', () => {
  const picked = pickEmbeddedLyrics('embed', { lrc: LRC, plain: PLAIN })
  assert.equal(picked, LRC)
  assert.match(picked!, /^\[\d{2}:\d{2}\.\d{2}\]/)
})

test('embed-synced 与 embed 行为一致', () => {
  assert.equal(pickEmbeddedLyrics('embed-synced', all), pickEmbeddedLyrics('embed', all))
})

test('embed-plain 明确要纯文本（老播放器退路）', () => {
  assert.equal(pickEmbeddedLyrics('embed-plain', all), PLAIN)
})

test('both 内嵌也用同步格式', () => {
  assert.equal(pickEmbeddedLyrics('both', all), ENHANCED)
})

test('只有纯文本时不会返回 null —— 有总比没有好', () => {
  assert.equal(pickEmbeddedLyrics('embed', { plain: PLAIN }), PLAIN)
})

test('什么都不写歌词时返回 null', () => {
  assert.equal(pickEmbeddedLyrics('none', all), null)
  assert.equal(pickEmbeddedLyrics('lrc', all), null, 'lrc 只落盘不内嵌')
})

test('embeds / writesLrcFile 与取值对应', () => {
  for (const mode of ['embed', 'embed-synced', 'embed-plain', 'both']) assert.equal(embedsLyric(mode), true, mode)
  for (const mode of ['lrc', 'none']) assert.equal(embedsLyric(mode), false, mode)
  for (const mode of ['lrc', 'both']) assert.equal(writesLrcFile(mode), true, mode)
  for (const mode of ['embed', 'embed-synced', 'embed-plain', 'none']) assert.equal(writesLrcFile(mode), false, mode)
})

test('真夹具：酷狗逐字歌词转出来确实带时间戳', () => {
  const raw = readFileSync(new URL('./fixtures/idol.krc', import.meta.url))
  const krc = parseKrc(decodeKrc(raw))
  const enhanced = toEnhancedLrc(krc)
  // 内嵌走的就是这一份
  const picked = pickEmbeddedLyrics('embed', { enhanced, plain: PLAIN })
  assert.equal(picked, enhanced)
  assert.match(picked!, /^\[\d{2}:\d{2}\.\d{2}\]/, '每行以 [mm:ss.xx] 开头')
  assert.match(picked!, /<\d{2}:\d{2}\.\d{2}>/, '含逐字 <mm:ss.xx>')
})

test('写进文件的歌词带时间戳（FLAC / MP3 都验）', () => {
  const raw = readFileSync(new URL('./fixtures/idol.krc', import.meta.url))
  const enhanced = toEnhancedLrc(parseKrc(decodeKrc(raw)))
  const lyrics = pickEmbeddedLyrics('both', { enhanced })!
  const tags = { ...BASE, lyrics }

  // FLAC：从 VORBIS_COMMENT 里按长度前缀正确解析，不能用 toString 后切行
  const flac = retagFlac(readFileSync(new URL('./fixtures/tone.flac', import.meta.url)), tags)
  const vorbis = parseFlacBlocks(flac).blocks.find((b) => b.type === 4)!.data
  let p = 4 + vorbis.readUInt32LE(0)
  const count = vorbis.readUInt32LE(p)
  p += 4
  let flacLyrics = ''
  for (let i = 0; i < count; i += 1) {
    const len = vorbis.readUInt32LE(p)
    p += 4
    const entry = vorbis.subarray(p, p + len).toString('utf8')
    p += len
    if (entry.startsWith('LYRICS=')) flacLyrics = entry
  }
  assert.match(flacLyrics, /^LYRICS=\[\d{2}:\d{2}\.\d{2}\]/, 'FLAC 的 LYRICS 必须以时间戳开头')

  // MP3：USLT 帧的正文
  const mp3 = retagMp3(readFileSync(new URL('./fixtures/tone.mp3', import.meta.url)), tags)
  const end = id3v2End(mp3)
  let q = 10
  let uslt = ''
  while (q + 10 <= end) {
    const id = mp3.subarray(q, q + 4).toString('latin1')
    if (!/^[A-Z0-9]{4}$/.test(id)) break
    const size = ((mp3[q + 4]! & 0x7f) << 21) | ((mp3[q + 5]! & 0x7f) << 14) | ((mp3[q + 6]! & 0x7f) << 7) | (mp3[q + 7]! & 0x7f)
    if (id === 'USLT') uslt = mp3.subarray(q + 10, q + 10 + size).toString('utf8')
    q += 10 + size
  }
  assert.match(uslt, /\[\d{2}:\d{2}\.\d{2}\]/, 'MP3 的 USLT 必须含时间戳')
})

test('写歌词不动音频字节', () => {
  const audio = (buf: Buffer, format: 'flac' | 'mp3'): string => createHash('sha256').update(audioPayload(buf, format)).digest('hex')
  const flacSrc = readFileSync(new URL('./fixtures/tone.flac', import.meta.url))
  const flacDst = retagFlac(flacSrc, { ...BASE, lyrics: LRC })
  assert.equal(audio(flacDst, 'flac'), audio(flacSrc, 'flac'))

  const mp3Src = readFileSync(new URL('./fixtures/tone.mp3', import.meta.url))
  const mp3Dst = retagMp3(mp3Src, { ...BASE, lyrics: LRC })
  assert.equal(audio(mp3Dst, 'mp3'), audio(mp3Src, 'mp3'))
})

/**
 * 歌词文件的命名规则与内容分工。
 *
 * 播放器 / Navidrome 只按 `<歌名>.lrc` 找 sidecar。以前逐字写成 `.word.lrc`，
 * 等于永远不被读取 —— 内容再对也没用。现在 `.lrc` 放逐字，`.line.lrc` 放逐行兜底。
 */
test('逐字进 .lrc；.line.lrc 是剥掉时间戳的逐行版', () => {
  const raw = readFileSync(new URL('./fixtures/idol.krc', import.meta.url))
  const enhanced = toEnhancedLrc(parseKrc(decodeKrc(raw)))

  // .lrc 的内容：带 [mm:ss.xx] 或 <mm:ss.xx>
  assert.match(enhanced, /^\[\d{2}:\d{2}\.\d{2}\]/, '逐字文件每行以 LRC 时间戳开头')
  assert.match(enhanced, /<\d{2}:\d{2}\.\d{2}>/, '逐字文件含逐字标签')

  // .line.lrc 的内容：同一个 lyricText() 产出，时间戳被剥干净
  const plain = lyricText(enhanced)
  assert.ok(plain.length > 0, '逐行版不能是空的')
  assert.doesNotMatch(plain, /\[\d{2}:\d{2}/, '逐行版没有 [mm:ss]')
  assert.doesNotMatch(plain, /<\d{2}:\d{2}/, '逐行版没有 <mm:ss>')
  // 剥掉时间戳后歌词正文还在
  assert.ok(plain.split('\n').some((l) => l.trim().length > 0))
})

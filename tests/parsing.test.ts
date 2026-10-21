import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTarget } from '../src/music/target.ts'
import { renderTemplate, resolveInside, sanitizeSegment } from '../src/music/paths.ts'
import { mergeLrc } from '../src/music/download.ts'
import { beijingDate } from '../src/music/netease.ts'
import { durationGap, identityMismatch, ladder, MAX_DURATION_GAP_SECONDS } from '../src/music/resolve.ts'
import { summarize } from '../src/music/audio.ts'
import { readFileSync } from 'node:fs'

test('目标解析：ref / 数字 id / 各种网易云链接 / 关键词', () => {
  assert.deepEqual(parseTarget('wy:186016'), { kind: 'song', id: '186016' })
  assert.deepEqual(parseTarget('album:34720827'), { kind: 'album', id: '34720827' })
  assert.deepEqual(parseTarget('playlist:3778678'), { kind: 'playlist', id: '3778678' })
  assert.deepEqual(parseTarget('2034742057'), { kind: 'song', id: '2034742057' })
  assert.deepEqual(parseTarget('https://music.163.com/#/song?id=186016'), { kind: 'song', id: '186016' })
  assert.deepEqual(parseTarget('https://music.163.com/song?id=186016&userid=1'), { kind: 'song', id: '186016' })
  assert.deepEqual(parseTarget('https://y.music.163.com/m/song?id=186016&uct2=x'), { kind: 'song', id: '186016' })
  assert.deepEqual(parseTarget('分享歌单 https://music.163.com/playlist?id=3778678&uct=1 (@网易云音乐)'), { kind: 'playlist', id: '3778678' })
  assert.deepEqual(parseTarget('https://music.163.com/#/album?id=34720827'), { kind: 'album', id: '34720827' })
  assert.deepEqual(parseTarget('https://music.163.com/#/artist?id=6452'), { kind: 'artist', id: '6452' })
  assert.deepEqual(parseTarget('https://music.163.com/#/discover/toplist?id=3778678'), { kind: 'playlist', id: '3778678' })
  // 短数字更可能是歌名（"1987"、"2002 年的第一场雪"），不当 id
  assert.deepEqual(parseTarget('1987'), { kind: 'keyword', keyword: '1987' })
  assert.deepEqual(parseTarget('晴天 周杰伦'), { kind: 'keyword', keyword: '晴天 周杰伦' })
})

test('路径：净化在套模板之前（AC/DC 不多出一层目录）', () => {
  const vars = { artist: 'AC/DC', albumartist: 'AC/DC', album: 'Back in Black', title: 'Hells Bells', year: '1980', track: '1', disc: '', ext: 'flac' }
  assert.equal(renderTemplate('{albumartist}/{album}/{track:02} {title}.{ext}', vars), 'AC_DC/Back in Black/01 Hells Bells.flac')
})

test('路径：空的曲目号不留下孤立的分隔符', () => {
  const vars = { artist: 'a', albumartist: 'a', album: 'b', title: 'c', year: '', track: '', disc: '', ext: 'mp3' }
  assert.equal(renderTemplate('{albumartist}/{album}/{track:02} {title}.{ext}', vars), 'a/b/c.mp3')
  assert.equal(renderTemplate('{artist} - {title}.{ext}', vars), 'a - c.mp3')
})

test('路径：Windows 非法字符 / 保留名 / 末尾点', () => {
  assert.equal(sanitizeSegment('what?: "yes" <no>'), 'what__ _yes_ _no_')
  assert.equal(sanitizeSegment('CON'), '_CON')
  assert.equal(sanitizeSegment('end...'), 'end')
  assert.throws(() => resolveInside('/music', '../etc/passwd'))
})

test('双语 LRC：同时间戳的译文紧跟原文', () => {
  const merged = mergeLrc('[00:01.00]無敵の笑顔\n[00:03.28]知りたい', '[00:01.00]无敌的笑容\n[00:03.28]想知道')
  assert.equal(merged, '[00:01.00]無敵の笑顔\n[00:01.00]无敌的笑容\n[00:03.28]知りたい\n[00:03.28]想知道')
  assert.equal(mergeLrc('[00:01.00]a', null), '[00:01.00]a')
})

test('网易云发行时间按北京时间取日期', () => {
  // 1681228800000 = 2023-04-11T16:00:00Z = 北京时间 2023-04-12 00:00
  assert.equal(beijingDate(1681228800000), '2023-04-12')
  assert.equal(beijingDate(null), null)
})

test('时长核对：FLAC 头部算出的时长与网易云差太多就不是同一版本', () => {
  const head = readFileSync(new URL('./fixtures/tone.flac', import.meta.url))
  const probe = summarize(head, head.length, null)
  const track = { durationMs: 1000 } as Parameters<typeof durationGap>[1]
  assert.ok((durationGap(probe, track) ?? 99) < 0.1)
  // 实测 アイドル：酷我 FLAC 261 秒，网易云 213 秒
  assert.ok((durationGap(probe, { ...track, durationMs: 60_000 }) ?? 0) > MAX_DURATION_GAP_SECONDS)
  // MP3 算不出精确时长 → 不知道，不拦
  assert.equal(durationGap(summarize(readFileSync(new URL('./fixtures/tone.mp3', import.meta.url)), 17195, 1000), track), null)
})

test('身份核对：文件自带标题是另一首歌就拦下（实测 アイドル 拿到了 夜に駆ける）', () => {
  const idol = { title: 'アイドル', artists: ['YOASOBI'], aliases: ['TV动画《我推的孩子》片头曲'], translations: ['偶像'], durationMs: 1000 } as Parameters<typeof identityMismatch>[1]
  for (const name of ['wrong-title.flac', 'wrong-title.mp3']) {
    const head = readFileSync(new URL(`./fixtures/${name}`, import.meta.url))
    const probe = summarize(head, head.length, 1000)
    assert.equal(probe.embedded?.title, '夜に駆ける', name)
    assert.equal(identityMismatch(probe, idol), '夜に駆ける', name)
    // 要的就是 夜に駆ける 时不拦
    assert.equal(identityMismatch(probe, { ...idol, title: '夜に駆ける', aliases: [], translations: [] }), null, name)
  }
  // 自带标题带附注 / 用译名都不算错
  const base = summarize(readFileSync(new URL('./fixtures/tone.flac', import.meta.url)), 20669, 1000)
  assert.equal(identityMismatch({ ...base, embedded: { title: 'アイドル (TV Size)', artist: null } }, idol), null)
  assert.equal(identityMismatch({ ...base, embedded: { title: '偶像', artist: null } }, idol), null)
  assert.equal(identityMismatch({ ...base, embedded: null }, idol), null)
})

test('音质阶梯：从请求档位往下', () => {
  assert.deepEqual(ladder('flac'), ['flac', '320k', '128k'])
  assert.deepEqual(ladder('128k'), ['128k'])
})

/**
 * 专辑艺术家 / 合辑判定。
 *
 * 夹具全部来自 2026-10-23 对网易云 `/api/v1/album/<id>` 的实测返回：
 *   388647552「那些年的华语情歌」album.artists = [{id:122455, name:"群星", alias:["华语群星"]}]
 *     曲目 雪中莲→ar:["王菲"]、断点→ar:["张敬轩"]
 *   166043538「Idol」album.artists = [{name:"YOASOBI"}]
 * 也就是说：**群星的规范名在网易云里是「群星」，不是 "Various Artists"**，
 * 拿 "Various Artists" 去匹配永远匹配不上。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { albumArtistsFor, isCompilation, primaryArtist, COMPILATION_ARTIST } from '../src/music/album-artist.ts'
import { templateFor } from '../src/music/download.ts'
import { renderTemplate } from '../src/music/paths.ts'

/** 群星专辑的曲目：每首歌的 ar 只有它自己的歌手。 */
const COMPILATION_TRACK = { albumArtists: ['群星'], trackArtists: ['王菲'], albumId: '388647552' }
const SOLO_TRACK = { albumArtists: ['YOASOBI'], trackArtists: ['YOASOBI'], albumId: '166043538' }

test('合辑判定：群星（网易云的样子）', () => {
  assert.equal(isCompilation(COMPILATION_TRACK), true)
  // 只看专辑级；曲目级是王菲一个人，拿它判会得出"不是合辑"
  assert.equal(isCompilation({ albumArtists: null, trackArtists: ['王菲'] }), false)
})

test('合辑判定：其它平台的写法也认', () => {
  for (const name of ['Various Artists', 'various artists', 'VA', 'V.A.']) {
    assert.equal(isCompilation({ albumArtists: [name], trackArtists: ['某歌手'] }), true, name)
  }
})

test('合辑判定：群星 id 兜底（名字将来改了也还认得出）', () => {
  assert.equal(isCompilation({ albumArtists: ['改了名的群星'], albumId: '122455' }), true)
})

test('合辑判定：合作专辑不算合辑', () => {
  // 两个人各出一半的专辑，专辑级就是两个歌手。按"歌手有多个"判会把它扔进 合辑/
  const duet = { albumArtists: ['周杰伦', '费玉清'], trackArtists: ['周杰伦'] }
  assert.equal(isCompilation(duet), false)
  assert.deepEqual(albumArtistsFor(duet), ['周杰伦', '费玉清'])
})

test('专辑艺术家：合辑写规范名，不是「群星」', () => {
  assert.deepEqual(albumArtistsFor(COMPILATION_TRACK), [COMPILATION_ARTIST])
  assert.equal(COMPILATION_ARTIST, 'Various Artists')
})

test('专辑艺术家：普通专辑原样保留', () => {
  assert.deepEqual(albumArtistsFor(SOLO_TRACK), ['YOASOBI'])
})

test('专辑艺术家：专辑查不到时取第一位，不是拼接全部', () => {
  assert.deepEqual(albumArtistsFor({ albumArtists: null, trackArtists: ['米津玄師', 'DAOKO'] }), ['米津玄師'])
  // 网易云偶发返回一条空数组，跟查不到是一回事
  assert.deepEqual(albumArtistsFor({ albumArtists: [], trackArtists: ['宇多田ヒカル'] }), ['宇多田ヒカル'])
  assert.deepEqual(albumArtistsFor({ albumArtists: null, trackArtists: [] }), [])
})

test('{primary_artist}：只取第一位，不拼全部', () => {
  assert.equal(primaryArtist(['米津玄師', 'DAOKO']), '米津玄師')
  assert.equal(primaryArtist([]), '')
})

test('模板：合辑换目录前缀，文件名段照用用户的', () => {
  const opts = { compilationDir: '合辑', compilation: true }
  assert.equal(templateFor({ ...opts, template: '{albumartist}/{album}/{track:02} {title}.{ext}' }), '合辑/{album}/{track:02} {title}.{ext}')
  // 用户模板把歌手写在文件名里：整段保留，只换目录
  assert.equal(templateFor({ ...opts, template: '{albumartist}/{album}/{title}.{ext}' }), '合辑/{album}/{title}.{ext}')
  // 平铺模板（没有目录）：合辑也要归到一起
  assert.equal(templateFor({ ...opts, template: '{artist} - {title}.{ext}' }), '合辑/{album}/{artist} - {title}.{ext}')
})

test('模板：非合辑一个字都不改', () => {
  const opts = { compilationDir: '合辑', compilation: false, template: '{albumartist}/{album}/{track:02} {title}.{ext}' }
  assert.equal(templateFor(opts), opts.template)
})

test('落盘：群星专辑落到 合辑/，单曲照旧', () => {
  const vars = { artist: '王菲', primary_artist: '王菲', albumartist: 'Various Artists', album: '那些年的华语情歌', title: '雪中莲', year: '2005', track: '1', disc: '', ext: 'flac' }
  const template = templateFor({ template: '{albumartist}/{album}/{track:02} {title}.{ext}', compilationDir: '合辑', compilation: true })
  assert.equal(renderTemplate(template, vars), '合辑/那些年的华语情歌/01 雪中莲.flac')

  const solo = { ...vars, artist: 'YOASOBI', primary_artist: 'YOASOBI', albumartist: 'YOASOBI', album: 'Idol', title: 'Idol' }
  const soloTemplate = templateFor({ template: '{albumartist}/{album}/{track:02} {title}.{ext}', compilationDir: '合辑', compilation: false })
  assert.equal(renderTemplate(soloTemplate, solo), 'YOASOBI/Idol/01 Idol.flac')
})

test('落盘：{primary_artist} 在多歌手的歌上不出逗号串', () => {
  const vars = { artist: '米津玄師, DAOKO', primary_artist: '米津玄師', albumartist: '米津玄師', album: '打上花火', title: '打上花火', year: '2017', track: '', disc: '', ext: 'flac' }
  assert.equal(renderTemplate('{primary_artist}/{album}/{title}.{ext}', vars), '米津玄師/打上花火/打上花火.flac')
})

/**
 * 伴生文件（P2#3）与音频落盘位置（P0#2）。
 *
 * 伴生文件的命名是**扩展名追加**，不是替换：
 * 播放器靠"文件名完全一致、只有后缀不同"来认它们是同一条视频。
 * 写成 `a.Metadata.nfo`（替换掉 .mp4）播放器就找不到。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { buildNfo, sidecarKinds, sidecarPath } from '../src/bili/sidecar.ts'
import { targetPathFor } from '../src/bili/download.ts'
import type { VideoInfo } from '../src/bili/api.ts'

const INFO: VideoInfo = {
  bvid: 'BV1GEn26uEDT',
  aid: 123,
  title: '绿色',
  desc: '简介 <含尖括号> & 特殊字符',
  owner: { mid: 1, name: '东洋雪莲' },
  duration: 380,
  pic: 'https://i0.hdslb.com/bfs/archive/x.jpg',
  pubdate: 1711670400, // 2024-03-29
  pages: [
    { cid: 111, page: 1, part: '绿色', duration: 190 },
    { cid: 222, page: 2, part: '纯享版', duration: 190 },
  ],
}

test('伴生文件是扩展名追加，不是替换', () => {
  // 播放器认的是「同名 + 不同后缀」，替换扩展名就认不出来了
  assert.equal(sidecarPath('/v/01 绿色.mp4', 'nfo'), '/v/01 绿色.mp4.Metadata.nfo')
  assert.equal(sidecarPath('/v/01 绿色.mp4', 'cover'), '/v/01 绿色.mp4.jpg')
  assert.equal(sidecarPath('/v/01 绿色.mp4', 'danmaku'), '/v/01 绿色.mp4.Danmaku.ass')
})

test('配置解析：逗号 / 空格 / 中文逗号都认，all 是全集', () => {
  assert.deepEqual(sidecarKinds('nfo,cover'), ['nfo', 'cover'])
  assert.deepEqual(sidecarKinds('nfo cover'), ['nfo', 'cover'])
  assert.deepEqual(sidecarKinds('nfo，cover'), ['nfo', 'cover'])
  assert.deepEqual(sidecarKinds('all'), ['nfo', 'cover', 'danmaku'])
  // 空 = 全不生成（默认）
  assert.deepEqual(sidecarKinds(''), [])
  assert.deepEqual(sidecarKinds(null), [])
  // 不认识的词忽略，不让配置写错拖垮下载
  assert.deepEqual(sidecarKinds('nfo,bogus'), ['nfo'])
})

test('nfo 含播放器刮削要的字段', () => {
  const nfo = buildNfo(INFO, INFO.pages[0]!)
  assert.match(nfo, /<title>绿色<\/title>/)
  assert.match(nfo, /<premiered>2024-03-29<\/premiered>/)
  assert.match(nfo, /<year>2024<\/year>/)
  assert.match(nfo, /<director>东洋雪莲<\/director>/)
  // uniqueid 是关键：播放器靠它去刮削，也是我们日后追溯回原视频的锚点
  assert.match(nfo, /<uniqueid type="bvid" default="true">BV1GEn26uEDT<\/uniqueid>/)
  assert.match(nfo, /<uniqueid type="cid">111<\/uniqueid>/)
})

test('nfo 转义 XML 特殊字符，不让简介里的 < > 破坏结构', () => {
  const nfo = buildNfo(INFO, INFO.pages[0]!)
  assert.match(nfo, /&lt;含尖括号&gt; &amp; 特殊字符/)
  // 没有裸的尖括号漏进去
  assert.doesNotMatch(nfo, /<plot>[^<]*<含尖括号/)
})

test('多分 P 时标题用分 P 名，原视频标题留在 originaltitle', () => {
  const nfo = buildNfo(INFO, INFO.pages[1]!)
  assert.match(nfo, /<title>绿色 - 纯享版<\/title>/, '播放器里"这一集"的名字是分 P 名')
  assert.match(nfo, /<originaltitle>绿色<\/originaltitle>/)
})

test('音频默认落音乐库，--to bili 才回视频目录', () => {
  const base: { audioOnly?: boolean; audioTo?: 'music' | 'bili' } = {}
  const music = targetPathFor(INFO, INFO.pages[0]!, { ...base, audioOnly: true }, 80)
  const video = targetPathFor(INFO, INFO.pages[0]!, { ...base }, 80)
  const toBili = targetPathFor(INFO, INFO.pages[0]!, { ...base, audioOnly: true, audioTo: 'bili' }, 80)

  // 音频用音乐模板的变量（{artist}/{album}/...），视频用 bili.template
  assert.ok('artist' in music.vars, '音频应当用音乐模板的变量集')
  assert.ok('uploader' in video.vars, '视频仍用视频模板的变量集')
  assert.ok('uploader' in toBili.vars, '--to bili 时回视频模板')

  // 音频把 UP 主当艺术家、视频标题当专辑 —— 与写进标签的 TPE1/TALB 一致
  assert.equal(music.vars.artist, '东洋雪莲')
  assert.equal(music.vars.album, '绿色')
  // 单 P 用视频标题当曲名，多 P 用分 P 名
  assert.equal(music.vars.title, '绿色')
  const musicP2 = targetPathFor(INFO, INFO.pages[1]!, { ...base, audioOnly: true }, 80)
  assert.equal(musicP2.vars.title, '纯享版')
})

test('音频落盘的根目录是音乐库，视频是视频库', () => {
  const prevMusic = process.env.ASTRA_MUSIC_DIR
  const prevVideo = process.env.ASTRA_VIDEO_DIR
  // 这两个是纯函数里读的 env，统一给个可识别的值。
  // 断言用 path.resolve 后的形状做比较 —— 这些函数内部就 resolve 过，
  // 在 Windows 上 `/m/music` 会变成 `C:\m\music`，直接比字面量会假失败。
  const music = path.resolve('/m/music')
  const video = path.resolve('/m/video')
  process.env.ASTRA_MUSIC_DIR = music
  process.env.ASTRA_VIDEO_DIR = video
  try {
    const base: { audioOnly?: boolean; audioTo?: 'music' | 'bili' } = {}
    assert.equal(targetPathFor(INFO, INFO.pages[0]!, { ...base, audioOnly: true }, 80).root, music)
    assert.equal(targetPathFor(INFO, INFO.pages[0]!, { ...base, audioOnly: true, audioTo: 'bili' }, 80).root, video)
    assert.equal(targetPathFor(INFO, INFO.pages[0]!, { ...base }, 80).root, video)
  } finally {
    if (prevMusic === undefined) delete process.env.ASTRA_MUSIC_DIR
    else process.env.ASTRA_MUSIC_DIR = prevMusic
    if (prevVideo === undefined) delete process.env.ASTRA_VIDEO_DIR
    else process.env.ASTRA_VIDEO_DIR = prevVideo
  }
})

// ---- P0#2c：TIT2 取歌名，不是分 P 名 ----

test('歌名从《》里取最后一个，不是分 P 名', async () => {
  const { songTitleOf } = await import('../src/bili/download.ts')
  // 线上原样：分 P 名「绿色」，歌名在标题的第二个《》里
  const real = { title: '⚡《鳄鱼摇の小曲》🐊《绿色DJ》完整版“若不是你突然闯进我生活~”⚡/AI東 雪蓮' }
  assert.equal(songTitleOf(real, { part: '绿色' }), '绿色DJ', '要取最后一个《》——前面常是副标题')
})

test('没有《》时退回分 P 名', async () => {
  const { songTitleOf } = await import('../src/bili/download.ts')
  assert.equal(songTitleOf({ title: '某个视频标题' }, { part: '第一集' }), '第一集')
})

test('分 P 名也空时用视频标题', async () => {
  const { songTitleOf } = await import('../src/bili/download.ts')
  assert.equal(songTitleOf({ title: '标题' }, { part: '' }), '标题')
})

test('只有一个《》时正常取到', async () => {
  const { songTitleOf } = await import('../src/bili/download.ts')
  assert.equal(songTitleOf({ title: '《年轮》官方MV' }, { part: '年轮' }), '年轮')
})

// ---- P0#2b：B 站音频专用模板 ----

test('配了 bili.audio-template 时用它，不再一个视频一个目录', async () => {
  const { getConfig, setConfig } = await import('../src/core/config.ts')
  const { targetPathFor } = await import('../src/bili/download.ts')
  const { renderTemplate } = await import('../src/core/template.ts')
  const prev = getConfig('bili.audio-template')
  try {
    setConfig('bili.audio-template', 'Bilibili/{uploader}/{title}.{ext}')
    const { root, template, vars } = targetPathFor(INFO, INFO.pages[0]!, { audioOnly: true }, 80)
    const rel = renderTemplate(template, vars)
    // 平铺：Bilibili/<UP>/<歌名>.mp3，中间不再有视频标题那层
    assert.match(rel, /^Bilibili\/东洋雪莲\//, `实际：${rel}`)
    assert.doesNotMatch(rel, /《鳄鱼摇の小曲》/, '不该再有视频标题当目录')
    assert.equal(root.length > 0, true)
  } finally {
    setConfig('bili.audio-template', prev)
  }
})

/**
 * 抖音域：签名、cookie 解析、拍平与选档、落盘命名 —— 全部纯函数，不打真站。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signQuery, parseCookies, uifidFromCookie, randomUifid, cookieHeader } from '../src/douyin/sign.ts'
import { parseCookieInput } from '../src/douyin/auth.ts'
import { normalizeAweme, pickGear, summarizeGears, originalImageUrl, type Gear } from '../src/douyin/model.ts'
import { sanitizeTitle, baseName, videoPath, imagePath, findExisting } from '../src/douyin/paths.ts'
import { commandGroup, groupCommands } from '../src/main.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('douyin 是命令组，且命令齐全', () => {
  assert.equal(commandGroup('douyin'), true)
  const names = groupCommands('douyin')
  for (const expected of ['douyin get', 'douyin info', 'douyin hot', 'douyin fav', 'douyin login', 'douyin whoami', 'douyin logout', 'douyin doctor']) {
    assert.ok(names.includes(expected), `缺 ${expected}`)
  }
})

test('signQuery：固定 uifid/时间戳可复现（向量来自实测）', () => {
  const uifid = 'a'.repeat(76)
  const { query, signature } = signQuery([['device_platform', 'webapp'], ['aweme_id', '7686766114847673634']], uifid, 1793516711)
  assert.equal(
    query,
    'device_platform=webapp&aweme_id=7686766114847673634&uifid=' + uifid + '&timestamp=1793516711',
  )
  assert.equal(signature, '08f1c94fe5b4c3077631796fadc9238c')
})

test('signQuery：已经带 uifid 时不重复追加（重复会签出另一个前像）', () => {
  const { query } = signQuery([['aweme_id', '1'], ['uifid', 'x'.repeat(76)]], 'y'.repeat(76), 1700000000)
  assert.equal(query.split('uifid=').length - 1, 1)
  assert.ok(query.includes(`uifid=${'x'.repeat(76)}`))
})

test('randomUifid：76 位小写 hex', () => {
  const id = randomUifid()
  assert.match(id, /^[0-9a-f]{76}$/)
  assert.notEqual(id, randomUifid())
})

test('parseCookies / cookieHeader / uifidFromCookie', () => {
  const jar = parseCookies('a=1; b=2;;  c = 3 ')
  assert.deepEqual(jar, { a: '1', b: '2', c: '3' })
  assert.equal(cookieHeader({ a: '1', b: '2' }), 'a=1; b=2')
  assert.equal(uifidFromCookie('ttwid=x; UIFID_TEMP=' + 'f'.repeat(76)), 'f'.repeat(76))
  assert.equal(uifidFromCookie('ttwid=x'), null)
})

test('parseCookieInput：Copy as cURL / -b / 裸串 / Cookie 前缀', () => {
  const curl = `curl 'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=1' \\
  -H 'cookie: ttwid=abc; sessionid=deadbeef; odin_tt=zz' \\
  -H 'user-agent: Mozilla/5.0'`
  assert.equal(parseCookieInput(curl), 'ttwid=abc; sessionid=deadbeef; odin_tt=zz')

  assert.equal(parseCookieInput(`curl x -b 'sessionid=1; ttwid=2'`), 'sessionid=1; ttwid=2')
  assert.equal(parseCookieInput('Cookie: sessionid=1; ttwid=2'), 'sessionid=1; ttwid=2')
  assert.equal(parseCookieInput('sessionid=1; ttwid=2'), 'sessionid=1; ttwid=2')
  assert.throws(() => parseCookieInput('hello world'), /没从输入里找到 cookie/)
  // 只有 ttwid 没有登录凭据：要明确报“不完整”，别存一个假登录态
  assert.throws(() => parseCookieInput('ttwid=abc'), /没有登录凭据/)
})

const RAW = {
  aweme_id: '7691654649154572543',
  desc: '旦巴坚参演唱的经典民歌 #热门 #音乐',
  create_time: 1767225600,
  aweme_type: 0,
  author: { nickname: '旦巴坚参', sec_uid: 'MS4wLjABAAAAx' },
  video: {
    duration: 260642,
    width: 1920,
    height: 1080,
    origin_cover: { url_list: ['https://p3.example/cover.jpg'] },
    play_addr: { uri: 'v2800', url_list: ['https://v26.example/default.mp4'], data_size: 66699267 },
    bit_rate: [
      { gear_name: 'normal_1080_0', bit_rate: 2047222, is_h265: 0, FPS: 25, play_addr: { url_list: ['https://v26.example/1080.mp4'], data_size: 66699267, width: 1920, height: 1080 } },
      { gear_name: '1080_1_1', bit_rate: 1594435, is_h265: 1, FPS: 25, play_addr: { url_list: ['https://v26.example/1080h265.mp4'], data_size: 51947514, width: 1920, height: 1080 } },
      { gear_name: 'normal_540_0', bit_rate: 1450929, is_h265: 0, FPS: 25, play_addr: { url_list: ['https://v26.example/540.mp4'], data_size: 47271825, width: 1024, height: 576 } },
    ],
  },
  music: { title: '原声', play_url: { url_list: ['https://lf.example/music.mp3'] } },
  statistics: { digg_count: 1234 },
}

test('normalizeAweme：视频拍平（档位、时长、作者）', () => {
  const item = normalizeAweme(RAW)
  assert.equal(item.id, '7691654649154572543')
  assert.equal(item.kind, 'video')
  assert.equal(item.durationSec, 261)
  assert.equal(item.gears.length, 3)
  assert.equal(item.author, '旦巴坚参')
  assert.equal(item.cover, 'https://p3.example/cover.jpg')
  assert.equal(item.music?.title, '原声')
  assert.equal(item.stats.digg_count, 1234)
})

test('normalizeAweme：图文（images 存在即图文，视频流是背景音乐）', () => {
  const item = normalizeAweme({
    aweme_id: '7688662293581013915',
    desc: '相册4.0',
    aweme_type: 68,
    video: { duration: 0, width: 2160, height: 2174, play_addr: { url_list: ['https://lf.example/bgm.mp3'] } },
    images: [
      { width: 2160, height: 2174, url_list: ['https://p3.example/a.webp', 'https://p9.example/a.webp', 'https://p3.example/a.jpeg'], download_url_list: ['https://p3.example/a-water.jpeg'] },
      { width: 2160, height: 2174, url_list: ['https://p3.example/b.jpeg'] },
    ],
  })
  assert.equal(item.kind, 'image')
  assert.equal(item.images.length, 2)
  assert.equal(item.images[0]!.url, 'https://p3.example/a.jpeg')
  assert.equal(item.durationSec, null)
})

test('originalImageUrl：取最后一个（前两个是 webp 缩略）', () => {
  assert.equal(originalImageUrl(['w1.webp', 'w2.webp', 'orig.jpeg']), 'orig.jpeg')
  assert.equal(originalImageUrl([]), null)
})

const G = (over: Partial<Gear>): Gear => ({ name: 'g', bitrate: 1000, bytes: 100, url: 'https://x/y.mp4', width: 1920, height: 1080, short: 1080, h265: false, audio: true, format: 'mp4', fps: 25, ...over })

test('pickGear：同分辨率优先 h264，且必须带音轨', () => {
  const gears = [
    G({ name: 'h265-1080', short: 1080, height: 1080, bitrate: 5000, h265: true }),
    G({ name: 'h264-1080', short: 1080, height: 1080, bitrate: 2000 }),
    G({ name: 'h264-720', short: 720, height: 720, bitrate: 1500 }),
    G({ name: 'dash-1080', short: 1080, height: 1080, bitrate: 9000, h265: true, audio: false, format: 'dash' }),
  ]
  assert.equal(pickGear(gears, 'best')?.name, 'h264-1080')
  assert.equal(pickGear(gears, '720p')?.name, 'h264-720')
  assert.equal(pickGear(gears, 'small')?.name, 'h264-720')
})

test('pickGear：竖屏按短边判画质（576x1024 属于 540p，不是 1024p）', () => {
  const vertical = G({ name: 'normal_540_0', width: 576, height: 1024, short: 576, bitrate: 997251 })
  const uhd = G({ name: 'adapt_lowest_4_1', width: 2160, height: 3840, short: 2160, bitrate: 2204461, h265: true })
  assert.equal(pickGear([uhd, vertical], '540p')?.name, 'normal_540_0')
  assert.equal(pickGear([uhd, vertical], 'best')?.name, 'adapt_lowest_4_1')
})

test('pickGear：只有 dash（纯视频轨）时仍返回，但 audio=false', () => {
  const gears = [G({ name: 'dash-only', format: 'dash', audio: false, h265: true, short: 720, height: 720 })]
  assert.equal(pickGear(gears, 'best')?.audio, false)
})

test('pickGear：空档位返回 null', () => {
  assert.equal(pickGear([], 'best'), null)
})

test('summarizeGears：标出 codec 与有没有音轨', () => {
  const rows = summarizeGears([
    G({ name: 'normal_1080_0', short: 1080, height: 1080, bitrate: 2047222, bytes: 66699267 }),
    G({ name: '1080_1_1', short: 1080, height: 1080, bitrate: 1594435, bytes: 51947514, h265: true, audio: false, format: 'dash' }),
  ])
  assert.equal(rows[0]!.codec, 'h264')
  assert.equal(rows[0]!.audio, true)
  assert.equal(rows[1]!.codec, 'h265')
  assert.equal(rows[1]!.audio, false)
})

test('sanitizeTitle：去话题、去表情、去非法字符、截断 24 字', () => {
  assert.equal(sanitizeTitle('#王冬爱情向梦女 #冬桐分裂 虽然是单人向'), '虽然是单人向')
  assert.equal(sanitizeTitle('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j')
  assert.equal(sanitizeTitle('   '), '无标题')
  assert.equal(sanitizeTitle('标题😀🎊🫶'), '标题')
  const long = sanitizeTitle('#x ' + '一'.repeat(80))
  assert.equal([...long].length, 24)
  assert.equal(sanitizeTitle('标题。.'), '标题')
})

test('落盘命名：id 打头 + 标题，图文进子目录', () => {
  const item = normalizeAweme(RAW)
  assert.equal(baseName(item), '7691654649154572543 旦巴坚参演唱的经典民歌')
  assert.equal(videoPath('/视频', item), '/视频/7691654649154572543 旦巴坚参演唱的经典民歌.mp4')
  assert.equal(imagePath('/视频/x', 0, 'https://p3.example/a.jpeg'), '/视频/x/01.jpg')
  assert.equal(imagePath('/视频/x', 11, 'https://p3.example/b.webp'), '/视频/x/12.webp')
})

test('findExisting：按 id 前缀认出已下载的别的标题', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dy-'))
  writeFileSync(path.join(dir, '7691654649154572543 旧标题.mp4'), 'x')
  writeFileSync(path.join(dir, '7691654649154572543 新标题.mp4.part'), 'x')
  assert.equal(findExisting(dir, '7691654649154572543'), path.join(dir, '7691654649154572543 旧标题.mp4'))
  assert.equal(findExisting(dir, '123'), null)
  assert.equal(findExisting('/nonexistent/dir', '1'), null)
})

test('parseCookieInput：跨域请求（不带 cookie 的那种 cURL）要指出该换哪条', () => {
  const curl = `curl --url 'https://mon.zijieapi.com/monitor_web/settings/browser-settings?bid=uc_secure_sdk&store=1' \\
  -H 'referer: https://www.douyin.com/'`
  assert.throws(() => parseCookieInput(curl), /本来就不带 cookie/)
})

test('normalizeAweme：标题里的换行压成空格', () => {
  const item = normalizeAweme({ aweme_id: '1', desc: '第一行\n第二行\r\n第三行', video: { bit_rate: [] } })
  assert.equal(item.title, '第一行 第二行 第三行')
})

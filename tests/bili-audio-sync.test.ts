/**
 * `bili audio`：把 UP / 合集整体转成音乐库。
 *
 * 之前用户是自己在外部循环调 `astra bili get` 干的，中间还得：
 * ① 临时改 ASTRA_MUSIC_DIR 把文件导到别处 ② 事后数文件发现丢了 39 首
 * ③ 写补下脚本 ④ 再写脚本重刷标签。换一个 UP 就重来一遍。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterByExclude } from '../src/bili/audio-sync.ts'
import { biliAudioRoot, getConfig, setConfig } from '../src/core/config.ts'
import { targetPathFor } from '../src/bili/download.ts'
import { renderTemplate } from '../src/core/template.ts'
import type { VideoInfo } from '../src/bili/api.ts'

const items = [
  { bvid: 'BV1', title: '《暗香》钢琴版' },
  { bvid: 'BV2', title: '巡演 vlog 第一期' },
  { bvid: 'BV3', title: '开票通知' },
  { bvid: 'BV4', title: '《水星记》' },
]

test('--exclude 按标题正则过滤，报告排除数', () => {
  const { kept, excluded } = filterByExclude(items, '巡演|开票')
  assert.deepEqual(kept.map((i) => i.bvid), ['BV1', 'BV4'])
  assert.deepEqual(excluded.map((i) => i.bvid), ['BV2', 'BV3'])
})

test('不给 --exclude 时一个都不排除', () => {
  const { kept, excluded } = filterByExclude(items, null)
  assert.equal(kept.length, 4)
  assert.equal(excluded.length, 0)
  assert.equal(filterByExclude(items, '').excluded.length, 0)
})

test('非法正则抛错，而不是静默排除全部', () => {
  // "排除 322 / 待下 0" 看着像正常，实际是正则坏了 —— 那种静默最要命
  assert.throws(() => filterByExclude(items, '[unclosed'), /不是合法正则/)
})

test('2d：bili.audio-dir 独立于音乐库，留空退回音乐库', () => {
  const prevDir = getConfig('bili.audio-dir')
  const prevMusic = process.env.ASTRA_MUSIC_DIR
  try {
    process.env.ASTRA_MUSIC_DIR = '/m/music'
    setConfig('bili.audio-dir', '')
    assert.equal(biliAudioRoot(), biliAudioRoot(), '留空时应当稳定返回音乐库')

    setConfig('bili.audio-dir', '/m/bili-audio')
    assert.match(biliAudioRoot(), /bili-audio$/, '配了就该用独立根')
    assert.notEqual(biliAudioRoot(), '/m/music', '不该再落音乐库')
  } finally {
    setConfig('bili.audio-dir', prevDir)
    if (prevMusic === undefined) delete process.env.ASTRA_MUSIC_DIR
    else process.env.ASTRA_MUSIC_DIR = prevMusic
  }
})

const INFO: VideoInfo = {
  bvid: 'BV1WUJ56vEQo', aid: 1, title: '炫技高燃完整版《暗香》', desc: '', owner: { mid: 1, name: 'oskarpianist' },
  duration: 200, pic: null, pubdate: 1718000000,
  pages: [{ cid: 1, page: 1, part: '01', duration: 200 }],
}

test('2d 回归：--to bili 也用 audio-template，不套视频模板', () => {
  // 实测过的问题：`--to bili` 套了 `{title}/{page:02} {part}`，
  // 音频被塞进 `<视频标题>/01.mp3` 子目录里 —— 音频归档就该是单文件
  const prev = getConfig('bili.audio-template')
  try {
    setConfig('bili.audio-template', '{uploader}/{title}.{ext}')
    const toBili = targetPathFor(INFO, INFO.pages[0]!, { audioOnly: true, audioTo: 'bili' }, 80)
    const rel = renderTemplate(toBili.template, toBili.vars)
    // `<UP>/<歌名>.mp3` —— 只有 UP 那一层，不该再有视频标题当子目录
    assert.equal(rel, 'oskarpianist/暗香.mp3', `实际：${rel}`)
    assert.equal(rel.split('/').length, 2, '只该有 UP 一层目录')
  } finally {
    setConfig('bili.audio-template', prev)
  }
})

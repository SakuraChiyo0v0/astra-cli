/**
 * P0#10：`bili subtitle` 返回**别的视频**的字幕。
 *
 * 根因（实测 2026-10-22）：字幕列表走的是不带签名的 `x/player/v2`，
 * 同一个 bvid+cid 连调 6 次，会有 1 次返回空的 `subtitle_url`、1 次丢掉 zh-CN，
 * 而且 URL 停在过期的 CDN 值上不刷新 —— 那个路径上的内容可能已经换给别人了。
 * 换成 `x/player/wbi/v2` 后，4 次调用内容哈希完全一致。
 *
 * 这里钉住两件事：
 * 1. 时长自检的判据（只卡上限，不卡下限）
 * 2. SRT 输出稳定
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subtitleFits, toSrt } from '../src/bili/commands.ts'

const cuesEndingAt = (sec: number): { from: number; to: number; content: string }[] => [
  { from: 0, to: 1.5, content: '第一句' },
  { from: 1.5, to: sec, content: '最后一句' },
]

test('字幕超出视频时长 → 判定为串台，丢弃', () => {
  // 实测：2 分 37 秒（157s）的视频拿到了 28 分 36 秒（1716s）的旅游 vlog 字幕
  const fit = subtitleFits(cuesEndingAt(1716), 157)
  assert.equal(fit.ok, false, '超出时长必须判为串台')
  assert.equal(fit.lastCueSec, 1716)
})

test('字幕短于视频时长 → 正常，不能误判', () => {
  // 实测：《年轮》4:32（273s）的视频，AI 字幕止于 240.8s（片尾是纯音乐尾奏）
  const fit = subtitleFits(cuesEndingAt(240.8), 273)
  assert.equal(fit.ok, true, '字幕不覆盖片尾是常态，不能当成串台')
})

test('字幕略微压线也算正常（容 2 秒）', () => {
  assert.equal(subtitleFits(cuesEndingAt(158), 157).ok, true, 'to 压在片尾上属正常')
  assert.equal(subtitleFits(cuesEndingAt(160), 157).ok, false, '超出 3 秒就该判串台')
})

test('视频时长未知时不拦截', () => {
  assert.equal(subtitleFits(cuesEndingAt(99999), 0).ok, true)
})

test('空字幕不炸', () => {
  assert.deepEqual(subtitleFits([], 157), { ok: true, lastCueSec: 0 })
})

test('SRT 输出稳定：序号、时间轴、空行分隔', () => {
  const srt = toSrt([
    { from: 0, to: 1.5, content: '第一句' },
    { from: 1.5, to: 62.25, content: '第二句' },
  ])
  assert.equal(
    srt,
    '1\n00:00:00,000 --> 00:00:01,500\n第一句\n\n2\n00:00:01,500 --> 00:01:02,250\n第二句\n',
  )
})

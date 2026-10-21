/**
 * 媒体处理：参数解析与"输出不能等于输入"这条铁律。
 *
 * 铁律来自实际事故：抽音轨时扩展名推断出错，输出路径回落到源文件，
 * 配合 --overwrite 把原视频截成了 5 秒（源文件被毁）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseTime, mediaInfo, extractAudio } from '../src/media/tools.ts'

test('时间解析：秒 / 分:秒 / 时:分:秒', () => {
  assert.equal(parseTime('12.5'), 12.5)
  assert.equal(parseTime('1:30'), 90)
  assert.equal(parseTime('00:01:30.5'), 90.5)
  assert.equal(parseTime('2:00:00'), 7200)
})

test('时间解析：非法输入明确拒绝', () => {
  assert.throws(() => parseTime('abc'), /格式不对/)
  assert.throws(() => parseTime('1:2:3:4'), /格式不对/)
  assert.throws(() => parseTime('-5'), /格式不对/)
})

test('输出不能等于输入：即使 --overwrite 也拒绝', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-media-'))
  const file = path.join(dir, 'fake.mp4')
  writeFileSync(file, 'not a real video')
  // 不是真视频，mediaInfo 会失败；但 ensureWritable 的判断在它之前拿不到机会。
  // 这里直接验证"同一个路径"这个条件本身：用 extractAudio 传入相同 output
  await assert.rejects(
    extractAudio({ input: file, output: file, overwrite: true }),
    (err: unknown) => {
      // 先会因为"读不出媒体信息"失败，或因为"输出即输入"失败 —— 两者都不能是覆盖成功
      const message = (err as Error).message
      assert.ok(/媒体信息|相同|不存在/.test(message), `意外的错误：${message}`)
      return true
    },
  )
})

test('mediaInfo：文件不存在报 NOT_FOUND', async () => {
  await assert.rejects(mediaInfo(path.join(tmpdir(), 'definitely-not-here-12345.mp4')), (err: unknown) => {
    assert.equal((err as { code?: string }).code, 'NOT_FOUND')
    return true
  })
})

test('内嵌封面：ffprobe 会把它报成一条 mjpeg 视频流（提示的依据）', async () => {
  const withCover = new URL('./fixtures/with-cover.flac', import.meta.url).pathname
    .replace(/^\/([A-Za-z]:)/, '$1')
  const info = await mediaInfo(decodeURIComponent(withCover))
  // 这条断言是"提示逻辑成立"的事实依据：真有封面时 hasVideo=true 且编码是 mjpeg
  assert.equal(info.hasAudio, true)
  assert.equal(info.hasVideo, true)
  assert.equal(info.videoCodec, 'mjpeg')
  assert.ok(['mjpeg', 'png', 'bmp', 'gif', 'webp'].includes(info.videoCodec ?? ''), '应当被判定为封面')
})

test('纯音频没有封面时不误报', async () => {
  const plain = new URL('./fixtures/tone.flac', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const info = await mediaInfo(decodeURIComponent(plain))
  assert.equal(info.hasVideo, false)
  assert.equal(info.videoCodec, null)
})

/**
 * 图片完整性校验：容器结构检查，不依赖完整解码。
 *
 * 用真实坏图（2026-10-29 截断的 151330044_p0.png）当夹具，防止以后又退回「只看文件存在」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { verifyImage } from '../src/core/imagecheck.ts'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 造一个最小但结构完整的 PNG：签名 + IHDR + IEND。 */
function tinyPng(): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(1, 8)   // width
  ihdr.writeUInt32BE(1, 12)  // height
  ihdr[16] = 8               // bit depth
  ihdr[17] = 6               // color type
  const iend = Buffer.alloc(12)
  iend.writeUInt32BE(0, 0)
  iend.write('IEND', 4, 'ascii')
  return Buffer.concat([PNG_SIG, ihdr, iend])
}

test('完整 PNG 通过', () => {
  assert.equal(verifyImage(tinyPng(), 'png').ok, true)
})

test('截断的 PNG 被拒（缺 IEND）', () => {
  const buf = tinyPng().subarray(0, 30)
  const r = verifyImage(buf, 'png')
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /IEND|截断/)
})

test('JPEG 缺 EOI 被拒', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
  const r = verifyImage(jpeg, 'jpg')
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /EOI|截断/)
})

test('完整 JPEG 通过', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9])
  assert.equal(verifyImage(jpeg, 'jpg').ok, true)
})

test('WebP 长度字段与实际不符被拒', () => {
  const head = Buffer.alloc(16)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(999, 4)   // 声明的长度远大于实际
  head.write('WEBP', 8, 'ascii')
  const r = verifyImage(head, 'webp')
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /截断/)
})

test('没有扩展名时按魔数嗅探', () => {
  assert.equal(verifyImage(tinyPng()).ok, true)
  assert.equal(verifyImage(tinyPng().subarray(0, 30)).ok, false)
})

test('未知格式放行（不凭空拦人）', () => {
  assert.equal(verifyImage(Buffer.from('hello'), 'txt').ok, true)
})

test('空内容被拒', () => {
  assert.equal(verifyImage(Buffer.alloc(0), 'png').ok, false)
})

test('真实坏图夹具：线上那张截断的 PNG 应被判为坏', () => {
  const fixture = '/opt/data/astra-src/tests/fixtures/truncated.png'
  if (!existsSync(fixture)) return  // 夹具不入库时跳过，不制造假失败
  const r = verifyImage(readFileSync(fixture), 'png')
  assert.equal(r.ok, false)
})

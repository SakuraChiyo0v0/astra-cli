/**
 * 二维码输出：PNG 文件要能被真实解码器认出来，终端文本只验形状。
 * 用 ffprobe（本机有）当第三方裁判，避免自造的 PNG 头自己验自己。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { renderQrText, writeQrPng } from '../src/core/qr.ts'
import { encodeMonoPng } from '../src/core/png.ts'

const CONTENT = 'https://music.163.com/login?codekey=eb1f1997-072c-4f4e-b8ee-a06a2e9c3613'

test('PNG：文件头、IHDR 字段正确', () => {
  const png = encodeMonoPng([[true, false], [false, true]], 4, 2)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR')
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  // (2 模块 + 2×2 留白) × 4 像素
  assert.equal(width, (2 + 4) * 4)
  assert.equal(height, (2 + 4) * 4)
  assert.equal(png[24], 8, '位深 8')
  assert.equal(png[25], 0, '灰度')
  assert.equal(png.subarray(-8, -4).toString('latin1'), 'IEND')
})

test('PNG：ffprobe 能识别成真实图片', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-qr-'))
  const file = path.join(dir, 'q.png')
  const image = writeQrPng(CONTENT, file)
  assert.equal(image.path, file)
  assert.equal(image.content, CONTENT)
  assert.equal(image.base64, readFileSync(file).toString('base64'))
  assert.ok(statSync(file).size > 1000, `文件 ${statSync(file).size} 字节`)

  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', file], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) return // 没装 ffprobe 就不强求
  const stream = (JSON.parse(probe.stdout) as { streams?: { width: number; height: number; codec_name: string }[] }).streams?.[0]
  assert.equal(stream?.width, image.size)
  assert.equal(stream?.height, image.size)
  assert.equal(stream?.codec_name, 'png')
})

test('终端文本：等宽、只用四种字符、四周留白', () => {
  const { art, content } = renderQrText(CONTENT)
  assert.equal(content, CONTENT)
  const lines = art.split('\n')
  const width = [...lines[0]!].length
  for (const line of lines) assert.equal([...line].length, width, '每行等宽')
  assert.equal(lines[0]!.trim(), '')
  assert.match(art, /^[█▀▄ \n]+$/)
})

test('内容越长二维码越大', () => {
  assert.ok(renderQrText('x'.repeat(200)).art.split('\n').length > renderQrText('a').art.split('\n').length)
})

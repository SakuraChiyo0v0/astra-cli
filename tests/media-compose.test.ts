/**
 * 拼接与水印的参数生成。
 *
 * 两个坑都是实际踩过的：
 * 1. 水印位置写成 `W-w-20`，w/h 在滤镜里是**画面**宽高（= W/H），算出来是 -20，水印飞出画面
 * 2. 拼接重编码时定义了 scale 却没接进 filter 链，concat 报参数不匹配
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { positionExpr, pickFont } from '../src/media/compose.ts'

test('水印位置：用 text_w/text_h 而不是 w/h', () => {
  assert.equal(positionExpr('top-left'), '20:20')
  assert.equal(positionExpr('top-right'), 'W-text_w-20:20')
  assert.equal(positionExpr('bottom-left'), '20:H-text_h-20')
  assert.equal(positionExpr('bottom-right'), 'W-text_w-20:H-text_h-20')
  // 关键断言：绝不能出现裸的 W-w（那等于 -margin，水印会被推出画面）
  for (const pos of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
    assert.doesNotMatch(positionExpr(pos), /W-w-|H-h-/, `${pos} 用了会算成负数的 w/h`)
  }
})

test('水印位置：边距可调', () => {
  assert.equal(positionExpr('bottom-right', 50), 'W-text_w-50:H-text_h-50')
})

test('字体：显式路径不存在时不静默返回', () => {
  // 给一个肯定不存在的路径，应当返回 null 让调用方报错，而不是回落到别的字体
  assert.equal(pickFont('/definitely/not/a/font.ttf'), null)
})

test('字体：不给路径时返回一个存在的字体或 null', () => {
  const font = pickFont()
  // 找不到字体的环境（精简容器）允许为 null，调用方会报 NO_FONT
  assert.ok(font === null || font.length > 0)
})

test('封面提取：FLAC PICTURE 块的偏移要对（漏跳 desc 与宽高会永远返回 null）', async () => {
  const { readFileSync } = await import('node:fs')
  const { extractCoverArt, hasCoverArt } = await import('../src/music/tags.ts')
  const withCover = readFileSync(new URL('./fixtures/with-cover.flac', import.meta.url))
  assert.equal(hasCoverArt(withCover), true, '夹具应当有封面')
  const cover = extractCoverArt(withCover)
  assert.notEqual(cover, null, '有 PICTURE 块就必须能取出来')
  assert.match(cover!.mime, /image\//)
  // 图片 magic 要对：JPEG 是 ffd8，PNG 是 89504e47
  const magic = cover!.data.subarray(0, 4).toString('hex')
  assert.ok(magic.startsWith('ffd8') || magic.startsWith('89504e47'), `不像图片：${magic}`)
  assert.ok(cover!.data.length > 100, `封面太小：${cover!.data.length}`)
})

test('封面提取：没有封面的文件返回 null', async () => {
  const { readFileSync } = await import('node:fs')
  const { extractCoverArt, hasCoverArt } = await import('../src/music/tags.ts')
  const plain = readFileSync(new URL('./fixtures/tone.flac', import.meta.url))
  assert.equal(hasCoverArt(plain), false)
  assert.equal(extractCoverArt(plain), null)
})

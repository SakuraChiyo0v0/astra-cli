/**
 * 路径模板与画质解析。模板用音乐那边现有的实现（已泛化到 core/template.ts）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { renderTemplate, resolveInside } from '../src/core/template.ts'
import { qualityName, mixinKey, signParams } from '../src/bili/sign.ts'

const VARS = { uploader: '冰封.虾子', title: '【MV】保加利亚妖王AZIS视频合辑', part: 'Хоп', page: '1', bvid: 'BV17x411w7KC', quality: '360P', ext: 'mp4' }

test('模板：分 P 号补零，扩展名正确', () => {
  assert.equal(
    renderTemplate('{uploader}/{title}/{page:02} {part}.{ext}', VARS),
    '冰封.虾子/【MV】保加利亚妖王AZIS视频合辑/01 Хоп.mp4',
  )
})

test('模板：单 P 没有 part 时不留下孤立的分隔', () => {
  const single = { ...VARS, part: '' }
  assert.equal(renderTemplate('{uploader}/{title}/{page:02} {part}.{ext}', single), '冰封.虾子/【MV】保加利亚妖王AZIS视频合辑/01.mp4')
})

test('模板：标题里的冒号等非法字符被净化，不凭空多一层目录', () => {
  const v = { ...VARS, title: 'a/b: c? d' }
  const out = renderTemplate('{uploader}/{title}.{ext}', v)
  assert.equal(out, '冰封.虾子/a_b_ c_ d.mp4')
  // 净化的核心要求：标题里的 / 不能变成层级
  assert.equal(out.split('/').length, 2)
})

test('路径不能逃出根目录', () => {
  assert.throws(() => resolveInside('/video', '../etc/passwd'))
  assert.equal(resolveInside('/video', 'a/b.mp4'), path.resolve('/video', 'a/b.mp4'))
})

test('画质名', () => {
  assert.equal(qualityName(16), '360P')
  assert.equal(qualityName(80), '1080P')
  assert.equal(qualityName(120), '4K')
  assert.equal(qualityName(99999), '99999P')
})

test('wbi：mixinKey 取前 32 位，signParams 带 wts 与 w_rid', () => {
  const keys = { imgUrl: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', subUrl: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png', fetchedAt: 0 }
  const mix = mixinKey(keys.imgUrl, keys.subUrl)
  assert.equal(mix.length, 32)
  const q = signParams({ bvid: 'BV1xx411c7mD', cid: 123 }, keys, 1_700_000_000_000)
  assert.match(q, /bvid=BV1xx411c7mD/)
  assert.match(q, /cid=123/)
  assert.match(q, /wts=1700000000/)
  assert.match(q, /w_rid=[0-9a-f]{32}/)
  // 参数按 key 升序
  assert.ok(q.indexOf('bvid=') < q.indexOf('cid='))
})

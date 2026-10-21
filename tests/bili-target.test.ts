import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBiliInput } from '../src/bili/target.ts'

test('BV 号：大小写不敏感，缺标志位也能认', () => {
  assert.deepEqual(parseBiliInput('BV17x411w7KC'), { kind: 'video', bvid: 'BV17x411w7KC', page: null })
  assert.deepEqual(parseBiliInput('bv17x411w7kc'), { kind: 'video', bvid: 'BV17x411w7kc', page: null })
})

test('链接：带分 P 参数时定位到那一 P', () => {
  const r = parseBiliInput('https://www.bilibili.com/video/BV17x411w7KC/?p=3')
  assert.equal(r.kind, 'video')
  if (r.kind === 'video') {
    assert.equal(r.bvid, 'BV17x411w7KC')
    assert.equal(r.page, 3)
  }
})

test('链接：不带 p 参数时 page 为 null', () => {
  const r = parseBiliInput('https://www.bilibili.com/video/BV17x411w7KC')
  assert.equal(r.kind, 'video')
  if (r.kind === 'video') assert.equal(r.page, null)
})

test('分享文案里夹着链接也能认出来', () => {
  const r = parseBiliInput('看看这个 https://www.bilibili.com/video/BV17x411w7KC?p=2 好看')
  assert.equal(r.kind, 'video')
  if (r.kind === 'video') assert.equal(r.page, 2)
})

test('av 号', () => {
  assert.deepEqual(parseBiliInput('av170001'), { kind: 'video', bvid: 'av170001', page: null })
  assert.deepEqual(parseBiliInput('AV170001'), { kind: 'video', bvid: 'av170001', page: null })
})

test('认不出的东西不硬猜', () => {
  assert.equal(parseBiliInput('随便一句话').kind, 'unknown')
  assert.equal(parseBiliInput('BV123').kind, 'unknown')
})

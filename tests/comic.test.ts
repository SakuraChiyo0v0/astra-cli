/**
 * 漫画域：解析、token/解密、分割数 —— 不打真站。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseComicTarget } from '../src/comic/target.ts'
import { decodeRespData, md5hex, tokenAndParam } from '../src/comic/crypto.ts'
import { filenameStemOf, scrambleSliceCount, slicePlan } from '../src/comic/scramble.ts'
import { commandGroup, groupCommands } from '../src/main.ts'

test('comic 是命令组', () => {
  assert.equal(commandGroup('comic'), true)
  assert.ok(groupCommands('comic').some((c) => c === 'comic get'))
})

test('parseComicTarget：数字 / JM / 链接', () => {
  assert.deepEqual(parseComicTarget('123456'), { kind: 'album', id: '123456' })
  assert.deepEqual(parseComicTarget('JM123456'), { kind: 'album', id: '123456' })
  assert.deepEqual(parseComicTarget('jm999'), { kind: 'album', id: '999' })
  assert.deepEqual(parseComicTarget('https://example.com/album/441923'), { kind: 'album', id: '441923' })
  assert.deepEqual(parseComicTarget('https://example.com/photo/413446/?x=1'), { kind: 'photo', id: '413446' })
  assert.throws(() => parseComicTarget('hello'), /认不出/)
})

test('tokenAndParam：固定 ts 可复现', () => {
  const a = tokenAndParam('1700566805')
  assert.equal(a.tokenparam, '1700566805,2.1.12')
  assert.equal(a.token, md5hex('1700566805185Hcomic3PAPP7R'))
  assert.match(a.token, /^[0-9a-f]{32}$/)
})

test('decodeRespData：AES-256-ECB + PKCS7', () => {
  // 固定向量：ts=1700566805 secret=185Hcomic3PAPP7R plaintext={"hello":"world"}
  const encoded = 'azO8IcnMHSannRvMcuEU1veC9x89GOfzsnJgCL7FiWE='
  assert.equal(decodeRespData(encoded, '1700566805', '185Hcomic3PAPP7R'), JSON.stringify({ hello: 'world' }))
})

test('scrambleSliceCount：阈值与公式', () => {
  assert.equal(scrambleSliceCount(220980, 100, '00001'), 0)
  assert.equal(scrambleSliceCount(220980, 220980, '00001'), 10)
  assert.equal(scrambleSliceCount(220980, 268850, '00001'), scrambleSliceCount(220980, 268850, '00001'))
  const n = scrambleSliceCount(220980, 500000, '01111')
  assert.ok(n >= 2 && n <= 20)
  assert.equal(n % 2, 0)
})

test('filenameStemOf / slicePlan', () => {
  assert.equal(filenameStemOf('00047.webp'), '00047')
  assert.equal(filenameStemOf('path/01111.jpg?v=1'), '01111')
  const plan = slicePlan(100, 10)
  assert.equal(plan.length, 10)
  assert.equal(plan.reduce((s, p) => s + p.h, 0), 100)
})

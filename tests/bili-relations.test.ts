import assert from 'node:assert/strict'
import test from 'node:test'

import { mapRelationUser } from '../src/bili/relations.ts'

test('mapRelationUser 拍平正常条目', () => {
  const user = mapRelationUser({ mid: 3493079625500884, uname: 'AmeChan', sign: '签名' }, 0)
  assert.deepEqual(user, { mid: 3493079625500884, name: 'AmeChan', sign: '签名', index: 0 })
})

test('注销/封禁账号没有 uname 时退回 mid 字符串', () => {
  const user = mapRelationUser({ mid: 123456, uname: undefined, sign: null }, 7)
  assert.equal(user.name, 'mid123456')
  assert.equal(user.sign, '')
  assert.equal(user.index, 7)
})

test('缺 mid 时补 0，不抛错', () => {
  const user = mapRelationUser({ uname: 'x' }, 2)
  assert.equal(user.mid, 0)
  assert.equal(user.name, 'x')
})

test('uname 带空白要 trim', () => {
  assert.equal(mapRelationUser({ mid: 1, uname: '  name  ' }, 0).name, 'name')
})

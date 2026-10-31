import assert from 'node:assert/strict'
import test from 'node:test'

import { mapRelationUser, resolveGroup, type FollowGroup } from '../src/bili/relations.ts'

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

const GROUPS: FollowGroup[] = [
  { tagid: -10, name: '特别关注', count: 0, tip: '' },
  { tagid: 0, name: '默认分组', count: 54, tip: '' },
  { tagid: 200274720, name: '我的世界', count: 25, tip: '' },
  { tagid: 375712721, name: '视频内容频道', count: 60, tip: '' },
  { tagid: 375712673, name: '文字内容频道', count: 25, tip: '' },
]

test('resolveGroup 认 tagid', () => {
  assert.equal(resolveGroup(GROUPS, '200274720').name, '我的世界')
})

test('resolveGroup 认精确名字', () => {
  assert.equal(resolveGroup(GROUPS, '我的世界').tagid, 200274720)
})

test('resolveGroup 唯一部分匹配也能中', () => {
  assert.equal(resolveGroup(GROUPS, '世界').tagid, 200274720)
})

test('resolveGroup 多组匹配时报 AMBIGUOUS_GROUP，不自己挑一个', () => {
  assert.throws(() => resolveGroup(GROUPS, '内容频道'), /匹配到多个分组/)
})

test('resolveGroup 找不到时报 GROUP_NOT_FOUND 并列出可用分组', () => {
  assert.throws(() => resolveGroup(GROUPS, '不存在的组'), /没有叫/)
})

test('resolveGroup 空输入报错', () => {
  assert.throws(() => resolveGroup(GROUPS, '  '), /不能为空/)
})

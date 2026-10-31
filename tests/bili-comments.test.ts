/**
 * `bili comments` 的纯函数部分：接口原始结构 → 输出结构的拍平。
 *
 * 为什么要测：评论接口字段名很乱（rpid 可能是 number 或 string、rcount 不在
 * 一级对象上、二级回复只给前 3 条），拍平逻辑错了不会报错，只会静默丢内容。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapReply, type RawReply } from '../src/bili/comments.ts'

const raw: RawReply = {
  rpid: 123456789,
  like: 8,
  ctime: 1793464124,
  member: { uname: '嗬h', mid: 225924875 },
  content: { message: '  moss 提示词很听话，\n但人物肢体容易崩  ' },
  rcount: 5,
  replies: [
    { member: { uname: 'A' }, content: { message: '同意' } },
    { member: { uname: 'B' }, content: { message: '确实' } },
  ],
}

test('拍平一级评论：rpid 转字符串、空白折叠、字段齐全', () => {
  const item = mapReply(raw, false)
  assert.equal(item.rpid, '123456789')
  assert.equal(item.user, '嗬h')
  assert.equal(item.uid, 225924875)
  assert.equal(item.like, 8)
  assert.equal(item.ctime, 1793464124)
  assert.equal(item.replyCount, 5)
  assert.equal(item.message, 'moss 提示词很听话， 但人物肢体容易崩')
})

test('不带 --replies 时不展开二级回复', () => {
  assert.deepEqual(mapReply(raw, false).replies, [])
})

test('带 --replies 时展开前几条，并同样折叠空白', () => {
  const item = mapReply(raw, true)
  assert.equal(item.replies.length, 2)
  assert.deepEqual(item.replies[0], { user: 'A', message: '同意' })
})

test('字段缺失不崩：没 member / content / replies 也能出一条空壳', () => {
  const item = mapReply({ rpid: undefined, member: undefined, content: undefined }, true)
  assert.equal(item.rpid, '')
  assert.equal(item.user, '')
  assert.equal(item.uid, 0)
  assert.equal(item.message, '')
  assert.deepEqual(item.replies, [])
})

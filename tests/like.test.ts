/**
 * 红心写操作的防护。
 *
 * 这是唯一会改动用户真实账号的地方，重点验四件事：
 * - 预览不执行（prepareLike 纯逻辑，不发请求）
 * - 已经是目标状态的跳过
 * - 令牌对不上 / 过期都拒绝
 * - 令牌只能用一次
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let like: typeof import('../src/music/like.ts')

before(async () => {
  process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-like-'))
  like = await import('../src/music/like.ts')
})

const tracks = [
  { id: '449818741', title: '光年之外', artists: ['G.E.M.邓紫棋'], currentlyLiked: false },
  { id: '2034742057', title: 'アイドル', artists: ['YOASOBI'], currentlyLiked: false },
]

const fakeSession = { cookie: 'MUSIC_U=fake', userId: '1', nickname: null, savedAt: '' }

test('预览：不执行，只返回令牌；已经是红的自动跳过', () => {
  const preview = like.prepareLike('like', tracks)
  assert.equal(preview.status, 'needs_confirmation')
  assert.equal(preview.action, 'like')
  assert.equal(preview.willChange, 2)
  assert.equal(preview.willSkip, 0)
  assert.match(preview.token, /^[0-9a-f]{16}$/)
  assert.equal(preview.tracks.length, 2)
  assert.match(preview.next, /--confirm/)
})

test('预览：全部已是目标状态时，明说不需要改动', () => {
  const already = tracks.map((t) => ({ ...t, currentlyLiked: true }))
  const preview = like.prepareLike('like', already)
  assert.equal(preview.willChange, 0)
  assert.equal(preview.willSkip, 2)
  assert.match(preview.next, /不需要改动/)
})

test('取消红心：只挑当前是红的那些', () => {
  const mixed = [
    { id: '1', title: 'a', artists: ['x'], currentlyLiked: true },
    { id: '2', title: 'b', artists: ['x'], currentlyLiked: false },
  ]
  const preview = like.prepareLike('unlike', mixed)
  assert.equal(preview.willChange, 1)
  assert.equal(preview.willSkip, 1)
})

test('令牌对不上就拒绝，不执行任何写请求', async () => {
  like.prepareLike('like', tracks)
  await assert.rejects(like.applyLike('deadbeefdeadbeef', fakeSession), /令牌对不上/)
})

test('没有待确认操作时拒绝', async () => {
  like.clearPending()
  await assert.rejects(like.applyLike('whatever', fakeSession), /没有待确认的红心操作/)
})

test('令牌过期就拒绝并清掉', async () => {
  const preview = like.prepareLike('like', tracks)
  // 把时间往前挪 6 分钟：直接改落盘文件里的 createdAt
  const { readFileSync, writeFileSync } = await import('node:fs')
  const file = path.join(process.env.ASTRA_HOME!, 'like-pending.json')
  const pending = JSON.parse(readFileSync(file, 'utf8'))
  pending.createdAt = Date.now() - 6 * 60 * 1000
  writeFileSync(file, JSON.stringify(pending))
  await assert.rejects(like.applyLike(preview.token, fakeSession), /已过期/)
  // 过期后待办应被清掉
  assert.equal(like.clearPending(), false)
})

test('令牌只能用一次（执行后待办即清空）', async () => {
  // 用空曲目集合的预览，避免真的发网络请求
  const empty = like.prepareLike('like', [])
  // willChange 为 0 时是空操作，applyLike 仍会清掉待办
  const first = await like.applyLike(empty.token, fakeSession)
  assert.equal(first.changedCount, 0)
  await assert.rejects(like.applyLike(empty.token, fakeSession), /没有待确认的红心操作/)
})

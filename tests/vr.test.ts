/**
 * VRChat 域。测三样不依赖网络的东西：
 * - 响应形状归一化（VRChat 原始响应字段很多，必须收拾干净）
 * - Basic 认证头的编码（VRChat 要求先 URL 编码再 base64）
 * - 写操作的二次确认（不能一句话就改用户账号）
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let data: typeof import('../src/vr/data.ts')
let api: typeof import('../src/vr/api.ts')
let confirm: typeof import('../src/core/confirm.ts')

before(async () => {
  process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-vr-'))
  data = await import('../src/vr/data.ts')
  api = await import('../src/vr/api.ts')
  confirm = await import('../src/core/confirm.ts')
})

test('Basic 头：账号密码各自 URL 编码后再 base64', () => {
  // VRChat 的实测要求：密码里含 @ : 等符号时，不编码会导致 401
  const header = api.basicHeader('me@example.com', 'p@ss:word')
  assert.match(header, /^Basic /)
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  assert.equal(decoded, 'me%40example.com:p%40ss%3Aword')
})

test('用户归一化：从 location 推出当前世界', () => {
  const online = data.toUser({ id: 'usr_1', displayName: 'A', location: 'wrld_abc:12345~region(us)', status: 'active', isFriend: true })
  assert.equal(online.worldId, 'wrld_abc')
  assert.equal(online.location, 'wrld_abc:12345~region(us)')
  assert.equal(online.isFriend, true)

  const offline = data.toUser({ id: 'usr_2', displayName: 'B', location: 'offline' })
  assert.equal(offline.worldId, null, '离线时不该有 worldId')
})

test('实例归一化：拆出世界 id、实例 id、地区', () => {
  const i = data.toInstance({ location: 'wrld_abc:12345~region(jp)', occupants: 12, capacity: 32, accessType: 'public' })
  assert.equal(i.worldId, 'wrld_abc')
  assert.equal(i.instanceId, '12345')
  assert.equal(i.region, 'jp')
  assert.equal(i.occupants, 12)
})

test('实例归一化：没有 region 后缀也不炸', () => {
  const i = data.toInstance({ location: 'wrld_abc:12345' })
  assert.equal(i.worldId, 'wrld_abc')
  assert.equal(i.region, null)
})

test('世界 / 通知 / 群组：只保留用得上的字段', () => {
  const w = data.toWorld({ id: 'wrld_1', name: 'W', occupants: 3, capacity: 16, tags: ['a'], updated_at: '2026-01-01' })
  assert.deepEqual(Object.keys(w).sort(), ['authorName', 'capacity', 'description', 'favorites', 'id', 'name', 'occupants', 'releaseStatus', 'tags', 'thumbnailImageUrl', 'updatedAt', 'visits'])

  const n = data.toNotification({ id: 'notif_1', type: 'friendRequest', message: 'hi', seen: false, senderUserId: 'usr_1' })
  assert.equal(n.seen, false)
  assert.equal(n.senderUserId, 'usr_1')

  const g = data.toGroup({ id: 'grp_1', name: 'G', memberCount: 10, isMember: true })
  assert.equal(g.isMember, true)
})

test('确认令牌：预览不执行、令牌只能用一次、参数变了对不上', () => {
  const params = { userId: 'usr_1' }
  const preview = confirm.prepare('vr-test', 'friends.request', params, { userId: 'usr_1' }, '确认后执行')
  assert.equal(preview.status, 'needs_confirmation')
  assert.match(preview.token, /^[0-9a-f]{16}$/)

  // 令牌对不上
  assert.throws(() => confirm.consume('vr-test', 'deadbeefdeadbeef'), /令牌对不上/)
  // 动作对不上
  assert.throws(() => confirm.consume('vr-test', preview.token, 'friends.remove'), /令牌属于/)

  const pending = confirm.consume('vr-test', preview.token, 'friends.request')
  assert.equal(pending.action, 'friends.request')
  // 参数没变 → 指纹匹配
  assert.equal(confirm.bindingMatches(pending, { userId: 'usr_1' }), true)
  // 参数变了 → 指纹对不上
  assert.equal(confirm.bindingMatches(pending, { userId: 'usr_2' }), false)

  confirm.clearPending('vr-test')
  assert.throws(() => confirm.consume('vr-test', preview.token), /没有待确认的操作/)
})

test('确认令牌：指纹与参数顺序无关', () => {
  const a = confirm.prepare('vr-test2', 'x', { a: 1, b: 2 }, {}, '')
  const pending = confirm.consume('vr-test2', a.token)
  assert.equal(confirm.bindingMatches(pending, { b: 2, a: 1 }), true)
  confirm.clearPending('vr-test2')
})

test('确认令牌：过期就拒绝并清掉', () => {
  const preview = confirm.prepare('vr-test3', 'x', { a: 1 }, {}, '')
  const file = path.join(process.env.ASTRA_HOME!, 'pending-vr-test3.json')
  const pending = JSON.parse(readFileSync(file, 'utf8'))
  pending.createdAt = Date.now() - 6 * 60 * 1000
  writeFileSync(file, JSON.stringify(pending))
  assert.throws(() => confirm.consume('vr-test3', preview.token), /已过期/)
  assert.equal(confirm.readPending('vr-test3'), null)
})

test('不同用途的待办互不覆盖', () => {
  const a = confirm.prepare('vr-a', 'act', { v: 1 }, {}, '')
  const b = confirm.prepare('vr-b', 'act', { v: 2 }, {}, '')
  assert.notEqual(a.token, b.token)
  assert.equal(confirm.consume('vr-a', a.token).action, 'act')
  assert.equal(confirm.consume('vr-b', b.token).action, 'act')
  confirm.clearPending('vr-a')
  confirm.clearPending('vr-b')
})

test('权限位归一化：只留用得上的字段', () => {
  const p = data.permissionFrom({ id: 'perm_1', name: 'Permissions.Users.Edit', ownerId: 'usr_1', displayName: 'Edit User', description: 'desc' })
  assert.deepEqual(p, { id: 'perm_1', name: 'Permissions.Users.Edit', ownerId: 'usr_1', displayName: 'Edit User', description: 'desc' })
})

test('群组成员归一化：displayName 可能在外层也可能嵌在 user 里', () => {
  const a = data.toGroupMember({ userId: 'usr_1', user: { displayName: 'A' }, roleIds: ['role_1'], joinedAt: '2026-01-01' })
  assert.equal(a.displayName, 'A')
  assert.deepEqual(a.roleIds, ['role_1'])
  const b = data.toGroupMember({ userId: 'usr_2', displayName: 'B' })
  assert.equal(b.displayName, 'B')
  assert.deepEqual(b.roleIds, [], '没有 roleIds 时给空数组，不是 undefined')
})

test('群组角色归一化：isDefault 只在真的是 true 时为真', () => {
  const r = data.toGroupRole({ id: 'role_1', name: 'Member', isDefault: true, permissions: ['p1', 'p2'], order: 3 })
  assert.equal(r.isDefault, true)
  assert.equal(r.permissions.length, 2)
  assert.equal(data.toGroupRole({ id: 'r2', name: 'X' }).isDefault, false, '缺字段时不能当默认角色')
})

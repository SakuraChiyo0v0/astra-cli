/**
 * 写操作审计。核心两条：失败不能挡住主流程；记录里不能有敏感信息。
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let audit: typeof import('../src/core/audit.ts')

before(async () => {
  process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-audit-'))
  process.env.ASTRA_MUSIC_DIR = path.join(process.env.ASTRA_HOME!, 'music')
  audit = await import('../src/core/audit.ts')
})

test('记一条成功的写操作', () => {
  audit.record({ action: 'music.like', summary: '点红心 光年之外', ok: true, detail: { trackIds: ['449818741'] } })
  const list = audit.listAudit({ limit: 10 })
  const hit = list.find((r) => r.action === 'music.like')
  assert.ok(hit)
  assert.equal(hit.ok, true)
  assert.equal(hit.domain, 'music')
  assert.match(hit.at, /^\d{4}-\d{2}-\d{2}T/)
})

test('失败也记，带上原因', () => {
  audit.record({ action: 'vr.groups.leave', summary: '退群 测试群', ok: false, error: '不在群里' })
  const failed = audit.listAudit({ failedOnly: true })
  assert.ok(failed.length >= 1)
  assert.equal(failed[0]!.ok, false)
  assert.match(failed[0]!.error ?? '', /不在群里/)
})

test('按域过滤', () => {
  audit.record({ action: 'vr.friends.request', summary: '加好友 A', ok: true })
  const vr = audit.listAudit({ domain: 'vr' })
  assert.ok(vr.length >= 1)
  assert.ok(vr.every((r) => r.domain === 'vr'))
})

test('audited 包装：成功记录、失败记录并原样抛出', async () => {
  const okResult = await audit.audited({ action: 'music.unlike', summary: '取消红心 X' }, async () => 'done')
  assert.equal(okResult, 'done')
  assert.ok(audit.listAudit({ limit: 50 }).some((r) => r.action === 'music.unlike' && r.ok))

  await assert.rejects(
    audit.audited({ action: 'vr.invites.send', summary: '发邀请 Y' }, async () => {
      throw new Error('上游拒绝')
    }),
    /上游拒绝/,
  )
  const failed = audit.listAudit({ failedOnly: true }).find((r) => r.action === 'vr.invites.send')
  assert.ok(failed, '失败必须留下记录')
  assert.match(failed!.error ?? '', /上游拒绝/)
})

test('超长内容被截断，不会把整段响应塞进库', () => {
  audit.record({ action: 'music.like', summary: 'x'.repeat(2000), ok: true, detail: { blob: 'y'.repeat(5000) } })
  const list = audit.listAudit({ limit: 5 })
  const hit = list.find((r) => r.summary.length > 100)
  assert.ok(hit)
  assert.ok(hit!.summary.length <= 500, `summary 长度 ${hit!.summary.length}`)
})

test('超大的 detail 不能被截成半个 JSON：要么原样可解析，要么明确标成截断', () => {
  audit.record({ action: 'music.like', summary: '大 detail', ok: true, detail: { blob: 'y'.repeat(5000), id: 'abc' } })
  const hit = audit.listAudit({ limit: 5 }).find((r) => r.summary === '大 detail')
  assert.ok(hit, '这条记录必须还在')
  const detail = hit!.detail
  assert.ok(detail, 'detail 不能被整条丢掉')
  // 关键：不能是 {unreadable:true} —— 那说明存进去的是坏 JSON
  assert.equal(detail!.unreadable, undefined, `存进去的 JSON 解析失败了，说明序列化后被字符截断`)
  // 超大时应是明确的截断标记，而不是半截内容
  assert.equal(detail!.truncated, true)
  assert.ok(Array.isArray(detail!.keys))
})

test('prune 只保留最近 N 条', () => {
  for (let i = 0; i < 30; i += 1) audit.record({ action: 'test.x', summary: `第 ${i} 条`, ok: true })
  const removed = audit.pruneAudit(10)
  assert.ok(removed > 0, '应该有被删掉的')
  assert.ok(audit.listAudit({ limit: 500 }).length <= 20)
})

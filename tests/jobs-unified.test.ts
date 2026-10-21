/**
 * 统一任务视图：不同域的任务在一张表里，`astra jobs` 不分域也能列全。
 *
 * 重点验：domain 字段跟着任务走、不传 domain 时全返回、传了就过滤。
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let jobs: typeof import('../src/core/jobs.ts')

before(async () => {
  process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-jobs-'))
  process.env.ASTRA_MUSIC_DIR = path.join(process.env.ASTRA_HOME!, 'music')
  jobs = await import('../src/core/jobs.ts')
})

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id${i}`, title: `t${i}`, subtitle: 's' }))

test('两个域的任务能在一张表里列出来', () => {
  const music = jobs.createJob({ domain: 'music', kind: 'album', title: '音乐任务', profile: 'flac', items: items(2) })
  const bili = jobs.createJob({ domain: 'bili', kind: 'pages', title: 'B 站任务', profile: '1080P', items: items(3) })

  assert.equal(music.domain, 'music')
  assert.equal(bili.domain, 'bili')

  // 不传 domain → 全都要（这就是 `astra jobs` 的行为）
  const all = jobs.listJobs(50, false)
  const ids = all.map((j) => j.id)
  assert.ok(ids.includes(music.id), '音乐任务应在全量列表里')
  assert.ok(ids.includes(bili.id), 'B 站任务应在全量列表里')
  const domains = new Set(all.map((j) => j.domain))
  assert.ok(domains.has('music') && domains.has('bili'))
})

test('传 domain 只返回该域', () => {
  const onlyMusic = jobs.listJobs(50, false, 'music')
  assert.ok(onlyMusic.length > 0)
  assert.ok(onlyMusic.every((j) => j.domain === 'music'))
  const onlyBili = jobs.listJobs(50, false, 'bili')
  assert.ok(onlyBili.every((j) => j.domain === 'bili'))
})

test('任务 id 跨域唯一，按 id 能直接查到所属域', () => {
  const j = jobs.createJob({ domain: 'music', kind: 'songs', title: 'x', items: items(1) })
  const found = jobs.getJob(j.id, false)
  assert.equal(found.job.domain, 'music')
  assert.equal(found.job.id, j.id)
})

test('空任务被拒', () => {
  assert.throws(() => jobs.createJob({ domain: 'music', kind: 'x', title: 'y', items: [] }), /没有内容/)
})

test('状态文案覆盖每个状态', () => {
  for (const s of ['queued', 'running', 'done', 'partial', 'failed', 'cancelled', 'interrupted'] as const) {
    assert.equal(typeof jobs.statusLabel(s), 'string')
    assert.ok(jobs.statusLabel(s).length > 0)
  }
})

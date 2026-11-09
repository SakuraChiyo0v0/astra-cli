/**
 * core/jobs 的两处改动：新建任务不能被误判成「已中断」、finalize 钩子与 patchJob。
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let jobs: typeof import('../src/core/jobs.ts')

before(async () => {
  process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-jobs-fin-'))
  process.env.ASTRA_QUIET = '1'
  jobs = await import('../src/core/jobs.ts')
})

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id${i}`, title: `t${i}` }))

test('刚建好、还没起 worker 的任务是「排队中」，不是「已中断」', () => {
  // 回归：createJob 自己返回视图时 pid 还是空，旧逻辑当场把它写成 interrupted，
  // `novel get --wait` 一上来就看到「已中断」并立刻返回
  const job = jobs.createJob({ domain: 'fin-a', kind: 'k', title: 't', items: items(1) })
  assert.equal(job.status, 'queued')
  assert.equal(jobs.getJob(job.id, false).job.status, 'queued')
})

test('finalize 在通知前跑，能改状态与 meta；抛错记为 failed', async () => {
  let finalized = 0
  jobs.registerJobHandler('fin-b', {
    concurrency: () => 2,
    summary: () => [],
    handle: async () => ({ status: 'downloaded' }),
    finalize: async (job) => {
      finalized += 1
      // 回归：finalize 期间任务对外必须还是 running —— 轮询的调用方看到 done 时产物要已经写好
      assert.equal(jobs.getJob(job.id, false).job.status, 'running')
      assert.equal(job.status, 'done', 'finalize 拿到的是即将落定的状态')
      await new Promise((r) => setTimeout(r, 20))
      jobs.patchJob(job.id, { meta: { output: { path: '/x.epub' } } })
      return ['done']
    },
  })
  const ok = jobs.createJob({ domain: 'fin-b', kind: 'k', title: 't', items: items(3) })
  await jobs.runWorker('fin-b', ok.id)
  const view = jobs.getJob(ok.id, false).job
  assert.equal(finalized, 1)
  assert.equal(view.status, 'done')
  assert.deepEqual(view.meta?.output, { path: '/x.epub' })
  assert.equal(view.meta?.domain, 'fin-b', 'patchJob 是浅合并，不能把 domain 冲掉')

  jobs.registerJobHandler('fin-c', {
    concurrency: () => 1,
    summary: () => [],
    handle: async () => ({ status: 'downloaded' }),
    finalize: async () => {
      throw new Error('打包失败')
    },
  })
  const bad = jobs.createJob({ domain: 'fin-c', kind: 'k', title: 't', items: items(1) })
  await jobs.runWorker('fin-c', bad.id)
  const badView = jobs.getJob(bad.id, false).job
  assert.equal(badView.status, 'failed')
  assert.equal(badView.error, '打包失败')
})

test('finalize 期间被取消：以取消为准，不被最终状态覆盖', async () => {
  jobs.registerJobHandler('fin-d', {
    concurrency: () => 1,
    summary: () => [],
    handle: async () => ({ status: 'downloaded' }),
    finalize: async (job) => {
      jobs.cancelJob(job.id)
      return []
    },
  })
  const job = jobs.createJob({ domain: 'fin-d', kind: 'k', title: 't', items: items(1) })
  await jobs.runWorker('fin-d', job.id)
  assert.equal(jobs.getJob(job.id, false).job.status, 'cancelled')
})

/**
 * 限流时任务原地等：不再把这一话记失败、让任务以「部分完成」收尾（那样每被限流一次就发一条通知）。
 * 时钟和睡眠都注入，不真的等。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-comic-wait-'))

const { withQuotaWait, MAX_QUOTA_WAITS } = await import('../src/comic/jobs.ts')
const { QuotaError } = await import('../src/comic/sources/types.ts')

function fakeClock() {
  let t = Date.parse('2026-11-10T01:00:00Z')
  const slept: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => { slept.push(ms); t += ms },
    slept,
  }
}

const limited = () => new QuotaError('copymanga', 3600, '拷贝漫画暂时拒绝（code 210，约 1 小时自动解除）')

test('被限流两次后成功：原地等两轮，结果照常返回，等待状态最后清掉', async () => {
  const clock = fakeClock()
  const waits: unknown[] = []
  let calls = 0
  const result = await withQuotaWait(
    async () => {
      calls += 1
      if (calls <= 2) throw limited()
      return 'ok'
    },
    () => false,
    { cancelled: async () => false, onWait: async (w) => { waits.push(w) }, sleep: clock.sleep, now: clock.now },
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 3)
  // 两次开始等 + 一次清除
  assert.equal(waits.length, 3)
  assert.equal(waits.at(-1), null)
  const first = waits[0] as { source: string; attempt: number; until: string }
  assert.equal(first.source, 'copymanga')
  assert.equal(first.attempt, 1)
  // 每轮至少等到源给的恢复时间（3600 秒）
  const total = clock.slept.reduce((a, b) => a + b, 0)
  assert.ok(total >= 2 * 3600 * 1000, `只睡了 ${total}ms`)
  // 睡眠是切片的，每片都能检查取消
  assert.ok(Math.max(...clock.slept) <= 30_000)
})

test('一直被限流且没有进展：等满上限才放弃，错误里写清楚', async () => {
  const clock = fakeClock()
  let calls = 0
  await assert.rejects(
    withQuotaWait(async () => { calls += 1; throw limited() }, () => false,
      { cancelled: async () => false, onWait: async () => {}, sleep: clock.sleep, now: clock.now }),
    (err: Error) => err.message.includes(`连续 ${MAX_QUOTA_WAITS} 次`),
  )
  assert.equal(calls, MAX_QUOTA_WAITS + 1)
})

test('每轮都下到一点再被限流：计数清零，不会因为「慢」被放弃', async () => {
  const clock = fakeClock()
  let calls = 0
  const rounds = MAX_QUOTA_WAITS + 3
  const result = await withQuotaWait(
    async () => {
      calls += 1
      if (calls <= rounds) throw limited()
      return 'done'
    },
    () => true,
    { cancelled: async () => false, onWait: async () => {}, sleep: clock.sleep, now: clock.now },
  )
  assert.equal(result, 'done')
  assert.equal(calls, rounds + 1)
})

test('等待中被取消：立刻停下，不再重试', async () => {
  const clock = fakeClock()
  let calls = 0
  let checks = 0
  await assert.rejects(
    withQuotaWait(async () => { calls += 1; throw limited() }, () => false, {
      cancelled: async () => { checks += 1; return checks > 2 },
      onWait: async () => {},
      sleep: clock.sleep,
      now: clock.now,
    }),
    /被取消/,
  )
  assert.equal(calls, 1)
})

test('不是限流的错误：原样抛出，不等', async () => {
  const clock = fakeClock()
  await assert.rejects(
    withQuotaWait(async () => { throw new Error('第 3 页不是图片') }, () => false,
      { cancelled: async () => false, onWait: async () => {}, sleep: clock.sleep, now: clock.now }),
    /不是图片/,
  )
  assert.equal(clock.slept.length, 0)
})

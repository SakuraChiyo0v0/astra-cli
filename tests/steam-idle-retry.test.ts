/**
 * 挂机进程的退避重连表。
 *
 * 背景：`error` 事件以前直接 `process.exit(1)`，代理 reload / 切节点造成的
 * 一次网络瞬断就能把挂了一天的会话弄掉（2026-11-01 一小时掉两次）。
 * 现在按 10s → 30s → 60s 重连，三次都失败才退出交给看门狗。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { IDLE_RETRY_DELAYS, idleRetryDelay } from '../src/steam/idle-commands.ts'

describe('挂机退避重连', () => {
  it('前三次失败分别退避 10s / 30s / 60s', () => {
    assert.equal(idleRetryDelay(0), 10_000)
    assert.equal(idleRetryDelay(1), 30_000)
    assert.equal(idleRetryDelay(2), 60_000)
  })

  it('用完退避表就返回 null（交给看门狗，不无限重试）', () => {
    assert.equal(idleRetryDelay(3), null)
    assert.equal(idleRetryDelay(99), null)
  })

  it('退避时间是递增的 —— 越试越久，避免猛打 Steam', () => {
    for (let i = 1; i < IDLE_RETRY_DELAYS.length; i += 1) {
      assert.ok(IDLE_RETRY_DELAYS[i]! > IDLE_RETRY_DELAYS[i - 1]!)
    }
  })
})

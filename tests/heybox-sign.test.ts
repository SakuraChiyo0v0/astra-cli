/**
 * 小黑盒签名的固定向量。
 *
 * 向量来自 MIT 许可的 Insect-rippler/XIAOHEIHE_MCP（`test/signing.test.ts`），
 * 时间与随机数都钉死，所以这里能当回归测试：签名一旦被改坏，先红这几条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePath, signPath, workshopRnd } from '../src/heybox/sign.ts'

const TIME_MS = 1_750_000_000 * 1000
const NONCE = 'D4DDFEAD7CBBD88223D35C5CF6D7C9AE'

const VECTORS: Array<{ path: string; hkey: string; random?: number }> = [
  { path: '/bbs/app/feeds', hkey: 'U1V1I44' },
  { path: '/bbs/app/feeds', hkey: 'TX73I64', random: 0.987654321 },
  { path: '/bbs/app/link/tree', hkey: 'U1V1I44' },
  { path: '/bbs/app/user/message', hkey: 'U1V1I44' },
  { path: '/bbs/app/comment/create', hkey: 'U1V1I44' },
  // 重复斜杠与尾斜杠归一化后签名必须一致
  { path: '//bbs//app//feeds//', hkey: 'U1V1I44' },
  { path: '/bbs/app', hkey: 'U1V1I44' },
  // 前七位以内不同的路径要产出不同 hkey
  { path: '/api/x', hkey: '7VWPI35' },
]

test('hkey 与上游固定向量一致', () => {
  for (const v of VECTORS) {
    const signed = signPath(v.path, v.random === undefined
      ? { nowMs: TIME_MS, nonce: NONCE }
      : { nowMs: TIME_MS, random: v.random })
    assert.equal(signed.hkey, v.hkey, `path=${v.path}`)
    assert.equal(signed._time, 1_750_000_000)
  }
})

test('normalizePath 补首尾斜杠并压掉重复斜杠', () => {
  assert.equal(normalizePath('bbs/app/feeds'), '/bbs/app/feeds/')
  assert.equal(normalizePath('//bbs//app//feeds//'), '/bbs/app/feeds/')
})

test('workshopRnd 对同一 nonce 稳定，换 nonce 就变', () => {
  const base = { nonce: NONCE, _time: 1_750_000_000 }
  assert.equal(workshopRnd(base), '15:1c70209a88c32d9831b1474d6cca56f8d8aec9082d21a558a6aa23cfb96253ad')
  assert.notEqual(workshopRnd(base), workshopRnd({ ...base, nonce: 'AAAA' }))
})

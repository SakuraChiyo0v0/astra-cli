/**
 * 磁盘用量。用真实临时目录造文件，验证统计准确、上限生效、只读不到时不崩。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dirUsage } from '../src/core/disk.ts'

test('累加真实文件大小，含子目录', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-disk-'))
  mkdirSync(path.join(dir, 'a', 'b'), { recursive: true })
  writeFileSync(path.join(dir, 'f1.bin'), Buffer.alloc(1000))
  writeFileSync(path.join(dir, 'a', 'f2.bin'), Buffer.alloc(2000))
  writeFileSync(path.join(dir, 'a', 'b', 'f3.bin'), Buffer.alloc(3000))
  const u = dirUsage(dir)
  assert.equal(u.files, 3)
  assert.equal(u.bytes, 6000)
  assert.equal(u.truncated, false)
  assert.match(u.detail, /个文件/)
})

test('文件数超上限会截断并标出来，不是静默少算', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-disk2-'))
  for (let i = 0; i < 30; i += 1) writeFileSync(path.join(dir, `f${i}.bin`), Buffer.alloc(10))
  const u = dirUsage(dir, { maxFiles: 10 })
  assert.equal(u.truncated, true)
  assert.ok(u.files >= 10)
  assert.match(u.detail, /超过上限/)
})

test('拿得到所在文件系统的剩余空间', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-disk3-'))
  const u = dirUsage(dir)
  // 大多数环境能拿到；拿不到时为 null，也不算错
  if (u.fsFreeBytes !== null) {
    assert.ok(u.fsFreeBytes > 0)
    assert.ok(u.fsTotalBytes !== null && u.fsTotalBytes >= u.fsFreeBytes)
    assert.match(u.detail, /剩余/)
  }
})

test('目录不存在时不抛错，返回 0', () => {
  const u = dirUsage(path.join(tmpdir(), 'astra-definitely-missing-' + Date.now()))
  assert.equal(u.bytes, 0)
  assert.equal(u.files, 0)
})

test('剩余空间低于警戒线会标 lowSpace', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-disk4-'))
  // 设一个天文数字的阈值，必然低于它
  const u = dirUsage(dir, { minFreeGb: 1e9 })
  assert.equal(u.lowSpace, true)
  assert.match(u.detail, /低于警戒线/)
})

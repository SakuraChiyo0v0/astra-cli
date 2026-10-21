/**
 * 自检的目录可写探测。
 *
 * 为什么要"真写一个文件"：只看权限位不够。NAS 上踩过一次 ——
 * 权限显示 755，但挂载点实际只读，下载时才失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, chmodSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { checkWritable } from '../src/core/doctor.ts'

test('可写目录：报告 ok，且不留下探测文件', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-w-'))
  const result = checkWritable(dir)
  assert.equal(result.ok, true, result.detail)
  assert.match(result.detail, /可写/)
  // 探针必须清掉，不能污染用户的目录
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('.astra-write-test')).length, 0)
})

test('不存在的目录：报告不可写而不是抛异常', () => {
  const missing = path.join(tmpdir(), `astra-not-there-${Date.now()}`, 'deep')
  const result = checkWritable(missing)
  assert.equal(result.ok, false)
  assert.match(result.detail, /不可写/)
})

test('可写但实际写不进（模拟只读）：靠真写发现，而不是靠权限位', () => {
  // Windows 上 chmod 基本无效，这个用例只在类 Unix 上有意义
  if (process.platform === 'win32') {
    // 退而验之：把目录换成一个**文件**路径 —— 往文件路径里写文件必然失败
    const dir = mkdtempSync(path.join(tmpdir(), 'astra-w-'))
    const asFile = path.join(dir, 'not-a-dir')
    chmodSync(dir, 0o755)
    const result = checkWritable(path.join(asFile, 'x'))
    assert.equal(result.ok, false)
    return
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-w-'))
  chmodSync(dir, 0o500)
  try {
    const result = checkWritable(dir)
    assert.equal(result.ok, false, '只读目录应当被识别出来')
  } finally {
    chmodSync(dir, 0o755)
  }
})

test('探测后原目录仍然存在（没有误删）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-w-'))
  checkWritable(dir)
  assert.equal(existsSync(dir), true)
})

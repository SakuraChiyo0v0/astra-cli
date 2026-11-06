/**
 * 账户机制（M1）纯函数测试：令牌格式、哈希、脱敏。
 *
 * 不测库：身份/令牌的存储路径依赖 PG/SQLite，留给真机 `astra auth *` 验收。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashToken, maskToken, newToken } from '../src/core/identity.ts'

test('newToken 前缀与长度固定', () => {
  const token = newToken()
  assert.match(token, /^astra_[0-9a-f]{64}$/)
  assert.notEqual(newToken(), token)
})

test('hashToken 稳定且与明文不同', () => {
  const token = 'astra_' + 'a'.repeat(64)
  assert.equal(hashToken(token), hashToken(token))
  assert.match(hashToken(token), /^[0-9a-f]{64}$/)
  assert.notEqual(hashToken(token), token)
  assert.notEqual(hashToken(token), hashToken(token + 'x'))
})

test('maskToken 只露头尾', () => {
  const masked = maskToken('astra_' + 'b'.repeat(64))
  assert.ok(masked.startsWith('astra_bbbb'))
  assert.ok(masked.includes('…'))
  assert.ok(!masked.includes('b'.repeat(20)))
  assert.equal(maskToken('short'), '***')
})

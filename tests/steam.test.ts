/**
 * Steam 的输入校验与凭据处理。
 *
 * 网络部分靠 NAS 上真实验证（代理 + 真实账号），这里只测纯逻辑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { accountIdFromSteamId64, apiKeyDigest, validateSteamId64 } from '../src/steam/auth.ts'

test('SteamID64 形状：17 位、以 7656 开头', () => {
  assert.equal(validateSteamId64('76561197960265729'), null)
  assert.equal(validateSteamId64(' 76561197960265729 '), null, '前后空格应被容忍')
})

test('SteamID64 形状：常见错误给出可读原因', () => {
  assert.match(validateSteamId64('12345') ?? '', /17 位/)
  assert.match(validateSteamId64('12345678901234567') ?? '', /7656/, '17 位但不是 7656 开头')
  assert.match(validateSteamId64('765611979602657291') ?? '', /17 位/, '18 位')
  assert.match(validateSteamId64('abcdefghijklmnopq') ?? '', /17 位/)
})

test('AccountID = SteamID64 - 76561197960265728', () => {
  // 76561197960265728 是基准值，自己减自己是 0
  assert.equal(accountIdFromSteamId64('76561197960265728'), '0')
  assert.equal(accountIdFromSteamId64('76561197960265729'), '1')
})

test('key 指纹：只暴露前 8 位，不泄露原文', () => {
  const key = '88F9A4B8086B28134735FD90A4A49829'
  const digest = apiKeyDigest(key)
  assert.equal(digest.length, 8)
  assert.ok(!digest.includes(key.slice(0, 8)), '指纹不能是原文的前缀')
  // 同一个 key 指纹稳定，不同的 key 指纹不同
  assert.equal(apiKeyDigest(key), digest)
  assert.notEqual(apiKeyDigest('0'.repeat(32)), digest)
})

test('凭据读写：空库时返回 null，不抛异常', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'astra-steam-'))
  const prev = process.env.ASTRA_HOME
  process.env.ASTRA_HOME = home
  try {
    const { loadSteamCredentials } = await import('../src/steam/auth.ts')
    assert.equal(loadSteamCredentials(), null)
  } finally {
    if (prev === undefined) delete process.env.ASTRA_HOME
    else process.env.ASTRA_HOME = prev
  }
})

/**
 * 加密通道的形状。网易云的常量是协议固定值，用固定 secretKey 时输出可复现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { aesEcbDecryptHex, eapiDecryptBody, eapiEncrypt, randomSecretKey, rsaEncryptHex, weapiEncrypt } from '../src/music/crypto.ts'

test('weapi：两层 AES + RSA，固定 secretKey 时结果稳定', () => {
  const a = weapiEncrypt({ type: 3 }, { secretKey: '0123456789abcdef' })
  const b = weapiEncrypt({ type: 3 }, { secretKey: '0123456789abcdef' })
  assert.equal(a.params, b.params)
  assert.equal(a.encSecKey, b.encSecKey)
  // params 是 base64；encSecKey 是 128 字节的 hex
  assert.match(a.params, /^[A-Za-z0-9+/]+=*$/)
  assert.match(a.encSecKey, /^[0-9a-f]{256}$/)
  // 换 secretKey 就不同
  assert.notEqual(weapiEncrypt({ type: 3 }, { secretKey: 'fedcba9876543210' }).params, a.params)
  assert.throws(() => weapiEncrypt({}, { secretKey: 'short' }), /16/)
})

test('weapi：encSecKey 是 secretKey 反转后的 RSA 结果（协议如此）', () => {
  const { encSecKey } = weapiEncrypt({ x: 1 }, { secretKey: 'abcdefghijklmnop' })
  assert.equal(encSecKey, rsaEncryptHex('ponmlkjihgfedcba'))
})

test('randomSecretKey 是 16 位 base62', () => {
  for (let i = 0; i < 20; i += 1) assert.match(randomSecretKey(), /^[a-zA-Z0-9]{16}$/)
})

test('eapi：params 是 AES-ECB 大写 hex，能解回原文', () => {
  const apiPath = '/api/song/enhance/player/url'
  const { params } = eapiEncrypt(apiPath, { ids: '[1]', br: 320000 })
  assert.match(params, /^[0-9A-F]+$/)
  const plain = aesEcbDecryptHex(params)
  const text = JSON.stringify({ ids: '[1]', br: 320000 })
  const digest = createHash('md5').update(`nobody${apiPath}use${text}md5forencrypt`).digest('hex')
  assert.equal(plain, `${apiPath}-36cd479b6b5-${text}-36cd479b6b5-${digest}`)
})

test('eapi 响应：密文解密，明文错误原样保留（风控 8821 是明文）', () => {
  const { params } = eapiEncrypt('/x', { a: 1 })
  assert.equal(eapiDecryptBody(params).encrypted, true)
  const plainError = '{"code":8821,"message":"请切换其他登录方式"}'
  const r = eapiDecryptBody(plainError)
  assert.equal(r.encrypted, false)
  assert.equal(r.json, plainError)
})

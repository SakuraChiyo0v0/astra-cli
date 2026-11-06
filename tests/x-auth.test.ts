/**
 * X 的 cookie 解析与脱敏。
 *
 * 这两种输入格式都是真实会出现的：整份导出的 cookies.txt（Netscape，tab 分隔），
 * 以及从开发者工具里手抄的 `auth_token=…; ct0=…`。解析错一个字段，
 * 现象是「明明登录了却全部 401/404」，所以这里钉死两个形状。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maskSecret, parseXCookie } from '../src/x/auth.ts'

test('Netscape cookies.txt：取 auth_token 与 ct0', () => {
  const raw = [
    '# Netscape HTTP Cookie File',
    '# https://curl.haxx.se/rfc/cookie_spec.html',
    '',
    '.x.com\tTRUE\t/\tTRUE\t1825477576\tauth_token\tc73484e061c22632e207d6fad07b5ffd1056bc74',
    '.x.com\tTRUE\t/\tTRUE\t1828155976\tct0\tb4a31dd5-abc',
    '.x.com\tTRUE\t/\tTRUE\t1825477579\ttwid\tu%3D1622874642594816001',
  ].join('\n')
  const parsed = parseXCookie(raw)
  assert.equal(parsed.authToken, 'c73484e061c22632e207d6fad07b5ffd1056bc74')
  assert.equal(parsed.ct0, 'b4a31dd5-abc')
})

test('k=v 串：分号/换行都当分隔', () => {
  const parsed = parseXCookie('auth_token=aaa; ct0=bbb\nguest_id=ccc')
  assert.deepEqual(parsed, { authToken: 'aaa', ct0: 'bbb' })
})

test('缺字段时报错，并把缺的名字说出来', () => {
  assert.throws(() => parseXCookie('guest_id=ccc'), /auth_token/)
  assert.throws(() => parseXCookie('auth_token=aaa'), /ct0/)
})

test('脱敏只留尾 4 位与长度', () => {
  const masked = maskSecret('0123456789abcdef')
  assert.equal(masked, '****cdef（16 位）')
  assert.ok(!masked.includes('0123456789ab'))
})

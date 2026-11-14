/**
 * 验证码抽取 + MIME 解码的固定向量。
 *
 * 这些样本都是真实邮件里出现过的形状（Steam 客服支援码、Apple/Google 验证码、
 * B 站 5 位码、带订单号的账单），改抽取规则时先跑这条。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { extractCode, oneLine } from '../src/mail/code.ts'
import { decodeQuotedPrintable, decodeWords, extractText, parseHeaders, readHeaders } from '../src/mail/mime.ts'
import { guessHost, maskSecret } from '../src/mail/store.ts'

test('mail: 6 位验证码', () => {
  assert.equal(extractCode('Apple', '您的 Apple ID 验证码为：\n382015\n请勿分享。'), '382015')
  assert.equal(extractCode('Microsoft 帐户', 'Security code: 481920\nDon\'t share it.'), '481920')
  assert.equal(extractCode('Gmail', 'Your Google verification code is\n772134'), '772134')
})

test('mail: 5 位验证码（B 站这类）', () => {
  assert.equal(extractCode('登录验证', '【Bilibili】验证码 61927。5分钟内有效'), '61927')
})

test('mail: 字母数字混合码（Steam 客服支援码）', () => {
  assert.equal(extractCode('【Steam】Steam 客服支援碼', '您的 Steam 客服支援碼為\nQ7XK9F\n'), 'Q7XK9F')
  assert.equal(extractCode('验证', '验证码：A1B2C3，10 分钟内有效'), 'A1B2C3')
})

test('mail: 订单号不会被当成验证码', () => {
  assert.equal(extractCode('账单', '订单号 2026111400123456 已发货'), '')
  assert.equal(extractCode('物流', '运单 7731122334455，预计明天送达'), '')
})

test('mail: 编码字解码', () => {
  assert.equal(decodeWords('=?UTF-8?B?6aqM6K+B56CB?='), '验证码')
  assert.equal(decodeWords('=?GBK?B?0enWpMLr?='), '验证码')
  assert.equal(decodeWords('Steam 客服支援碼'), 'Steam 客服支援碼')
})

test('mail: quoted-printable 解码', () => {
  assert.equal(decodeQuotedPrintable('=E9=AA=8C=E8=AF=81=E7=A0=81'), '验证码')
  assert.equal(decodeQuotedPrintable('abc=\r\ndef'), 'abcdef')
})

test('mail: 头部折行与大小写', () => {
  const headers = parseHeaders('Subject: hello\r\n world\r\nFrom: a@b.c\r\nX-Foo: 1')
  assert.equal(headers.subject, 'hello world')
  assert.equal(headers.from, 'a@b.c')
})

test('mail: multipart 优先取 text/plain', () => {
  const raw = Buffer.from(
    [
      'Content-Type: multipart/alternative; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '验证码 123456',
      '--B',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>验证码 <b>999999</b></p>',
      '--B--',
      '',
    ].join('\r\n'),
    'utf8',
  )
  assert.match(extractText(raw), /123456/)
  assert.doesNotMatch(extractText(raw), /999999/)
})

test('mail: base64 正文解码', () => {
  const body = Buffer.from('验证码 654321', 'utf8').toString('base64')
  const raw = Buffer.from(
    ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n'),
    'utf8',
  )
  assert.match(extractText(raw), /654321/)
  assert.equal(readHeaders(raw).subject, undefined)
})

test('mail: 摘要压成一行', () => {
  assert.equal(oneLine('a\n\n b\t c', 10), 'a b c')
})

test('mail: 授权码脱敏', () => {
  assert.equal(maskSecret('abcdefghijkl'), 'abcd…kl')
  assert.equal(maskSecret('short'), '***')
})

test('mail: 按域名认 IMAP 主机', () => {
  assert.equal(guessHost('123@qq.com'), 'imap.qq.com')
  assert.equal(guessHost('a@163.com'), 'imap.163.com')
  assert.equal(guessHost('a@gmail.com'), 'imap.gmail.com')
  assert.throws(() => guessHost('a@example.org'), /认不出/)
})

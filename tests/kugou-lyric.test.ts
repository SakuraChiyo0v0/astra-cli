/**
 * 酷狗逐字歌词。夹具是 2026-10-21 真实下载的 KRC（アイドル），不是手编的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { decodeKrc, parseKrc, toEnhancedLrc } from '../src/music/kugou-lyric.ts'

const raw = readFileSync(new URL('./fixtures/idol.krc', import.meta.url))
const text = readFileSync(new URL('./fixtures/idol.krc.txt', import.meta.url), 'utf8')

test('解密：krc1 + 16 字节循环 XOR + zlib', () => {
  const decoded = decodeKrc(Buffer.from(raw))
  assert.equal(decoded, text)
  assert.match(decoded, /^﻿?\[id:\$00000000\]/)
  assert.match(decoded, /\[total:213000\]/)
})

test('解密：错密钥解不开（防止退回"整体异或 0x64"的错误实现）', () => {
  // 正解能解
  assert.doesNotThrow(() => decodeKrc(Buffer.from(raw)))
  // 拿错密钥（全 0x64）必然 inflate 失败
  assert.throws(() => decodeKrc(Buffer.from(raw), [0x64]), /header|invalid|unexpected/i)
  // 换一个字节的密钥也不行
  const broken = Array(16).fill(0x40)
  assert.throws(() => decodeKrc(Buffer.from(raw), broken))
})

test('解析：行时间戳与逐字标签', () => {
  const krc = parseKrc(text)
  assert.ok(krc.lines.length > 50, `行数 ${krc.lines.length}`)
  // KRC 头部声明的总时长
  assert.equal(krc.durationMs, 213000)

  const first = krc.lines[0]!
  assert.equal(first.startMs, 31)
  assert.equal(first.durationMs, 182)
  assert.ok(first.words.length > 0, '第一行应有逐字')
  assert.equal(first.words.map((w) => w.text).join(''), first.text)
  // 逐字偏移是相对这一行的
  assert.equal(first.words[0]!.startMs, 0)
  assert.ok(first.words.every((w) => w.startMs >= 0 && w.startMs < first.durationMs + 2000))
})

test('增强 LRC：逐字标签在字前，时间 = 行起点 + 字偏移', () => {
  const krc = parseKrc(text)
  const lrc = toEnhancedLrc(krc)
  const lines = lrc.split('\n')
  assert.ok(lines.length > 50)
  // 第一行：31ms → 00:00.03
  assert.match(lines[0]!, /^\[00:00\.03\]<00:00\.03>/)
  for (const line of lines) {
    assert.match(line, /^\[\d{2}:\d{2}\.\d{2}\]/, line.slice(0, 20))
  }
})

test('解析：没有逐字的行也能收（纯文本行）', () => {
  const krc = parseKrc('[1000,2000]只有文字没有逐字标签\n[3000,500]a<0,100,0>b')
  assert.equal(krc.lines.length, 2)
  assert.equal(krc.lines[0]!.words.length, 0)
  assert.equal(krc.lines[0]!.text, '只有文字没有逐字标签')
  assert.equal(krc.lines[1]!.words.length, 2)
})

test('解析：空行与元信息不产生歌词行', () => {
  const krc = parseKrc('﻿[id:$0]\n[ar:X]\n[total:100000]\n\n[500,400]<0,200,0>你<200,200,0>好\n')
  assert.equal(krc.lines.length, 1)
  assert.equal(krc.lines[0]!.text, '你好')
  assert.equal(krc.durationMs, 100000)
})

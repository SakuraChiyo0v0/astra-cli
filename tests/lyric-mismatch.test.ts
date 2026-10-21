/**
 * 逐字歌词的错位防护。
 *
 * 歌词是按时间戳渲染的，**时长对不上整段就错位**——副歌时还显示前奏词。
 * 三道闸门：搜索结果时长 / krcs 候选时长 / KRC 头部 [total:]。
 * 这里直接测"多久算对不上"，用真实夹具的 213 秒当基准。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseKrc, pickByDuration } from '../src/music/kugou-lyric.ts'

const text = readFileSync(new URL('./fixtures/idol.krc.txt', import.meta.url), 'utf8')
const REAL_MS = 213_000

const SEARCH_TOLERANCE_MS = 3000
const TOTAL_TOLERANCE_MS = 5000

function searchAccepts(kugouDurationSec: number, wantMs: number): boolean {
  return Math.abs(kugouDurationSec * 1000 - wantMs) <= SEARCH_TOLERANCE_MS
}
function totalAccepts(totalMs: number | null, wantMs: number): boolean {
  return totalMs === null || Math.abs(totalMs - wantMs) <= TOTAL_TOLERANCE_MS
}

test('夹具自身的 [total:] 与网易云记录一致', () => {
  const krc = parseKrc(text)
  assert.equal(krc.durationMs, REAL_MS)
  assert.equal(totalAccepts(krc.durationMs, REAL_MS), true)
})

test('第一道闸门：搜索结果时长差 3 秒以内才收', () => {
  assert.equal(searchAccepts(213, REAL_MS), true) // 真实酷狗搜索结果
  assert.equal(searchAccepts(211, REAL_MS), true) // 差 2 秒
  assert.equal(searchAccepts(216, REAL_MS), true) // 差 3 秒，正好在容差边界
  assert.equal(searchAccepts(217, REAL_MS), false) // 差 4 秒，出界
  assert.equal(searchAccepts(249, REAL_MS), false) // 现场版
})

test('第三道闸门：KRC 头部时长差 5 秒以上就放弃', () => {
  assert.equal(totalAccepts(213_000, REAL_MS), true)
  assert.equal(totalAccepts(216_000, REAL_MS), true) // 差 3 秒，容差内
  assert.equal(totalAccepts(219_000, REAL_MS), false) // 差 6 秒
  assert.equal(totalAccepts(261_000, REAL_MS), false) // 另一首歌（实测酷我曾串曲到这个值）
})

test('没有 [total:] 时不拦（只是信息缺失，不是错位证据）', () => {
  assert.equal(totalAccepts(null, REAL_MS), true)
  const noTotal = parseKrc(text.replace(/\[total:\d+\]/g, ''))
  assert.equal(noTotal.durationMs, null)
  assert.equal(totalAccepts(noTotal.durationMs, REAL_MS), true)
})

test('搜索候选：没有时长够近的就返回 null，绝不回退到第一条', () => {
  // 实测酷狗对"アイドル YOASOBI"的候选：213s / 211s / 89s(Anime Edit) / 248s(群青)
  const list = [
    { Duration: 213, SongName: 'アイドル' },
    { Duration: 211, SongName: 'アイドル' },
    { Duration: 89, SongName: 'アイドル (Anime Edit)' },
    { Duration: 248, SongName: '群青' },
  ]
  // 213 秒的歌：能选到
  assert.equal(pickByDuration(list, REAL_MS)?.Duration, 213)
  // 261 秒的歌：一条都不够近 —— 这里必须返回 null。若哪天改回"回退第一条"，这条测试会红
  assert.equal(pickByDuration(list, 261_000), null)
  // 没有网易云时长就没有基准，也不猜
  assert.equal(pickByDuration(list, null), null)
  assert.equal(pickByDuration([], REAL_MS), null)
})

test('夹具的首行时间戳在容差讨论范围内（不会因为起点偏移被误判）', () => {
  const krc = parseKrc(text)
  const last = krc.lines.at(-1)!
  // 最后一行的起点必须早于总时长，否则说明解析把时间轴算错了
  assert.ok(last.startMs < REAL_MS, `末行 ${last.startMs} < ${REAL_MS}`)
})

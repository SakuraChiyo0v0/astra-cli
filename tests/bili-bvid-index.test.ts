/**
 * 目录内 bvid 索引（2026-10-27 东洋雪莲事故）。
 *
 * 真实事故：用户改过一次 `bili.audio-template`，`bili audio` 重跑时
 * 按「模板算出来的路径」判重全部落空，408 个文件里 200 个是同 bvid 重复
 * （49%），码率还退化了。bvid 写在标签里、跟文件名无关，按它认才稳。
 *
 * 这里锁三件事：① 标签里的 bvid 能读到 ② 只读头尾也能读到（不必整文件进内存）
 * ③ 文件名里的 `（BVxxx）` 兜底。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildBvidIndex } from '../src/bili/download.ts'

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-bvid-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 造一个假音频：头尾各塞一段垃圾，中间放标签明文。 */
function fakeAudio(dir: string, name: string, marker: string, middlePad = 0): string {
  const file = path.join(dir, name)
  const head = Buffer.alloc(2048, 0x11)
  const mid = Buffer.from(marker, 'latin1')
  const pad = Buffer.alloc(middlePad, 0x22)
  writeFileSync(file, Buffer.concat([head, mid, pad, Buffer.alloc(512, 0x33)]))
  return file
}

test('读到标签里的 bvid', () => {
  withDir((dir) => {
    const file = fakeAudio(dir, '打火机.mp3', 'TXXX\x00BILIBILI_BVID\x00BV1cb4wzxEjY')
    const index = buildBvidIndex(dir)
    assert.equal(index.get('BV1cb4wzxEjY'), file)
  })
})

test('只读头尾也能读到（中间大段数据被跳过）', () => {
  withDir((dir) => {
    // 标签埋在中段：前面 1MB、后面 1MB，头 512KB / 尾 128KB 窗口都够不到
    const far = path.join(dir, '远.mp3')
    writeFileSync(far, Buffer.concat([
      Buffer.alloc(1024 * 1024, 0x11),
      Buffer.from('SOURCE_ID=BV1ka4y1m73J', 'latin1'),
      Buffer.alloc(1024 * 1024, 0x22),
    ]))
    // 标签放在最前面 —— 应该读到
    const near = fakeAudio(dir, '近.mp3', 'SOURCE_ID=BV1EX4y167nh')
    const index = buildBvidIndex(dir)
    assert.equal(index.get('BV1EX4y167nh'), near)
    assert.equal(index.get('BV1ka4y1m73J'), undefined, '超出头尾窗口的标签读不到（可接受的代价）')
  })
})

test('文件名里的（BVxxx）兜底', () => {
  withDir((dir) => {
    const file = path.join(dir, '绿色DJ（BV1GEn26uEDT）.mp3')
    writeFileSync(file, Buffer.alloc(1024, 0x44))
    const index = buildBvidIndex(dir)
    assert.equal(index.get('BV1GEn26uEDT'), file)
  })
})

test('跳过非音频文件，递归子目录', () => {
  withDir((dir) => {
    writeFileSync(path.join(dir, '封面.jpg'), 'BILIBILI_BVID=BV1aaaaaaaaa')
    const sub = path.join(dir, '子目录')
    mkdirSync(sub)
    const nested = fakeAudio(sub, 'n.mp3', 'BILIBILI_BVID=BV1bbbbbbbbb')
    const index = buildBvidIndex(dir)
    assert.equal(index.get('BV1aaaaaaaaa'), undefined, 'jpg 不该进索引')
    assert.equal(index.get('BV1bbbbbbbbb'), nested)
  })
})

test('同一 bvid 多个文件时保留先扫到的', () => {
  withDir((dir) => {
    fakeAudio(dir, 'a.mp3', 'BILIBILI_BVID=BV1ccccccccc')
    fakeAudio(dir, 'b.mp3', 'BILIBILI_BVID=BV1ccccccccc')
    const index = buildBvidIndex(dir)
    assert.equal(index.size, 1)
    assert.ok(index.get('BV1ccccccccc'))
  })
})

test('目录不存在时返回空索引，不抛错', () => {
  const index = buildBvidIndex('/definitely/not/here')
  assert.equal(index.size, 0)
})

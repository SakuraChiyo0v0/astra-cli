/**
 * 漫画页完整性：截断不算下完，坏图不留在目录里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { imageIntact, saveVerifiedPage } from '../src/comic/pages.ts'
import { AstraError } from '../src/core/errors.ts'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function tinyPng(): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr[16] = 8
  ihdr[17] = 6
  const iend = Buffer.alloc(12)
  iend.writeUInt32BE(0, 0)
  iend.write('IEND', 4, 'ascii')
  return Buffer.concat([PNG_SIG, ihdr, iend])
}

test('截断的图不算完整，结构完整的算', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-comic-page-'))
  try {
    const bad = path.join(dir, '001.jpg')
    const good = path.join(dir, '002.jpg')
    writeFileSync(bad, tinyPng().subarray(0, 30))
    writeFileSync(good, tinyPng())
    assert.equal(await imageIntact(bad), false)
    assert.equal(await imageIntact(good), true)
    assert.equal(await imageIntact(path.join(dir, 'missing.jpg')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('第一次截断就删掉重写，第二次完整才留下', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-comic-retry-'))
  const target = path.join(dir, '001.jpg')
  let n = 0
  try {
    await saveVerifiedPage(target, async () => {
      n += 1
      await writeFile(target, n === 1 ? tinyPng().subarray(0, 30) : tinyPng())
    })
    assert.equal(n, 2)
    assert.equal(await imageIntact(target), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('两次都不完整：抛 TRUNCATED，目录里没有这张图', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-comic-drop-'))
  const target = path.join(dir, '001.jpg')
  try {
    await assert.rejects(
      () => saveVerifiedPage(target, async () => { await writeFile(target, tinyPng().subarray(0, 30)) }),
      (err: unknown) => err instanceof AstraError && err.code === 'TRUNCATED',
    )
    assert.equal(existsSync(target), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('真实截断夹具也过不了', async () => {
  const fixture = readFileSync(path.join(import.meta.dirname, 'fixtures', 'truncated.png'))
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-comic-fixture-'))
  const target = path.join(dir, '001.png')
  writeFileSync(target, fixture)
  try {
    assert.equal(await imageIntact(target), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

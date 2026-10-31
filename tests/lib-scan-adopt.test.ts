/**
 * `scan --adopt`：孤儿自动入库。
 *
 * 目的：外部工具（qb、gallery-dl、手工拷贝）写进来的文件，不用人再手动跑 adopt。
 * 默认关闭——`scan` 纯对账时不应该产生副作用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SqliteConn, sqliteDialect } from '../src/core/db/sqlite.ts'
import { migrate } from '../src/core/db/migrations.ts'
import { addRoot, adopt, scan, stats } from '../src/core/db/library.ts'
import type { Database } from '../src/core/db/index.ts'

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-scanadopt-'))
  const root = path.join(dir, 'lib')
  mkdirSync(root, { recursive: true })
  const db: Database = { conn: new SqliteConn(path.join(dir, 'astra.db')), dialect: sqliteDialect, url: 'sqlite:x' }
  return { db, root, close: async () => { await db.conn.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('默认不自动入库：孤儿只报告', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'lib', root)
    writeFileSync(path.join(root, 'a.jpg'), 'img-a')
    const r = await scan(db)
    assert.equal(r.orphanCount, 1)
    assert.equal(r.adopted, 0)
    assert.equal((await stats(db)).assets, 0)
  } finally {
    await close()
  }
})

test('--adopt 时孤儿直接入库，并记进 adopted', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'lib', root)
    writeFileSync(path.join(root, 'b.jpg'), 'img-b')
    writeFileSync(path.join(root, 'c.mp4'), 'video-c')
    const r = await scan(db, { adopt: true })
    assert.equal(r.adopted, 2)
    assert.equal(r.orphanCount, 0)
    assert.equal((await stats(db)).assets, 2)
    assert.ok(r.adoptedItems.length === 2)
  } finally {
    await close()
  }
})

test('已有记录的文件不会被重复认领', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'lib', root)
    writeFileSync(path.join(root, 'd.jpg'), 'img-d')
    await adopt(db, {})
    const r = await scan(db, { adopt: true })
    assert.equal(r.adopted, 0)
    assert.equal((await stats(db)).assets, 1)
  } finally {
    await close()
  }
})

test('非媒体文件（sidecar）不会被 --adopt 收进来', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'lib', root)
    writeFileSync(path.join(root, 'e.jpg'), 'img-e')
    writeFileSync(path.join(root, 'e.nfo'), '<movie></movie>')
    writeFileSync(path.join(root, 'e.ass'), '[Script Info]')
    const r = await scan(db, { adopt: true })
    assert.equal(r.adopted, 1)
    assert.equal((await stats(db)).assets, 1)
  } finally {
    await close()
  }
})

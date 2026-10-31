/**
 * 「只报新丢失」：已经 missing 的记录不该每次扫描都再报一遍。
 *
 * 2026-10-31 事故：28 个 flac 被删后，每 10 分钟的巡检都把同一批当「丢失」再报一次，
 * 群通知从早上刷到下午。丢失是**状态迁移**，不是每轮都要复述的事实。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SqliteConn, sqliteDialect } from '../src/core/db/sqlite.ts'
import { migrate } from '../src/core/db/migrations.ts'
import { addRoot, adopt, scan } from '../src/core/db/library.ts'
import type { Database } from '../src/core/db/index.ts'

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-missing-'))
  const root = path.join(dir, 'lib')
  mkdirSync(root, { recursive: true })
  const db: Database = { conn: new SqliteConn(path.join(dir, 'astra.db')), dialect: sqliteDialect, url: 'sqlite:x' }
  return { db, root, close: async () => { await db.conn.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('第一次丢失报一次，后续扫描不再重复报', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'lib', root)
    const p = path.join(root, 'a.flac')
    writeFileSync(p, 'audio-bytes')
    await adopt(db, {})
    await scan(db)

    unlinkSync(p)
    const first = await scan(db)
    assert.equal(first.missing.length, 1, '第一次丢失要报')

    const second = await scan(db)
    assert.equal(second.missing.length, 0, '已知丢失不该再报')
    const third = await scan(db)
    assert.equal(third.missing.length, 0)

    // 事件也只该有一条
    const ev = await db.conn.query<{ n: number | string }>("select count(*) as n from events where kind = 'missing'")
    assert.equal(Number(ev[0]!.n), 1)
  } finally {
    await close()
  }
})

test('丢失的文件回来后，再丢失会重新报一次', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'lib', root)
    const p = path.join(root, 'b.flac')
    writeFileSync(p, 'audio-bytes-2')
    await adopt(db, {})
    await scan(db)

    unlinkSync(p)
    assert.equal((await scan(db)).missing.length, 1)

    writeFileSync(p, 'audio-bytes-2')
    const back = await scan(db)
    assert.equal(back.missing.length, 0)
    assert.equal(back.moved.length, 1, '回来算 revived/moved')

    unlinkSync(p)
    const again = await scan(db)
    assert.equal(again.missing.length, 1, '重新丢失要重新报')
  } finally {
    await close()
  }
})

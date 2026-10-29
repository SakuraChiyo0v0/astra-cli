/**
 * `astra db query` —— 自定义 SQL。重点是**默认只读**：
 * 手滑跑一句 update 比跑不出结果严重得多。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dbCommands } from '../src/core/db/commands.ts'
import { SqliteConn, sqliteDialect } from '../src/core/db/sqlite.ts'
import { migrate } from '../src/core/db/migrations.ts'
import type { Database } from '../src/core/db/index.ts'

const query = dbCommands.find((c) => c.name === 'db query')!

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-query-'))
  const file = path.join(dir, 'astra.db')
  const db: Database = { conn: new SqliteConn(file), dialect: sqliteDialect, url: `sqlite:${file}` }
  return { db, file, dir }
}

async function run(sql: string, values: Record<string, unknown> = {}) {
  const result = await query.run({
    positionals: [sql],
    values: values as never,
    signal: AbortSignal.timeout(10_000),
  })
  return result
}

test('只读查询返回 columns / rowCount / rows', async () => {
  const { db, file, dir } = setup()
  process.env.ASTRA_DB_URL = `sqlite:${file}`
  try {
    await migrate(db)
    const r = await run('select 1 as a, 2 as b')
    const data = r.data as { columns: string[]; rowCount: number; rows: Record<string, unknown>[] }
    assert.deepEqual(data.columns, ['a', 'b'])
    assert.equal(data.rowCount, 1)
    assert.equal(data.rows[0]!.a, 1)
    assert.ok(r.table)
  } finally {
    await db.conn.close()
    delete process.env.ASTRA_DB_URL
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写语句默认被拒，带 --write 才执行', async () => {
  const { db, file, dir } = setup()
  process.env.ASTRA_DB_URL = `sqlite:${file}`
  try {
    await migrate(db)
    await assert.rejects(() => run('update assets set title = 1'), /--write/)
    const r = await run('update assets set title = 1', { write: true })
    assert.equal((r.data as { changes: number }).changes, 0)
  } finally {
    await db.conn.close()
    delete process.env.ASTRA_DB_URL
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没写 limit 时自动补，并在打满时标 truncated', async () => {
  const { db, file, dir } = setup()
  process.env.ASTRA_DB_URL = `sqlite:${file}`
  try {
    await migrate(db)
    await db.conn.exec(
      "insert into assets (id, platform, native_id, kind, title, created_at) values ('a','x','1','music','A','now'), ('b','x','2','music','B','now'), ('c','x','3','music','C','now')",
    )
    const r = await run('select id from assets', { limit: '2' })
    const data = r.data as { rowCount: number; truncated: boolean }
    assert.equal(data.rowCount, 2)
    assert.equal(data.truncated, true)

    const all = await run('select id from assets', { limit: '10' })
    assert.equal((all.data as { rowCount: number }).rowCount, 3)
    assert.equal((all.data as { truncated: boolean }).truncated, false)
  } finally {
    await db.conn.close()
    delete process.env.ASTRA_DB_URL
    rmSync(dir, { recursive: true, force: true })
  }
})

test('位置参数按顺序绑定', async () => {
  const { db, file, dir } = setup()
  process.env.ASTRA_DB_URL = `sqlite:${file}`
  try {
    await migrate(db)
    const r = await run('select ? as a, ? as b', { param: ['hello', '42'] })
    const row = (r.data as { rows: Record<string, unknown>[] }).rows[0]!
    assert.equal(row.a, 'hello')
    assert.equal(row.b, '42')
  } finally {
    await db.conn.close()
    delete process.env.ASTRA_DB_URL
    rmSync(dir, { recursive: true, force: true })
  }
})

test('注释开头的 select 也认得出是只读', async () => {
  const { db, file, dir } = setup()
  process.env.ASTRA_DB_URL = `sqlite:${file}`
  try {
    await migrate(db)
    const r = await run('-- 只是看看\nselect 1 as a')
    assert.equal((r.data as { rowCount: number }).rowCount, 1)
  } finally {
    await db.conn.close()
    delete process.env.ASTRA_DB_URL
    rmSync(dir, { recursive: true, force: true })
  }
})

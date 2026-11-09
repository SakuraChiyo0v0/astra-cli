import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteConn, sqliteDialect } from '../src/core/db/sqlite.ts'
import { migrate } from '../src/core/db/migrations.ts'
import type { Database } from '../src/core/db/index.ts'
import { syncArchive, toIso } from '../src/archive/sync.ts'
import { archiveCommands } from '../src/archive/commands.ts'

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-archive-'))
  const file = path.join(dir, 'astra.db')
  const state = path.join(dir, 'state.db')
  const docs = path.join(dir, 'docs')
  mkdirSync(docs)
  const db: Database = { conn: new SqliteConn(file), dialect: sqliteDialect, url: `sqlite:${file}` }
  const src = new DatabaseSync(state)
  src.exec(`
    create table sessions (
      id text primary key, title text, started_at real, last_activity_at real,
      message_count integer, model text, input_tokens integer, output_tokens integer,
      source text, chat_id text, chat_type text, archived integer
    );
    create table messages (
      id integer primary key, session_id text, role text, content text,
      tool_name text, tool_calls text, timestamp real, token_count integer
    );
  `)
  return { db, src, state, docs, dir }
}

test('秒级时间戳转成 ISO', async () => {
  assert.equal(toIso(1_700_000_000), '2023-11-14T22:13:20.000Z')
  assert.equal(toIso(null), null)
})

test('同步写入会话，第二次没变化就跳过', async () => {
  const { db, src, state, docs, dir } = setup()
  src.prepare(`insert into sessions (id, title, started_at, message_count, model, archived)
    values (?, ?, ?, ?, ?, ?)`).run('s1', 'ComfyUI 实战', 1_700_000_000, 1, 'test', 0)
  src.prepare(`insert into messages (id, session_id, role, content, timestamp) values (?, ?, ?, ?, ?)`)
    .run(1, 's1', 'user', '画一张插画', 1_700_000_001)
  src.prepare(`insert into sessions (id, title, started_at, message_count, archived) values (?, ?, ?, ?, ?)`)
    .run('s2', '打招呼', 1_700_000_000, 1, 0)
  src.prepare(`insert into messages (id, session_id, role, content, timestamp) values (?, ?, ?, ?, ?)`)
    .run(2, 's2', 'user', '今天画了 LoRA', 1_700_000_002)
  src.close()
  writeFileSync(path.join(docs, '清单.md'), 'lora')
  try {
    await migrate(db)
    const first = await syncArchive(db, { statePath: state, docsDir: docs })
    assert.equal(first.sessions, 2)
    assert.equal(first.written, 2)
    assert.equal(first.messages, 2)
    assert.equal(first.documents, 1)

    const second = await syncArchive(db, { statePath: state, docsDir: docs })
    assert.equal(second.written, 0)
    assert.equal(second.unchanged, 2)
    assert.equal(second.messages, 0)

    const rows = await db.conn.query<{ title: string }>('select title from hermes_sessions order by id')
    assert.deepEqual(rows.map((row) => row.title), ['ComfyUI 实战', '打招呼'])
  } finally {
    await db.conn.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没迁移就拒绝 sync', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-archive-cmd-'))
  const file = path.join(dir, 'astra.db')
  process.env.ASTRA_DB_URL = `sqlite:${file}`
  const cmd = archiveCommands.find((item) => item.name === 'archive sync')!
  try {
    await assert.rejects(
      () => cmd.run({ positionals: [], values: { state: path.join(dir, 'missing.db') }, signal: AbortSignal.timeout(5000) }),
      /会话存档表还没建好/,
    )
  } finally {
    delete process.env.ASTRA_DB_URL
    rmSync(dir, { recursive: true, force: true })
  }
})

test('老库记的是 0005_hermes_archive：只补记新 id，不重跑建表', async () => {
  const { db, src } = setup()
  src.close()
  try {
    await migrate(db)
    // 模拟线上：表早就由外部脚本建好，账也按旧 id 记过
    await db.conn.exec("delete from schema_migrations where id = 'astra_0006_hermes_archive'")
    await db.conn.exec(
      "insert into schema_migrations (id, dialect, checksum, applied_at) values ('0005_hermes_archive', 'sqlite', 'x', '2026-01-01T00:00:00.000Z')",
    )
    const again = await migrate(db)
    assert.deepEqual(again.applied, [], '不能重跑 DDL（表已存在，会报错）')
    assert.ok(again.skipped.includes('astra_0006_hermes_archive'), '应把新 id 补记进账')
    const rows = await db.conn.query<{ id: string }>("select id from schema_migrations where id like '%hermes_archive'")
    assert.deepEqual(rows.map((r) => r.id).sort(), ['0005_hermes_archive', 'astra_0006_hermes_archive'])
  } finally {
    await db.conn.close()
  }
})

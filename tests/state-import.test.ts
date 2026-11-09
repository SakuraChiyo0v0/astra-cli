/**
 * 0.58.0 状态表并库：老 astra.db → 当前库的一次性搬迁。
 *
 * 要守住的几件事：
 * - 七张表的行都过去，跑第二次不重复（幂等）
 * - 源被改名留底，不删
 * - 源里早期资产库的残留（assets 等）不搬，但要报出来
 * - 源停在阶梯中间（缺后来加的列）也能搬，缺的列走目标默认值
 * - SQLite 阶梯末态和 PG DDL 的列逐个对齐（两边漂了，PG 上就会少列 / 多列）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqliteConn, sqliteDialect } from '../src/core/db/sqlite.ts'
import type { Database } from '../src/core/db/index.ts'
import { importLegacyState } from '../src/core/db/import-state.ts'
import { JM_RENAME_LEVEL, POSTGRES_STATE, SQLITE_LADDER, STATE_TABLES, climbSqliteLadder } from '../src/core/db/state-schema.ts'

function legacyDb(dir: string, upTo = SQLITE_LADDER.length): string {
  const file = path.join(dir, 'astra.db')
  const src = new DatabaseSync(file)
  for (let i = 0; i < upTo; i += 1) src.exec(SQLITE_LADDER[i]!)
  src.exec(`pragma user_version = ${upTo}`)
  src.close()
  return file
}

function target(dir: string): Database {
  const file = path.join(dir, 'target.db')
  return { conn: new SqliteConn(file), dialect: sqliteDialect, url: `sqlite:${file}` }
}

test('七张表搬过去；跑第二次什么都不新插；源改名留底', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-import-'))
  const file = legacyDb(dir)
  const src = new DatabaseSync(file)
  src.exec(`insert into tracks (platform, native_id, title, artists, file_path, format, quality, created_at) values ('wy', '1', '晴天', '周杰伦', '/m/a.flac', 'flac', 'lossless', '2026-01-01')`)
  src.exec(`insert into jobs (id, kind, title, status, total, created_at, updated_at) values ('j1', 'album', '叶惠美', 'done', 1, '2026-01-01', '2026-01-01')`)
  src.exec(`insert into job_items (job_id, seq, native_id, title, artists, status, updated_at) values ('j1', 0, '1', '晴天', '周杰伦', 'downloaded', '2026-01-01')`)
  src.exec(`insert into subscriptions (id, kind, target_id, title, every_hours, created_at) values ('s1', 'playlist', '42', '红心', 24, '2026-01-01')`)
  src.exec(`insert into subscription_runs (subscription_id, ran_at, new_tracks) values ('s1', '2026-01-02', 3)`)
  src.exec(`insert into audit_log (at, action, summary, ok) values ('2026-01-01', 'music get', '晴天', 1)`)
  src.exec(`insert into schedules (name, command, interval_min, created_at) values ('daily', 'music subscribe run', 60, '2026-01-01')`)
  // 早期资产库残留：不该搬
  src.exec(`create table assets (id text primary key)`)
  src.exec(`insert into assets values ('a1'), ('a2')`)
  src.close()

  const db = target(dir)
  try {
    const first = await importLegacyState(db, { from: file, keepSource: true })
    for (const t of STATE_TABLES) {
      assert.equal(first.tables[t]!.source, 1, `${t} 源行数`)
      assert.equal(first.tables[t]!.inserted, 1, `${t} 新插行数`)
    }
    assert.deepEqual(first.leftBehind, { assets: 2 })
    assert.equal(first.renamedTo, null, '--keep-source 时源不改名')

    const second = await importLegacyState(db, { from: file })
    for (const t of STATE_TABLES) assert.equal(second.tables[t]!.inserted, 0, `${t} 第二次不该重复插`)
    assert.ok(second.renamedTo && existsSync(second.renamedTo), '源改名留底')
    assert.equal(existsSync(file), false)

    const tracks = await db.conn.query<{ title: string }>('select title from tracks')
    assert.deepEqual(tracks.map((r) => r.title), ['晴天'])
    // 早期资产库残留没混进来
    const assetTables = await db.conn.query<{ name: string }>("select name from sqlite_master where type = 'table' and name = 'assets'")
    assert.equal(assetTables.length, 0)
  } finally {
    await db.conn.close()
  }
})

test('源停在阶梯中间（缺后加的列）也能搬，缺的列用默认值', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-import-old-'))
  // 停在一个很早的版本：subscriptions 还没有 options 等列
  const early = SQLITE_LADDER.findIndex((stmt) => /create table (if not exists )?subscriptions\b/i.test(stmt)) + 1
  assert.ok(early > 0)
  const file = legacyDb(dir, early)
  const src = new DatabaseSync(file)
  const cols = (src.prepare('pragma table_info(subscriptions)').all() as { name: string }[]).map((c) => c.name)
  assert.equal(cols.includes('options'), false, '前提：老库确实缺 options 列')
  src.exec(`insert into subscriptions (id, kind, target_id, title, every_hours, created_at) values ('s1', 'playlist', '42', '红心', 24, '2026-01-01')`)
  src.close()

  const db = target(dir)
  try {
    const r = await importLegacyState(db, { from: file, keepSource: true })
    assert.equal(r.tables.subscriptions!.inserted, 1)
    const rows = await db.conn.query<{ options: string | null; enabled: number }>('select options, enabled from subscriptions')
    assert.equal(rows[0]!.options, null)
    assert.equal(Number(rows[0]!.enabled), 1)
  } finally {
    await db.conn.close()
  }
})

test('源停在 0.57 改名之前：JM 订阅 / 任务搬过来时补上 comic → jm，manga → comic', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-import-jm-'))
  // 生产上的老库就停在这一级：0.55 及以前没有 jm 改名那三条
  const file = legacyDb(dir, JM_RENAME_LEVEL)
  const src = new DatabaseSync(file)
  src.exec(`insert into subscriptions (id, kind, target_id, title, every_hours, created_at) values ('s1', 'comic-album', '9', '本子', 24, '2026-01-01'), ('s2', 'playlist', '42', '红心', 24, '2026-01-01')`)
  src.exec(`insert into jobs (id, kind, title, status, total, created_at, updated_at, meta) values
    ('j1', 'album', '本子', 'done', 1, '2026-01-01', '2026-01-01', '{"domain":"comic","albumId":"9"}'),
    ('j2', 'album', '普通漫画', 'done', 1, '2026-01-01', '2026-01-01', '{"domain":"manga"}'),
    ('j3', 'album', '歌', 'done', 1, '2026-01-01', '2026-01-01', '{"domain":"music"}')`)
  src.close()

  const db = target(dir)
  try {
    // 目标库里新版本自己写的 comic 任务（普通漫画）不能被当成 JM 改掉
    await climbSqliteLadder(db.conn)
    await db.conn.exec(`insert into jobs (id, kind, title, status, total, created_at, updated_at, meta) values ('new1', 'album', '新漫画', 'done', 1, '2026-02-01', '2026-02-01', '{"domain":"comic"}')`)
    await importLegacyState(db, { from: file, keepSource: true })
    const subs = await db.conn.query<{ id: string; kind: string }>('select id, kind from subscriptions order by id')
    assert.deepEqual(subs.map((r) => ({ ...r })), [{ id: 's1', kind: 'jm-album' }, { id: 's2', kind: 'playlist' }])
    const jobs = await db.conn.query<{ id: string; d: string }>("select id, json_extract(meta, '$.domain') d from jobs order by id")
    assert.deepEqual(jobs.map((r) => ({ ...r })), [{ id: 'j1', d: 'jm' }, { id: 'j2', d: 'comic' }, { id: 'j3', d: 'music' }, { id: 'new1', d: 'comic' }])
  } finally {
    await db.conn.close()
  }
})

test('阶梯级数和 0.57.0 的 core/db.ts 对齐：线上 0.57 老库 user_version=42 时不再重跑', async () => {
  // 0.57.0 的阶梯共 42 级，JM 改名是最后一级（三条语句一级）。拆开过一次，级数变成 44，
  // 线上 user_version=42 的库就会被当成「还差两级」、把改名重跑一遍
  assert.equal(SQLITE_LADDER.length, 42)
  assert.equal(JM_RENAME_LEVEL, 41)
})

test('当前库就是源文件时拒绝（本机 SQLite，本来就是同一个库）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-import-same-'))
  const file = legacyDb(dir)
  const db: Database = { conn: new SqliteConn(file), dialect: sqliteDialect, url: `sqlite:${file}` }
  try {
    await assert.rejects(importLegacyState(db, { from: file }), /不需要搬/)
  } finally {
    await db.conn.close()
  }
})

test('dry-run 只统计、不写、不改名', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-import-dry-'))
  const file = legacyDb(dir)
  const src = new DatabaseSync(file)
  src.exec(`insert into jobs (id, kind, title, status, total, created_at, updated_at) values ('j1', 'album', 'x', 'done', 1, '2026-01-01', '2026-01-01')`)
  src.close()
  const db = target(dir)
  try {
    const r = await importLegacyState(db, { from: file, dryRun: true })
    assert.equal(r.tables.jobs!.source, 1)
    assert.equal(r.tables.jobs!.inserted, 0)
    assert.equal(r.renamedTo, null)
    assert.ok(existsSync(file))
    assert.equal((await db.conn.query('select * from jobs')).length, 0)
  } finally {
    await db.conn.close()
  }
})

/** 从 `create table` 语句里抠列名（忽略约束行）。 */
function columnsFromDdl(ddl: string): string[] {
  const body = ddl.slice(ddl.indexOf('(') + 1, ddl.lastIndexOf(')'))
  return body.split(',\n').map((l) => l.trim().split(/\s+/)[0]!).filter((name) => name && !/^(primary|unique|foreign|constraint|check)$/i.test(name))
}

test('SQLite 阶梯末态与 PG DDL 的列逐个一致', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-ladder-'))
  const file = path.join(dir, 'x.db')
  const conn = new SqliteConn(file)
  try {
    await climbSqliteLadder(conn)
    for (const table of STATE_TABLES) {
      const sqlite = (await conn.query<{ name: string }>(`pragma table_info("${table}")`)).map((c) => c.name).sort()
      const ddl = POSTGRES_STATE.find((s) => new RegExp(`create table if not exists ${table} \\(`).test(s))
      assert.ok(ddl, `PG 里缺 ${table}`)
      assert.deepEqual(columnsFromDdl(ddl!).sort(), sqlite, `${table} 两边列不一致`)
    }
  } finally {
    await conn.close()
  }
  // 顺带：阶梯是幂等的（user_version 记着，第二次什么都不做）
  const again = new SqliteConn(file)
  try {
    await climbSqliteLadder(again)
  } finally {
    await again.close()
  }
  assert.ok(readdirSync(dir).includes('x.db'))
})

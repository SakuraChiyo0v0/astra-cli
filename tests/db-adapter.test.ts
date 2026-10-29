/**
 * 数据库适配层：占位符转换、方言识别、SQLite 迁移与备份、逻辑导出导入。
 *
 * 这里只测 SQLite 和纯函数；PG 的实机验证在容器里跑（需要真实实例），
 * 单测不依赖外部服务，否则 CI 跑不动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dialectOf, sqlitePath, toDollarPlaceholders } from '../src/core/db/adapter.ts'
import { SqliteConn } from '../src/core/db/sqlite.ts'
import { migrate, appliedMigrations } from '../src/core/db/migrations.ts'
import { backupDatabase, doctor, exportJson, importJson } from '../src/core/db/backup.ts'
import type { Database } from '../src/core/db/index.ts'
import { sqliteDialect } from '../src/core/db/sqlite.ts'

function tmpDb(): { db: Database; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-db-'))
  const file = path.join(dir, 'astra.db')
  return { db: { conn: new SqliteConn(file), dialect: sqliteDialect, url: `sqlite:${file}` }, file }
}

test('? 占位符转成 $n，但跳过字符串、标识符和注释', () => {
  assert.equal(toDollarPlaceholders('select * from t where a = ? and b = ?'), 'select * from t where a = $1 and b = $2')
  // 字符串字面量里的问号不能被改
  assert.equal(
    toDollarPlaceholders("select * from t where title like '%?%' and id = ?"),
    "select * from t where title like '%?%' and id = $1",
  )
  // 单引号转义 ''
  assert.equal(toDollarPlaceholders("select 'it''s ?' , ?"), "select 'it''s ?' , $1")
  // 双引号标识符
  assert.equal(toDollarPlaceholders('select "we?ird" from t where x = ?'), 'select "we?ird" from t where x = $1')
  // 行注释
  assert.equal(toDollarPlaceholders('select 1 -- why? ?\n from t where a = ?'), 'select 1 -- why? ?\n from t where a = $1')
  // 块注释
  assert.equal(toDollarPlaceholders('select /* ? */ ?'), 'select /* ? */ $1')
})

test('连接串识别方言，不认识的直接报错而不是静默回落', () => {
  assert.equal(dialectOf(undefined), 'sqlite')
  assert.equal(dialectOf(''), 'sqlite')
  assert.equal(dialectOf('postgres://u:p@h:5432/db'), 'postgres')
  assert.equal(dialectOf('postgresql://u:p@h/db'), 'postgres')
  assert.equal(dialectOf('mysql://u:p@h/db'), 'mysql')
  assert.equal(dialectOf('sqlite:/tmp/a.db'), 'sqlite')
  assert.equal(dialectOf('/tmp/a.db'), 'sqlite')
  assert.throws(() => dialectOf('mongodb://h/db'), /无法识别的数据库连接串/)
})

test('sqlite: 前缀剥离', () => {
  assert.equal(sqlitePath('sqlite:/tmp/a.db'), '/tmp/a.db')
  assert.equal(sqlitePath('sqlite:///tmp/a.db'), '/tmp/a.db')
  assert.equal(sqlitePath('file:/tmp/a.db'), '/tmp/a.db')
  assert.equal(sqlitePath('/tmp/a.db'), '/tmp/a.db')
})

test('迁移建表、可重复执行、状态可查', async () => {
  const { db } = tmpDb()
  try {
    const first = await migrate(db)
    assert.deepEqual(first.applied, ['0001_assets_files', '0002_backfill_tracks', '0003_clear_untrusted_sha256'])
    assert.equal(first.current, first.total)

    // 再跑一次：不重复应用
    const second = await migrate(db)
    assert.deepEqual(second.applied, [])
    assert.equal(second.skipped.length, 3)

    const applied = await appliedMigrations(db)
    assert.equal(applied.length, 3)
    assert.match(applied[0]!.checksum, /^[0-9a-f]{16}$/)
  } finally {
    await db.conn.close()
  }
})

test('SQLite 备份产出可用的库文件', async () => {
  const { db, file } = tmpDb()
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-dbbk-'))
  try {
    await migrate(db)
    const result = await backupDatabase(db, { dir })
    assert.ok(result.bytes > 0)
    assert.ok(existsSync(result.file))
    // 备份文件本身应该是个能打开的 SQLite（头部是 "SQLite format 3"）
    const head = readFileSync(result.file).subarray(0, 15).toString('latin1')
    assert.equal(head, 'SQLite format 3')
    assert.equal(result.dialect, 'sqlite')
  } finally {
    await db.conn.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(path.dirname(file), { recursive: true, force: true })
  }
})

test('逻辑导出 → 导入到另一个库，数据一致', async () => {
  const a = tmpDb()
  const b = tmpDb()
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'astra-exp-')), 'exp.json')
  try {
    await migrate(a.db)
    const now = new Date().toISOString()
    await a.db.conn.exec('insert into roots (id,label,abs_path,created_at) values (?,?,?,?)', ['r1', 'nas', '/volume1', now])
    await a.db.conn.exec('insert into assets (id,platform,native_id,kind,title,created_at) values (?,?,?,?,?,?)', ['a1', 'netease', '1', 'music', '歌', now])
    await a.db.conn.exec(
      'insert into files (id,asset_id,root_id,rel_path,size,hash,state,first_seen,last_seen) values (?,?,?,?,?,?,?,?,?)',
      ['f1', 'a1', 'r1', '流媒体/歌.flac', 100, 'h1', 'present', now, now],
    )

    const payload = await exportJson(a.db, out)
    assert.equal(payload.tables.assets?.length, 1)

    await migrate(b.db)
    const result = await importJson(b.db, out)
    assert.equal(result.inserted.assets, 1)
    const rows = await b.db.conn.query<{ rel_path: string }>('select rel_path from files')
    assert.equal(rows[0]?.rel_path, '流媒体/歌.flac')
  } finally {
    await a.db.conn.close()
    await b.db.conn.close()
    rmSync(path.dirname(out), { recursive: true, force: true })
  }
})

test('doctor 能查出孤儿文件（asset 不存在）', async () => {
  const { db, file } = tmpDb()
  try {
    await migrate(db)
    const now = new Date().toISOString()
    await db.conn.exec('insert into roots (id,label,abs_path,created_at) values (?,?,?,?)', ['r1', 'nas', '/v1', now])
    await db.conn.exec(
      'insert into files (id,asset_id,root_id,rel_path,state,first_seen,last_seen) values (?,?,?,?,?,?,?)',
      ['f1', 'ghost', 'r1', 'x.flac', 'present', now, now],
    )
    const report = await doctor(db)
    assert.equal(report.orphanFiles, 1)
    assert.equal(report.ping, true)
    assert.equal(report.tables.files, 1)
  } finally {
    await db.conn.close()
    rmSync(path.dirname(file), { recursive: true, force: true })
  }
})

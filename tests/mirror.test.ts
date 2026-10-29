/**
 * 影子写入：bili / pixiv / music 落盘后同步进资产库。
 *
 * 守两件事：
 * - 找不到匹配的 root 时不写（返回 false），不报错
 * - 资产库没迁移/不可写时也不报错（下载不能被资产库拖死）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SqliteConn, sqliteDialect } from '../src/core/db/sqlite.ts'
import { migrate } from '../src/core/db/migrations.ts'
import { addRoot, listRoots, whereAsset } from '../src/core/db/library.ts'
import { mirrorFile } from '../src/core/db/mirror.ts'
import type { Database } from '../src/core/db/index.ts'

test('mirrorFile 把文件登记成 asset + file（按 root 前缀算相对路径）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-mirror-'))
  const dbFile = path.join(dir, 'astra.db')
  const root = path.join(dir, 'bili')
  const file = path.join(root, 'up', '标题', '01 正片.mp4')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, 'video-bytes')

  const db: Database = { conn: new SqliteConn(dbFile), dialect: sqliteDialect, url: `sqlite:${dbFile}` }
  process.env.ASTRA_DB_URL = `sqlite:${dbFile}`
  try {
    await migrate(db)
    await addRoot(db, 'bili', root)

    const ok = await mirrorFile({
      platform: 'bili',
      nativeId: 'BV1xx411c7mD_p1',
      kind: 'video',
      title: '正片',
      artists: '某个UP',
      meta: { bvid: 'BV1xx411c7mD', page: 1 },
      path: file,
    })
    assert.equal(ok, true)

    const files = await whereAsset(db, 'bili:BV1xx411c7mD_p1')
    assert.equal(files.length, 1)
    assert.equal(files[0]!.rel_path, path.join('up', '标题', '01 正片.mp4'))
    assert.equal(files[0]!.size, 'video-bytes'.length)
    assert.equal(files[0]!.state, 'present')
  } finally {
    await db.conn.close()
    delete process.env.ASTRA_DB_URL
    rmSync(dir, { recursive: true, force: true })
  }
})

test('路径不在任何 root 里时返回 false，不抛错', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-mirror2-'))
  const dbFile = path.join(dir, 'astra.db')
  const db: Database = { conn: new SqliteConn(dbFile), dialect: sqliteDialect, url: `sqlite:${dbFile}` }
  process.env.ASTRA_DB_URL = `sqlite:${dbFile}`
  try {
    await migrate(db)
    await addRoot(db, 'music', path.join(dir, 'music'))
    const outside = path.join(dir, 'elsewhere', 'x.flac')
    mkdirSync(path.dirname(outside), { recursive: true })
    writeFileSync(outside, 'x')

    const ok = await mirrorFile({
      platform: 'test', nativeId: 'nope', kind: 'music', title: 'x', path: outside,
    })
    assert.equal(ok, false)
    const roots = await listRoots(db)
    assert.equal(roots.length, 1)
  } finally {
    await db.conn.close()
    delete process.env.ASTRA_DB_URL
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * lib verify（抽样校验）与 lib dupes（重复内容报告）。
 *
 * verify 守的是「同大小文件被替换」这个 scan 发现不了的情况；
 * dupes 只报告不删 —— 删前先看清单是既定规矩。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { SqliteConn, sqliteDialect } from '../src/core/db/sqlite.ts'
import { migrate } from '../src/core/db/migrations.ts'
import {
  addRoot, fileSha256, findDupes, recordDownload, scan, verify,
} from '../src/core/db/library.ts'
import type { Database } from '../src/core/db/index.ts'

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-verify-'))
  const file = path.join(dir, 'astra.db')
  const root = path.join(dir, 'media')
  mkdirSync(root, { recursive: true })
  const db: Database = { conn: new SqliteConn(file), dialect: sqliteDialect, url: `sqlite:${file}` }
  return { db, root, dir, close: async () => { await db.conn.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('verify 给没有 sha256 的文件补上指纹', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'test', root)
    writeFileSync(path.join(root, 'a.flac'), 'hello-world')
    await recordDownload(db, { platform: 't', nativeId: '1', title: 'a', kind: 'music' },
      { rootId: (await addRoot(db, 'test', root)).id, relPath: 'a.flac', size: 11 })

    const r = await verify(db)
    assert.equal(r.checked, 1)
    assert.equal(r.filled, 1)
    assert.equal(r.mismatched.length, 0)

    const rows = await db.conn.query<{ sha256: string }>('select sha256 from files')
    assert.equal(rows[0]!.sha256, createHash('sha256').update('hello-world').digest('hex'))
  } finally {
    await close()
  }
})

test('verify 发现内容被替换（同大小也算）', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    const r0 = await addRoot(db, 'test', root)
    writeFileSync(path.join(root, 'a.flac'), 'AAAAAAAAAA')
    await recordDownload(db, { platform: 't', nativeId: '1', title: 'a', kind: 'music' },
      { rootId: r0.id, relPath: 'a.flac', size: 10, sha256: createHash('sha256').update('AAAAAAAAAA').digest('hex') })

    // 同长度、不同内容
    writeFileSync(path.join(root, 'a.flac'), 'BBBBBBBBBB')

    const r = await verify(db)
    assert.equal(r.checked, 1)
    assert.equal(r.mismatched.length, 1)
    assert.equal(r.mismatched[0]!.relPath, 'a.flac')
  } finally {
    await close()
  }
})

test('dupes 按内容分组列出多副本，且不动文件', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    const r0 = await addRoot(db, 'test', root)
    const body = 'same-content'
    const sha = createHash('sha256').update(body).digest('hex')
    mkdirSync(path.join(root, 'a'), { recursive: true })
    mkdirSync(path.join(root, 'b'), { recursive: true })
    writeFileSync(path.join(root, 'a/x.flac'), body)
    writeFileSync(path.join(root, 'b/x-copy.flac'), body)

    await recordDownload(db, { platform: 't', nativeId: '1', title: 'x', kind: 'music' },
      { rootId: r0.id, relPath: 'a/x.flac', size: body.length, sha256: sha })
    await recordDownload(db, { platform: 't', nativeId: '2', title: 'x2', kind: 'music' },
      { rootId: r0.id, relPath: 'b/x-copy.flac', size: body.length, sha256: sha })

    const groups = await findDupes(db)
    assert.equal(groups.length, 1)
    assert.equal(groups[0]!.count, 2)
    assert.deepEqual(groups[0]!.files.map((f) => f.relPath).sort(), ['a/x.flac', 'b/x-copy.flac'])

    // 只报告：两个文件都还在
    const r = await verify(db)
    assert.equal(r.checked, 2)
    assert.equal(r.matched, 2)
  } finally {
    await close()
  }
})

test('fileSha256 对空文件也能给出稳定值', async () => {
  const { root, dir } = setup()
  try {
    const p = path.join(root, 'empty.flac')
    writeFileSync(p, '')
    assert.equal(await fileSha256(p), createHash('sha256').update('').digest('hex'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

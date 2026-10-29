/**
 * `lib find` 要能搜路径：认领来的文件标题常常只是 `01`、`138993133_p0`，
 * 只搜 assets 会一个都搜不到。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SqliteConn, sqliteDialect } from '../src/core/db/sqlite.ts'
import { migrate } from '../src/core/db/migrations.ts'
import { addRoot, adopt, findAssets, scan } from '../src/core/db/library.ts'
import type { Database } from '../src/core/db/index.ts'

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-find-'))
  const file = path.join(dir, 'astra.db')
  const root = path.join(dir, '本子')
  mkdirSync(path.join(root, '44935801'), { recursive: true })
  const db: Database = { conn: new SqliteConn(file), dialect: sqliteDialect, url: `sqlite:${file}` }
  return { db, root, dir, close: async () => { await db.conn.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('按路径能搜到标题只有文件名的资产', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'comic', root)
    writeFileSync(path.join(root, '44935801', '138993133_p0.jpg'), 'img-a')
    writeFileSync(path.join(root, '44935801', '138993134_p0.jpg'), 'img-b')
    await adopt(db, { kinds: ['image'] })

    const hit = await findAssets(db, '44935801')
    assert.equal(hit.length, 2)
    assert.equal(hit[0]!.rel_path, '44935801/138993133_p0.jpg')

    const byName = await findAssets(db, '138993133')
    assert.equal(byName.length, 1)
    assert.equal(byName[0]!.title, '138993133_p0')
  } finally {
    await close()
  }
})

test('搜标题仍然有效，结果带位置', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'comic', root)
    const mp4 = path.join(root, '44935801', 'x.mp4')
    writeFileSync(mp4, 'video-bytes')
    writeFileSync(mp4.replace(/\.mp4$/, '.nfo'),
      '<movie><title>了不起的盖茨比</title><actor><name>食贫道</name></actor><uniqueid>BV1duQGBxEp9</uniqueid></movie>')
    await adopt(db, {})

    const hit = await findAssets(db, '盖茨比')
    assert.equal(hit.length, 1)
    assert.equal(hit[0]!.artists, '食贫道')
    assert.equal(hit[0]!.rel_path, '44935801/x.mp4')
  } finally {
    await close()
  }
})

test('同一资产有多个位置时只返回一条（优先 present）', async () => {
  const { db, root, dir, close } = setup()
  try {
    await migrate(db)
    const other = path.join(dir, '本子2')
    mkdirSync(other, { recursive: true })
    await addRoot(db, 'comic', root)
    await addRoot(db, 'comic2', other)
    writeFileSync(path.join(root, 'a.jpg'), 'same-bytes')
    writeFileSync(path.join(other, 'b.jpg'), 'same-bytes')
    await adopt(db, { roots: ['comic'], kinds: ['image'] })
    await adopt(db, { roots: ['comic2'], kinds: ['image'] })

    const hit = await findAssets(db, 'a.jpg')
    assert.equal(hit.length, 1, '一个资产只出现一次，不因多副本变成两行')
  } finally {
    await close()
  }
})

test('没命中的关键词返回空数组而不是报错', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'comic', root)
    writeFileSync(path.join(root, 'a.jpg'), 'x')
    await adopt(db, { kinds: ['image'] })
    await scan(db)
    assert.deepEqual(await findAssets(db, '不存在的关键词'), [])
  } finally {
    await close()
  }
})

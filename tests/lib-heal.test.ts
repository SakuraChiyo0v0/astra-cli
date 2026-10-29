/**
 * 墓碑与读时自愈：
 * - 文件消失 → 留 missing 记录（墓碑），不删
 * - 文件回来（同 root 换名 / 跨 root 搬家）→ 指纹对上就认回，事件记 revived
 * - 查询时 lstat，结果永远不说谎
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SqliteConn, sqliteDialect } from '../src/core/db/sqlite.ts'
import { migrate } from '../src/core/db/migrations.ts'
import { addRoot, adopt, scan, whereAsset } from '../src/core/db/library.ts'
import type { Database } from '../src/core/db/index.ts'

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-heal-'))
  const file = path.join(dir, 'astra.db')
  const rootA = path.join(dir, 'A')
  const rootB = path.join(dir, 'B')
  mkdirSync(rootA, { recursive: true })
  mkdirSync(rootB, { recursive: true })
  const db: Database = { conn: new SqliteConn(file), dialect: sqliteDialect, url: `sqlite:${file}` }
  return {
    db, rootA, rootB, dir,
    close: async () => { await db.conn.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test('文件删掉后留墓碑，换个名字放回来能认回（revived）', async () => {
  const { db, rootA, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'A', rootA)
    const p = path.join(rootA, 'song.mp4')
    writeFileSync(p, 'content-x')
    await adopt(db, {})
    await scan(db)

    unlinkSync(p)
    const gone = await scan(db)
    assert.equal(gone.missing.length, 1)
    const afterDelete = await db.conn.query<{ state: string; n: number | string }>(
      "select state, count(*) as n from files group by state",
    )
    assert.equal(afterDelete[0]!.state, 'missing', '记录还在，只是标了 missing')

    // 换名字、同内容放回来
    writeFileSync(path.join(rootA, 'song-renamed.mp4'), 'content-x')
    const back = await scan(db)
    assert.equal(back.missing.length, 0)
    assert.equal(back.moved.length, 1)

    const rows = await db.conn.query<{ state: string }>('select state from files')
    assert.equal(rows.length, 1, '还是一行，没有多出第二条')
    assert.equal(rows[0]!.state, 'present')

    const kinds = await db.conn.query<{ kind: string }>("select kind from events where kind = 'revived'")
    assert.equal(kinds.length, 1)
  } finally {
    await close()
  }
})

test('跨 root 搬家：B 里的孤儿能复活 A 里的墓碑，root_id 跟着改', async () => {
  const { db, rootA, rootB, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'A', rootA)
    await addRoot(db, 'B', rootB)
    const p = path.join(rootA, 'pic.jpg')
    writeFileSync(p, 'image-bytes')
    await adopt(db, { roots: ['A'], kinds: ['image'] })
    await scan(db, { roots: ['A'] })

    renameSync(p, path.join(rootB, 'pic-moved.jpg'))
    await scan(db, { roots: ['A'] })   // A 里标 missing
    const r = await scan(db, { roots: ['B'] })  // B 里认回

    assert.equal(r.moved.length, 1, '跨 root 也算认回')
    const rows = await db.conn.query<{ rel_path: string; state: string; label: string }>(
      `select f.rel_path, f.state, r.label from files f join roots r on r.id = f.root_id`,
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.state, 'present')
    assert.equal(rows[0]!.rel_path, 'pic-moved.jpg')
    assert.equal(rows[0]!.label, 'B', 'root_id 必须跟着改，否则路径拼不出来')
  } finally {
    await close()
  }
})

test('读时自愈：文件没了，where 立刻标 missing（不等巡检）', async () => {
  const { db, rootA, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'A', rootA)
    const p = path.join(rootA, 'a.mp4')
    writeFileSync(p, 'content-y')
    await adopt(db, {})
    await scan(db)

    const id = (await db.conn.query<{ asset_id: string }>('select asset_id from files'))[0]!.asset_id
    unlinkSync(p)

    const rows = await whereAsset(db, id, { repair: true })
    assert.equal(rows[0]!.state, 'missing')

    const ev = await db.conn.query<{ detail: string }>("select detail from events where kind = 'missing'")
    assert.ok(ev.some((e) => String(e.detail).includes('read-repair')))
  } finally {
    await close()
  }
})

test('读时自愈：文件回来了，where 把状态修回 present', async () => {
  const { db, rootA, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'A', rootA)
    const p = path.join(rootA, 'b.mp4')
    writeFileSync(p, 'content-z')
    await adopt(db, {})
    await scan(db)
    const id = (await db.conn.query<{ asset_id: string }>('select asset_id from files'))[0]!.asset_id

    unlinkSync(p)
    await scan(db)   // 标 missing
    writeFileSync(p, 'content-z')  // 原路径放回

    const rows = await whereAsset(db, id, { repair: true })
    assert.equal(rows[0]!.state, 'present')
  } finally {
    await close()
  }
})

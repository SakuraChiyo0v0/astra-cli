/**
 * 身份线索：inode 零拷贝移动识别 + size/mtime 未变则跳过读内容。
 *
 * 这两条都是抄来的作业（Filebeat 的 native 身份、restic 的元数据判据），
 * 但要盯住它们各自的失效边界：
 * - inode 在跨文件系统移动后会变 → 走指纹兜底
 * - mtime 没变但内容变了 → 检测不到（已知缺陷，靠 verify 抽样兜底）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SqliteConn, sqliteDialect } from '../src/core/db/sqlite.ts'
import { migrate } from '../src/core/db/migrations.ts'
import { addRoot, adopt, scan } from '../src/core/db/library.ts'
import type { Database } from '../src/core/db/index.ts'

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-ident-'))
  const file = path.join(dir, 'astra.db')
  const root = path.join(dir, 'lib')
  mkdirSync(path.join(root, 'a'), { recursive: true })
  mkdirSync(path.join(root, 'b'), { recursive: true })
  const db: Database = { conn: new SqliteConn(file), dialect: sqliteDialect, url: `sqlite:${file}` }
  return {
    db, root, dir,
    close: async () => { await db.conn.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test('同盘 rename：靠 inode 认回，事件标记 via=inode', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'lib', root)
    const from = path.join(root, 'a', 'x.mp4')
    writeFileSync(from, 'video-content-1')
    await adopt(db, {})
    await scan(db)  // 第一次扫描把 dev/ino/mtime 补齐

    const to = path.join(root, 'b', 'y.mp4')
    renameSync(from, to)
    const r = await scan(db)

    assert.equal(r.moved.length, 1)
    assert.equal(r.moved[0]!.to, 'b/y.mp4')
    assert.equal(r.missing.length, 0)

    const rows = await db.conn.query<{ via: string | null }>(
      "select detail as via from events where kind = 'moved' order by at desc limit 1",
    )
    assert.ok(rows.length > 0)
    assert.match(String(rows[0]!.via), /inode/)
  } finally {
    await close()
  }
})

test('第一次扫描把 dev/ino/mtime 写进 files', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'lib', root)
    writeFileSync(path.join(root, 'a', 'z.mp4'), 'video-content-2')
    await adopt(db, {})
    await scan(db)

    const rows = await db.conn.query<{ dev: string | null; ino: string | null; mtime_ms: number | null }>(
      'select dev, ino, mtime_ms from files',
    )
    assert.ok(rows[0]!.dev, 'dev 应该有值')
    assert.ok(rows[0]!.ino, 'ino 应该有值')
    assert.ok(rows[0]!.mtime_ms, 'mtime_ms 应该有值')
  } finally {
    await close()
  }
})

test('size 与 mtime 都没变时跳过读内容（hash 保持不变）', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'lib', root)
    const p = path.join(root, 'a', 'w.mp4')
    writeFileSync(p, 'video-content-3')
    await adopt(db, {})
    await scan(db)
    const before = await db.conn.query<{ hash: string | null }>('select hash from files')

    const r = await scan(db)
    const after = await db.conn.query<{ hash: string | null }>('select hash from files')
    assert.equal(r.unchanged, 1)
    assert.equal(after[0]!.hash, before[0]!.hash, '未变化时不应重算指纹')
  } finally {
    await close()
  }
})

test('内容变了但 size 与 mtime 都没动：检测不到（已知缺陷，记录在这里）', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'lib', root)
    const p = path.join(root, 'a', 'v.mp4')
    writeFileSync(p, 'AAAAAAAAAA')
    await adopt(db, {})
    await scan(db)
    const st = (await import('node:fs')).statSync(p)

    // 同长度覆盖，再把 mtime 改回去 —— 模拟「换内容但保留时间戳」
    writeFileSync(p, 'BBBBBBBBBB')
    utimesSync(p, st.atime, st.mtime)

    const r = await scan(db)
    assert.equal(r.moved.length, 0)
    assert.equal(r.missing.length, 0)
    // 这条用例的意义是「承认边界」：只能靠 lib verify 抽样发现
  } finally {
    await close()
  }
})

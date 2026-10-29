/**
 * 资产库对账（scan）：移动识别、丢失标记、孤儿识别。
 *
 * 这几个用例守的是本期的核心承诺：**文件挪了能自动纠回来**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SqliteConn, sqliteDialect } from '../src/core/db/sqlite.ts'
import { migrate } from '../src/core/db/migrations.ts'
import {
  addRoot, assetEvents, listRoots, recordDownload, removeRoot, scan, stats, whereAsset,
} from '../src/core/db/library.ts'
import type { Database } from '../src/core/db/index.ts'

function setup(): { db: Database; root: string; close: () => Promise<void> } {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-lib-'))
  const file = path.join(dir, 'astra.db')
  const root = path.join(dir, 'media')
  mkdirSync(path.join(root, 'A'), { recursive: true })
  const db: Database = { conn: new SqliteConn(file), dialect: sqliteDialect, url: `sqlite:${file}` }
  return {
    db,
    root,
    close: async () => {
      await db.conn.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function seed(db: Database, root: string, rel: string, body: string): Promise<string> {
  const abs = path.join(root, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, body)
  const roots = await listRoots(db)
  const target = roots[0] ?? (await addRoot(db, 'test', root))
  const { assetId } = await recordDownload(
    db,
    { platform: 'test', nativeId: rel, title: rel, artists: 'a', kind: 'music' },
    { rootId: target.id, relPath: rel, size: body.length },
  )
  return assetId
}

test('路径没变时全部 unchanged，不产生 moved/missing', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'test', root)
    await seed(db, root, 'A/x.flac', 'x'.repeat(1000))
    const r = await scan(db)
    assert.equal(r.scanned, 1)
    assert.equal(r.unchanged, 1)
    assert.equal(r.moved.length, 0)
    assert.equal(r.missing.length, 0)
  } finally {
    await close()
  }
})

test('文件被移动+改名 → 自动纠回 rel_path 并记 moved 事件', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'test', root)
    const id = await seed(db, root, 'A/x.flac', 'y'.repeat(2000))

    mkdirSync(path.join(root, 'B'), { recursive: true })
    renameSync(path.join(root, 'A/x.flac'), path.join(root, 'B/renamed.flac'))

    const r = await scan(db)
    assert.equal(r.moved.length, 1)
    assert.equal(r.moved[0]!.from, 'A/x.flac')
    assert.equal(r.moved[0]!.to, 'B/renamed.flac')
    assert.equal(r.missing.length, 0)

    const files = await whereAsset(db, id)
    assert.equal(files.length, 1)
    assert.equal(files[0]!.rel_path, 'B/renamed.flac')
    assert.equal(files[0]!.state, 'present')
    assert.ok(files[0]!.abs_path.endsWith('B/renamed.flac'))

    const events = await assetEvents(db, id)
    assert.ok(events.some((e) => e.kind === 'moved'))
  } finally {
    await close()
  }
})

test('文件被删 → 标 missing，记录不删', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'test', root)
    const id = await seed(db, root, 'A/x.flac', 'z'.repeat(1500))

    rmSync(path.join(root, 'A/x.flac'))
    const r = await scan(db)
    assert.equal(r.missing.length, 1)

    const files = await whereAsset(db, id)
    assert.equal(files[0]!.state, 'missing')

    // 记录还在：stats 里 files 数不变
    const s = await stats(db)
    assert.equal(s.files, 1)
    assert.equal(s.missing, 1)
    assert.equal(s.present, 0)
  } finally {
    await close()
  }
})

test('盘上有但库里没有的文件算孤儿，不建 asset', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'test', root)
    await seed(db, root, 'A/x.flac', 'k'.repeat(1200))
    writeFileSync(path.join(root, 'A/unknown.flac'), 'u'.repeat(999))

    const r = await scan(db)
    assert.equal(r.orphanCount, 1)
    assert.equal(r.orphans[0]!.relPath, 'A/unknown.flac')
    const s = await stats(db)
    assert.equal(s.assets, 1) // 没有为孤儿建 asset
  } finally {
    await close()
  }
})

test('扫描会跳过 .lrc / 图片等非资产文件', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'test', root)
    await seed(db, root, 'A/x.flac', 'm'.repeat(800))
    writeFileSync(path.join(root, 'A/x.lrc'), '[00:00]lyric')
    writeFileSync(path.join(root, 'A/cover.jpg'), 'jpg')

    const r = await scan(db)
    assert.equal(r.scanned, 1) // 只有 flac 被计入
    assert.equal(r.orphanCount, 0)
  } finally {
    await close()
  }
})

test('图片库（pixiv）里的 jpg 是资产，不能被当附属文件跳过', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    const r0 = await addRoot(db, 'pixiv', root)
    mkdirSync(path.join(root, '62834074'), { recursive: true })
    const body = 'fake-jpeg-bytes'
    writeFileSync(path.join(root, '62834074', '151211681_p0.jpg'), body)
    await recordDownload(db, { platform: 'pixiv', nativeId: '151211681_p0', title: 'x', kind: 'image' },
      { rootId: r0.id, relPath: path.join('62834074', '151211681_p0.jpg'), size: body.length })

    const r = await scan(db)
    assert.equal(r.unchanged, 1)
    assert.equal(r.missing.length, 0)
  } finally {
    await close()
  }
})

test('有文件引用的 root 不能删', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'test', root)
    await seed(db, root, 'A/x.flac', 'q'.repeat(700))
    const refused = await removeRoot(db, 'test')
    assert.equal(refused.removed, false)
    assert.equal(refused.files, 1)
  } finally {
    await close()
  }
})

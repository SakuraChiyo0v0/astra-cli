/**
 * lib adopt：认领孤儿文件（盘上有、库里没有的媒体）。
 *
 * 两条身份规则要守住：
 * - 同名 .nfo 带 BV 号 → bili:<BV>_p1（最可靠）
 * - 没有平台 id → local:<内容指纹>，**不能用路径**，否则文件一挪就变两条
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SqliteConn, sqliteDialect } from '../src/core/db/sqlite.ts'
import { migrate } from '../src/core/db/migrations.ts'
import { addRoot, adopt, scan, stats } from '../src/core/db/library.ts'
import type { Database } from '../src/core/db/index.ts'
// 漫画身份是 comic 领域登记进来的钩子（core 不 import 领域），这里按生产时的样子加载一次
import '../src/comic/manifest.ts'

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-adopt-'))
  const file = path.join(dir, 'astra.db')
  const root = path.join(dir, 'video')
  mkdirSync(path.join(root, 'UP', '作品'), { recursive: true })
  const db: Database = { conn: new SqliteConn(file), dialect: sqliteDialect, url: `sqlite:${file}` }
  return { db, root, dir, close: async () => { await db.conn.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('带 nfo 的视频用 BV 号做 id，标题/UP 从 nfo 取', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'bili', root)
    const mp4 = path.join(root, 'UP', '作品', '01.mp4')
    writeFileSync(mp4, 'video-bytes-1')
    writeFileSync(
      mp4.replace(/\.mp4$/, '.nfo'),
      '<?xml version="1.0"?><movie><title>测试标题</title><actor><name>某UP</name></actor><uniqueid>BV1xx411c7mD</uniqueid></movie>',
    )

    const r = await adopt(db, {})
    assert.equal(r.adopted, 1)
    assert.equal(r.withBvid, 1)
    assert.equal(r.local, 0)
    assert.equal(r.items[0]!.assetId, 'bili:BV1xx411c7mD_p1')

    const rows = await db.conn.query<{ title: string; artists: string }>('select title, artists from assets')
    assert.equal(rows[0]!.title, '测试标题')
    assert.equal(rows[0]!.artists, '某UP')
  } finally {
    await close()
  }
})

test('x.Metadata.nfo 这种命名也能读到 BV 号', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'bili', root)
    const mp4 = path.join(root, 'UP', '作品', '06.mp4')
    writeFileSync(mp4, 'video-bytes-6')
    writeFileSync(
      mp4.replace(/\.mp4$/, '.Metadata.nfo'),
      '<movie><title>元数据命名</title><actor><name>UP六</name></actor><uniqueid>BV1MUu1zSEW2</uniqueid></movie>',
    )

    const r = await adopt(db, {})
    assert.equal(r.withBvid, 1)
    assert.equal(r.items[0]!.assetId, 'bili:BV1MUu1zSEW2_p1')
  } finally {
    await close()
  }
})

test('没有 nfo 的视频用内容指纹做 id（不是路径）', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'bili', root)
    writeFileSync(path.join(root, 'UP', '作品', '02.mp4'), 'video-bytes-2')

    const r = await adopt(db, {})
    assert.equal(r.adopted, 1)
    assert.equal(r.local, 1)
    assert.match(r.items[0]!.assetId, /^local:\d+-[0-9a-f]{40}$/)
  } finally {
    await close()
  }
})

test('dry-run 只统计不写库', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'bili', root)
    writeFileSync(path.join(root, 'UP', '作品', '03.mp4'), 'video-bytes-3')

    const r = await adopt(db, { dryRun: true })
    assert.equal(r.dryRun, true)
    assert.equal(r.adopted, 1)
    const s = await stats(db)
    assert.equal(s.assets, 0)
  } finally {
    await close()
  }
})

test('gif 也是资产（官方活动图里全是动图）', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'bili', root)
    writeFileSync(path.join(root, 'UP', '作品', 'anim.gif'), 'GIF89a-bytes')

    const r = await adopt(db, { kinds: ['image'] })
    assert.equal(r.adopted, 1)
    assert.equal(r.items[0]!.kind, 'image')
  } finally {
    await close()
  }
})

test('sidecar（nfo/jpg/ass）不会被当成资产认领', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'bili', root)
    writeFileSync(path.join(root, 'UP', '作品', '04.mp4'), 'video-bytes-4')
    writeFileSync(path.join(root, 'UP', '作品', '04.nfo'), '<movie></movie>')
    writeFileSync(path.join(root, 'UP', '作品', '04.ass'), '[Script Info]')

    const r = await adopt(db, {})
    assert.equal(r.adopted, 1)
    // 认领之后 scan 不应把 nfo/ass 当孤儿
    const s = await scan(db)
    assert.equal(s.unchanged, 1)
  } finally {
    await close()
  }
})

test('两个 root 里有同一份内容：共用同一个 asset，不报主键冲突', async () => {
  const { db, root, dir, close } = setup()
  try {
    await migrate(db)
    const other = path.join(dir, 'pixiv-r18')
    mkdirSync(other, { recursive: true })
    await addRoot(db, 'pixiv', root)
    await addRoot(db, 'pixiv-r18', other)

    // 同一份内容放两处（同 size + 同前 1MB → 同指纹）
    writeFileSync(path.join(root, 'a.jpg'), 'same-image-bytes')
    writeFileSync(path.join(other, 'b.jpg'), 'same-image-bytes')

    const first = await adopt(db, { roots: ['pixiv'], kinds: ['image'] })
    assert.equal(first.adopted, 1)
    const second = await adopt(db, { roots: ['pixiv-r18'], kinds: ['image'] })
    assert.equal(second.adopted, 1)
    assert.equal(second.items[0]!.assetId, first.items[0]!.assetId)

    // 一个 asset、两个 file
    const s = await stats(db)
    assert.equal(s.assets, 1)
    assert.equal(s.files, 2)
  } finally {
    await close()
  }
})

test('同目录 .astra-comic.json 用本子/话数/页码做 id，不走指纹', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'comic', root)
    const page = path.join(root, '123 书', '03', '001.jpg')
    mkdirSync(path.dirname(page), { recursive: true })
    writeFileSync(page, 'page-bytes')
    writeFileSync(path.join(path.dirname(page), '.astra-comic.json'), JSON.stringify({
      albumId: '123',
      albumTitle: '书',
      authors: ['某人'],
      chapterId: '999',
      sort: 3,
      title: '第3话',
      pages: 1,
      scrambleId: '0',
    }))

    const r = await adopt(db, { kinds: ['image'] })
    assert.equal(r.adopted, 1)
    assert.equal(r.withComic, 1)
    assert.equal(r.local, 0)
    assert.equal(r.items[0]!.assetId, 'comic:123_c3_p1')

    const rows = await db.conn.query<{ title: string; artists: string; album: string }>(
      'select title, artists, album from assets',
    )
    assert.equal(rows[0]!.title, '书')
    assert.equal(rows[0]!.artists, '某人')
    assert.equal(rows[0]!.album, '第3话')
  } finally {
    await close()
  }
})

test('老 sidecar 没有 sort 时，用章节目录名当话数', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'comic', root)
    const page = path.join(root, '旧', '03', '002.jpg')
    mkdirSync(path.dirname(page), { recursive: true })
    writeFileSync(page, 'old-page')
    writeFileSync(path.join(path.dirname(page), '.astra-comic.json'), JSON.stringify({
      albumId: '456',
      chapterId: '1',
      title: '旧话',
      pages: 2,
      scrambleId: '0',
    }))

    const r = await adopt(db, { kinds: ['image'] })
    assert.equal(r.items[0]!.assetId, 'comic:456_c3_p2')
  } finally {
    await close()
  }
})

test('认领过的文件再 adopt 会跳过（幂等）', async () => {
  const { db, root, close } = setup()
  try {
    await migrate(db)
    await addRoot(db, 'bili', root)
    writeFileSync(path.join(root, 'UP', '作品', '05.mp4'), 'video-bytes-5')

    const first = await adopt(db, {})
    assert.equal(first.adopted, 1)
    const second = await adopt(db, {})
    assert.equal(second.adopted, 0)
    assert.equal(second.skipped, 1)
  } finally {
    await close()
  }
})

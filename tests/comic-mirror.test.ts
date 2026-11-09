/**
 * 已经下全、且每页都完整时，comic 不再拉图，但会登记进资产库。
 * 截断页不算 already_have —— 那条走网络，这里不测。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { downloadChapter } from '../src/comic/download.ts'
import type { AlbumDetail, ChapterDetail } from '../src/comic/client.ts'
import { SqliteConn, sqliteDialect } from '../src/core/db/sqlite.ts'
import { migrate } from '../src/core/db/migrations.ts'
import { addRoot, whereAsset } from '../src/core/db/library.ts'
import type { Database } from '../src/core/db/index.ts'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function tinyPng(): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr[16] = 8
  ihdr[17] = 6
  const iend = Buffer.alloc(12)
  iend.writeUInt32BE(0, 0)
  iend.write('IEND', 4, 'ascii')
  return Buffer.concat([PNG_SIG, ihdr, iend])
}

const album: AlbumDetail = {
  id: '123',
  seriesId: '',
  title: '书',
  authors: ['某人'],
  tags: [],
  description: '',
  pageCount: 1,
  pubDate: null,
  episodes: [],
}

const chapter: ChapterDetail = {
  id: '999',
  albumId: '123',
  title: '第3话',
  sort: 3,
  images: ['00001.jpg'],
  imageDomain: '',
  scrambleId: '0',
}

test('页都完整时 already_have，并按本子/话数/页码登记', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-comic-have-'))
  const prevDb = process.env.ASTRA_DB_URL
  const prevHome = process.env.ASTRA_HOME
  const prevComic = process.env.ASTRA_COMIC_DIR
  const dbFile = path.join(dir, 'astra.db')
  const root = path.join(dir, 'comic')
  const db: Database = { conn: new SqliteConn(dbFile), dialect: sqliteDialect, url: `sqlite:${dbFile}` }
  process.env.ASTRA_DB_URL = `sqlite:${dbFile}`
  process.env.ASTRA_HOME = dir
  process.env.ASTRA_COMIC_DIR = root
  try {
    await migrate(db)
    await addRoot(db, 'comic', root)
    const page = path.join(root, '123 书', '03', '001.jpg')
    mkdirSync(path.dirname(page), { recursive: true })
    writeFileSync(page, tinyPng())

    const result = await downloadChapter(album, chapter)
    assert.equal(result.status, 'already_have')

    const sidecar = JSON.parse(readFileSync(path.join(path.dirname(page), '.astra-comic.json'), 'utf8')) as { sort: number; albumId: string }
    assert.equal(sidecar.albumId, '123')
    assert.equal(sidecar.sort, 3)

    const files = await whereAsset(db, 'comic:123_c3_p1')
    assert.equal(files.length, 1)
    assert.equal(files[0]!.rel_path, path.join('123 书', '03', '001.jpg'))
  } finally {
    await db.conn.close()
    if (prevDb === undefined) delete process.env.ASTRA_DB_URL
    else process.env.ASTRA_DB_URL = prevDb
    if (prevHome === undefined) delete process.env.ASTRA_HOME
    else process.env.ASTRA_HOME = prevHome
    if (prevComic === undefined) delete process.env.ASTRA_COMIC_DIR
    else process.env.ASTRA_COMIC_DIR = prevComic
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 虎扑帖子与评分落库。
 *
 *  - `crawl.hupu_post`：正文抓一次就够，`post` 默认命中缓存
 *  - `crawl.hupu_score`：一场比赛的评分赛后不会变，存整份解析结果
 *
 * tid / match_no 用 text：虎扑 id 在 JS 安全整数内，但用 text 省掉来回 Number() 转换。
 */
import type { Conn } from '../core/db/adapter.ts'
import { openDatabase, type Database } from '../core/db/index.ts'
import type { HupuScoreBoard } from './match.ts'

export interface HupuPostRow {
  tid: string
  board: string | null
  title: string
  author: string | null
  content: string
  images: number
  views: number | null
  replies: number | null
  url: string
  fetchedAt: string
}

function tableName(dialectName: string, name: string): string {
  return dialectName === 'postgres' ? `crawl.${name}` : name
}

export async function openHupuDb(): Promise<Database> {
  const db = await openDatabase()
  if (db.dialect.name === 'postgres') await db.conn.exec('create schema if not exists crawl')
  await ensureSchema(db.conn, db.dialect.name)
  return db
}

export async function ensureSchema(conn: Conn, dialectName = 'postgres'): Promise<void> {
  const t = (name: string) => tableName(dialectName, name)
  await conn.exec(`create table if not exists ${t('hupu_post')} (
    tid text primary key,
    board text,
    title text,
    author text,
    content text,
    images integer,
    views integer,
    replies integer,
    url text,
    raw text,
    fetched_at text
  )`)
  await conn.exec(`create index if not exists hupu_post_fetched_idx on ${t('hupu_post')} (fetched_at)`)
  await conn.exec(`create table if not exists ${t('hupu_score')} (
    match_no text primary key,
    title text,
    payload text,
    fetched_at text
  )`)
}

function toRow(row: Record<string, unknown>): HupuPostRow {
  return {
    tid: String(row.tid ?? ''),
    board: (row.board as string | null) ?? null,
    title: String(row.title ?? ''),
    author: (row.author as string | null) ?? null,
    content: String(row.content ?? ''),
    images: Number(row.images ?? 0),
    views: row.views === null || row.views === undefined ? null : Number(row.views),
    replies: row.replies === null || row.replies === undefined ? null : Number(row.replies),
    url: String(row.url ?? ''),
    fetchedAt: String(row.fetched_at ?? ''),
  }
}

export async function readPost(db: Database, tid: string): Promise<HupuPostRow | null> {
  const t = (name: string) => tableName(db.dialect.name, name)
  const p = db.dialect.name === 'postgres' ? '$1' : '?'
  const rows = await db.conn.query<Record<string, unknown>>(`select * from ${t('hupu_post')} where tid = ${p}`, [tid])
  return rows[0] ? toRow(rows[0]) : null
}

export async function savePost(db: Database, post: HupuPostRow, raw?: unknown): Promise<void> {
  const t = (name: string) => tableName(db.dialect.name, name)
  const pg = db.dialect.name === 'postgres'
  const p = (i: number) => (pg ? `$${i}` : '?')
  await db.conn.query(
    `insert into ${t('hupu_post')}
       (tid, board, title, author, content, images, views, replies, url, raw, fetched_at)
     values (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)})
     on conflict (tid) do update set
       board = excluded.board, title = excluded.title, author = excluded.author,
       content = excluded.content, images = excluded.images, views = excluded.views,
       replies = excluded.replies, url = excluded.url, raw = excluded.raw,
       fetched_at = excluded.fetched_at`,
    [
      post.tid,
      post.board,
      post.title,
      post.author,
      post.content,
      post.images,
      post.views,
      post.replies,
      post.url,
      raw === undefined ? null : JSON.stringify(raw),
      new Date().toISOString(),
    ],
  )
}

export async function searchPosts(db: Database, keyword: string, limit: number): Promise<HupuPostRow[]> {
  const t = (name: string) => tableName(db.dialect.name, name)
  const pg = db.dialect.name === 'postgres'
  const p1 = pg ? '$1' : '?'
  const p2 = pg ? '$2' : '?'
  const rows = await db.conn.query<Record<string, unknown>>(
    `select * from ${t('hupu_post')}
      where title like ${p1} or content like ${p1}
      order by fetched_at desc
      limit ${p2}`,
    [`%${keyword}%`, limit],
  )
  return rows.map(toRow)
}

export async function countPosts(db: Database): Promise<number> {
  const t = (name: string) => tableName(db.dialect.name, name)
  const rows = await db.conn.query<Record<string, unknown>>(`select count(*) as n from ${t('hupu_post')}`)
  return Number(rows[0]?.n ?? 0)
}

/** 已存的评分：赛后数据不会变，命中即返回（`--refresh` 才重抓）。 */
export async function readScoreBoard(
  db: Database,
  matchNo: string,
): Promise<{ board: HupuScoreBoard; fetchedAt: string } | null> {
  const t = (name: string) => tableName(db.dialect.name, name)
  const p = db.dialect.name === 'postgres' ? '$1' : '?'
  const rows = await db.conn.query<Record<string, unknown>>(`select * from ${t('hupu_score')} where match_no = ${p}`, [matchNo])
  const row = rows[0]
  if (!row) return null
  try {
    const board = JSON.parse(String(row.payload ?? '')) as HupuScoreBoard
    return { board, fetchedAt: String(row.fetched_at ?? '') }
  } catch {
    return null
  }
}

export async function saveScoreBoard(db: Database, matchNo: string, board: HupuScoreBoard): Promise<void> {
  const t = (name: string) => tableName(db.dialect.name, name)
  const pg = db.dialect.name === 'postgres'
  const p = (i: number) => (pg ? `$${i}` : '?')
  await db.conn.query(
    `insert into ${t('hupu_score')} (match_no, title, payload, fetched_at)
     values (${p(1)},${p(2)},${p(3)},${p(4)})
     on conflict (match_no) do update set
       title = excluded.title, payload = excluded.payload, fetched_at = excluded.fetched_at`,
    [matchNo, board.title, JSON.stringify(board), new Date().toISOString()],
  )
}

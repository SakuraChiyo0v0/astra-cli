/**
 * 小黑盒帖子落库（`crawl.heybox_post` / `crawl.heybox_comment`）。
 *
 * 为什么落库：详情接口 5 分钟只能打一次，撞到验证码还会被锁。
 * 所以「发我一条链接」这个场景一律**先查库**，库里没有才请求一次，拿到就存。
 * 后续你再问同一篇、或者想搜「我之前存的某篇」，都不再碰接口。
 *
 * 表结构沿用 lol/douyin 的思路：常用字段拆列（能 order by / like），原始 JSON 留一份兜底。
 */
import type { Conn } from '../core/db/adapter.ts'
import { openDatabase, type Database } from '../core/db/index.ts'

export interface HeyboxPostRow {
  linkId: string
  title: string
  author: string
  authorId: number | null
  topic: string | null
  body: string
  images: string[]
  up: number
  comments: number
  createdAt: string | null
  fetchedAt: string
}

export interface HeyboxCommentRow {
  commentId: string
  userId: number | null
  text: string
  images: number
  createdAt: string | null
}

function tableName(dialectName: string, name: string): string {
  return dialectName === 'postgres' ? `crawl.${name}` : name
}

export async function openHeyboxDb(): Promise<Database> {
  const db = await openDatabase()
  if (db.dialect.name === 'postgres') await db.conn.exec('create schema if not exists crawl')
  await ensureSchema(db.conn, db.dialect.name)
  return db
}

export async function ensureSchema(conn: Conn, dialectName = 'postgres'): Promise<void> {
  const t = (name: string) => tableName(dialectName, name)
  await conn.exec(`create table if not exists ${t('heybox_post')} (
    link_id bigint primary key,
    title text,
    author text,
    author_id bigint,
    topic text,
    body text,
    images text,
    up integer,
    comment_num integer,
    created_at text,
    raw text,
    fetched_at text
  )`)
  await conn.exec(`create table if not exists ${t('heybox_comment')} (
    comment_id bigint primary key,
    link_id bigint,
    user_id bigint,
    text text,
    images integer,
    created_at text,
    fetched_at text
  )`)
  await conn.exec(`create index if not exists heybox_comment_link_idx on ${t('heybox_comment')} (link_id)`)
  await conn.exec(`create table if not exists ${t('heybox_game')} (
    appid bigint primary key,
    name text,
    name_en text,
    score numeric,
    score_desc text,
    price_current numeric,
    price_initial numeric,
    lowest_price numeric,
    lowest_discount integer,
    follow_num bigint,
    comment_num integer,
    platforms text,
    tags text,
    about text,
    raw text,
    fetched_at text
  )`)
}

/** 库里已有就返回，没有返回 null（不区分「没存过」和「存过但内容空」）。 */
export async function readPost(db: Database, linkId: string): Promise<{ post: HeyboxPostRow; comments: HeyboxCommentRow[] } | null> {
  const t = (name: string) => tableName(db.dialect.name, name)
  const rows = await db.conn.query<Record<string, unknown>>(
    `select * from ${t('heybox_post')} where link_id = ${db.dialect.name === 'postgres' ? '$1' : '?'}`,
    [Number(linkId)],
  )
  const row = rows[0]
  if (!row) return null
  const crows = await db.conn.query<Record<string, unknown>>(
    `select * from ${t('heybox_comment')} where link_id = ${db.dialect.name === 'postgres' ? '$1' : '?'} order by comment_id asc`,
    [Number(linkId)],
  )
  return {
    post: {
      linkId: String(row.link_id),
      title: String(row.title ?? ''),
      author: String(row.author ?? ''),
      authorId: row.author_id === null || row.author_id === undefined ? null : Number(row.author_id),
      topic: (row.topic as string | null) ?? null,
      body: String(row.body ?? ''),
      images: parseImages(row.images),
      up: Number(row.up ?? 0),
      comments: Number(row.comment_num ?? 0),
      createdAt: (row.created_at as string | null) ?? null,
      fetchedAt: String(row.fetched_at ?? ''),
    },
    comments: crows.map((c) => ({
      commentId: String(c.comment_id),
      userId: c.user_id === null || c.user_id === undefined ? null : Number(c.user_id),
      text: String(c.text ?? ''),
      images: Number(c.images ?? 0),
      createdAt: (c.created_at as string | null) ?? null,
    })),
  }
}

function parseImages(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim().startsWith('[')) return []
  try {
    return JSON.parse(raw) as string[]
  } catch {
    return []
  }
}

/** 游戏详情：价格会变，所以带 fetchedAt 给调用方判断新鲜度。 */
export async function readGame(db: Database, appid: string): Promise<Record<string, unknown> | null> {
  const t = (name: string) => tableName(db.dialect.name, name)
  const p = db.dialect.name === 'postgres' ? '$1' : '?'
  const rows = await db.conn.query<Record<string, unknown>>(`select * from ${t('heybox_game')} where appid = ${p}`, [Number(appid)])
  return rows[0] ?? null
}

export async function saveGame(db: Database, appid: string, fields: Record<string, unknown>, raw: unknown): Promise<void> {
  const t = (name: string) => tableName(db.dialect.name, name)
  const pg = db.dialect.name === 'postgres'
  const p = (i: number) => (pg ? `$${i}` : '?')
  await db.conn.query(
    `insert into ${t('heybox_game')}
       (appid, name, name_en, score, score_desc, price_current, price_initial, lowest_price,
        lowest_discount, follow_num, comment_num, platforms, tags, about, raw, fetched_at)
     values (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},${p(12)},${p(13)},${p(14)},${p(15)},${p(16)})
     on conflict (appid) do update set
       name = excluded.name, name_en = excluded.name_en, score = excluded.score,
       score_desc = excluded.score_desc, price_current = excluded.price_current,
       price_initial = excluded.price_initial, lowest_price = excluded.lowest_price,
       lowest_discount = excluded.lowest_discount, follow_num = excluded.follow_num,
       comment_num = excluded.comment_num, platforms = excluded.platforms, tags = excluded.tags,
       about = excluded.about, raw = excluded.raw, fetched_at = excluded.fetched_at`,
    [
      Number(appid),
      fields.name ?? null, fields.nameEn ?? null, fields.score ?? null, fields.scoreDesc ?? null,
      fields.priceCurrent ?? null, fields.priceInitial ?? null, fields.lowestPrice ?? null,
      fields.lowestDiscount ?? null, fields.followNum ?? null, fields.commentNum ?? null,
      JSON.stringify(fields.platforms ?? []), JSON.stringify(fields.tags ?? []),
      fields.about ?? null, JSON.stringify(raw ?? null),
      new Date().toISOString(),
    ],
  )
}

/** 覆盖写：同一篇帖子重新抓取时整行替换，评论按 comment_id upsert。 */
export async function savePost(
  db: Database,
  post: HeyboxPostRow,
  comments: HeyboxCommentRow[],
  raw?: unknown,
): Promise<void> {
  const t = (name: string) => tableName(db.dialect.name, name)
  const now = new Date().toISOString()
  const pg = db.dialect.name === 'postgres'
  const p = (i: number) => (pg ? `$${i}` : '?')

  await db.conn.query(
    `insert into ${t('heybox_post')}
       (link_id, title, author, author_id, topic, body, images, up, comment_num, created_at, raw, fetched_at)
     values (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},${p(12)})
     on conflict (link_id) do update set
       title = excluded.title, author = excluded.author, author_id = excluded.author_id,
       topic = excluded.topic, body = excluded.body, images = excluded.images,
       up = excluded.up, comment_num = excluded.comment_num, created_at = excluded.created_at,
       raw = excluded.raw, fetched_at = excluded.fetched_at`,
    [
      Number(post.linkId), post.title, post.author, post.authorId, post.topic, post.body,
      JSON.stringify(post.images), post.up, post.comments, post.createdAt,
      raw === undefined ? null : JSON.stringify(raw), now,
    ],
  )

  for (const c of comments) {
    await db.conn.query(
      `insert into ${t('heybox_comment')}
         (comment_id, link_id, user_id, text, images, created_at, fetched_at)
       values (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)})
       on conflict (comment_id) do update set
         text = excluded.text, images = excluded.images, created_at = excluded.created_at,
         fetched_at = excluded.fetched_at`,
      [Number(c.commentId), Number(post.linkId), c.userId, c.text, c.images, c.createdAt, now],
    )
  }
}

/** 本地搜索：标题/正文/作者模糊匹配，不碰网络。 */
export async function searchPosts(db: Database, keyword: string, limit = 10): Promise<Array<Pick<HeyboxPostRow, 'linkId' | 'title' | 'author' | 'createdAt' | 'comments'>>> {
  const t = (name: string) => tableName(db.dialect.name, name)
  const pg = db.dialect.name === 'postgres'
  const ph = (i: number) => (pg ? `$${i}` : '?')
  const like = `%${keyword}%`
  const rows = await db.conn.query<Record<string, unknown>>(
    `select link_id, title, author, created_at, comment_num from ${t('heybox_post')}
      where title like ${ph(1)} or body like ${ph(2)} or author like ${ph(3)}
      order by fetched_at desc limit ${ph(4)}`,
    [like, like, like, limit],
  )
  return rows.map((r) => ({
    linkId: String(r.link_id),
    title: String(r.title ?? ''),
    author: String(r.author ?? ''),
    createdAt: (r.created_at as string | null) ?? null,
    comments: Number(r.comment_num ?? 0),
  }))
}

/**
 * 运行状态库：曲库（tracks）、后台任务、订阅、调度、审计。
 *
 * 0.58.0 起和资产库是**同一个库**（`openDatabase()`：`db-url` 指向 PG 时就是 PG，
 * 没配时是 `<ASTRA_HOME>/astra.db`）。之前状态单独落在 SQLite 里，资产库靠
 * `mirrorFile` 双写过去，两边一直对不上 —— 要一份真相就只能有一个库。
 *
 * 用法：
 * ```ts
 * const s = await state()
 * const rows = await s.query<Row>('select * from jobs where id = ?', [id])
 * ```
 *
 * 约定：
 * - 一个进程一个连接，第一次调用时打开，`closeState()` 关（main 的 finally、worker 结束时）
 * - 状态表是 CLI 能跑的前提（不建表 `music get` 都跑不了），所以首次打开时**自动**补齐
 *   状态表迁移。资产库自己的迁移仍要 `astra db migrate` 显式跑
 * - SQL 一律 `?` 占位、方言中性；PG 的 bigint / count(*) 回来是字符串，读的时候 `Number()`
 */
import { openDatabase, type Database } from './db/index.ts'
import type { Conn } from './db/adapter.ts'
import { ensureStateTables } from './db/migrations.ts'

let opening: Promise<Database> | null = null
let opened: Database | null = null

/** 当前进程的状态库连接。 */
export async function state(): Promise<Conn> {
  return (await stateDb()).conn
}

/** 连同方言一起要（少数地方要按方言分支，比如备份）。 */
export async function stateDb(): Promise<Database> {
  if (opened) return opened
  if (!opening) {
    opening = (async () => {
      const db = await openDatabase()
      try {
        await ensureStateTables(db)
      } catch (err) {
        await db.conn.close().catch(() => {})
        throw err
      }
      opened = db
      return db
    })()
    // 打开失败时允许下一次重试，而不是永远拿到同一个 rejected promise
    opening.catch(() => {
      opening = null
    })
  }
  return opening
}

/**
 * 旁路写（审计这类「失败不影响主流程、调用方不 await」的写）登记在这里，
 * `closeState()` 关连接前等它们写完 —— 否则命令一返回连接就关了，审计静默丢失。
 */
const pending = new Set<Promise<unknown>>()

export function background(work: Promise<unknown>): void {
  const tracked = work.catch(() => {}).finally(() => pending.delete(tracked))
  pending.add(tracked)
}

/** 等所有旁路写落地（测试里也用）。 */
export async function flushBackground(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending])
}

/** 关掉连接。PG 连接池不关进程就退不出去。 */
export async function closeState(): Promise<void> {
  await flushBackground()
  const db = opened
  opened = null
  opening = null
  if (db) await db.conn.close().catch(() => {})
}

/** 只查一行。 */
export async function one<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await (await state()).query<T>(sql, params)
  return rows[0]
}

/** 查多行。 */
export async function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await state()).query<T>(sql, params)
}

/** 写，返回影响行数。 */
export async function run(sql: string, params: unknown[] = []): Promise<number> {
  return (await state()).exec(sql, params)
}

/** 事务。回调里用传进来的 conn，别再调 `state()`（那是另一条连接）。 */
export async function tx<T>(fn: (conn: Conn) => Promise<T>): Promise<T> {
  return (await state()).tx(fn)
}

/** PG 的 bigint / count 是字符串；SQLite 是 number。统一成 number，null 保持 null。 */
export function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value)
}

export function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

/** 时间列：PG 的 timestamptz 回来是 Date，SQLite 是字符串。统一成 ISO 字符串。 */
export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return value === null || value === undefined ? '' : String(value)
}

export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

/** 布尔列：PG 是 boolean，SQLite 是 0/1。 */
export function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't'
}

/**
 * 记一次订阅运行。四个域共用（音乐 / B 站 / 漫画 / 小说），以前各写一份 `insert or replace`
 * —— 那是 SQLite 方言，PG 不认。主键 (subscription_id, ran_at)：同一毫秒重跑覆盖。
 */
export async function recordSubscriptionRun(subscriptionId: string, ranAt: string, newTracks: number, jobId: string | null, note: string | null): Promise<void> {
  await run(
    `insert into subscription_runs (subscription_id, ran_at, new_tracks, job_id, note) values (?, ?, ?, ?, ?)
     on conflict (subscription_id, ran_at) do update set new_tracks = excluded.new_tracks, job_id = excluded.job_id, note = excluded.note`,
    [subscriptionId, ranAt, newTracks, jobId, note],
  )
}

/**
 * 用户表的 schema 版本管理（不是 astra 自己的内置迁移）。
 *
 * 内置的 `db migrate` 只管 astra 自己的表；用户自己的业务表（比如爬虫抓的数据）
 * 需要一套自己的迁移记录，否则「这条 DDL 跑过没有」永远要靠记。
 *
 * 约定：
 * - 迁移文件放 `<ASTRA_HOME>/db/migrations/`，按文件名排序执行（建议 `01_xxx.sql`）
 * - 记录表 `_astra_schema`：name / checksum / applied_at / duration_ms
 * - 已应用的迁移文件内容变了 → 报 drift，默认拒绝继续（避免有人偷偷改历史迁移）
 * - 每个文件在一个事务里执行，失败整体回滚
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { AstraError } from '../errors.ts'
import { homePath } from '../paths.ts'
import type { Conn } from './adapter.ts'
import { splitStatements } from './sqlfile.ts'

export const SCHEMA_TABLE = '_astra_schema'

export function schemaDir(): string {
  return homePath('db/migrations')
}

export interface AppliedRow {
  name: string
  checksum: string
  appliedAt: string | null
  durationMs: number | null
}

export interface PlanEntry {
  name: string
  path: string
  checksum: string
  state: 'pending' | 'applied' | 'drift' | 'missing'
  statements: number
}

export function checksumOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export async function ensureSchemaTable(conn: Conn): Promise<void> {
  await conn.exec(
    `create table if not exists ${SCHEMA_TABLE} (
       name text primary key,
       checksum text not null,
       applied_at timestamp not null default current_timestamp,
       duration_ms integer
     )`,
  )
}

export async function listApplied(conn: Conn): Promise<AppliedRow[]> {
  await ensureSchemaTable(conn)
  const rows = await conn.query<{ name: string; checksum: string; applied_at: unknown; duration_ms: number | null }>(
    `select name, checksum, applied_at, duration_ms from ${SCHEMA_TABLE} order by name`,
  )
  return rows.map((r) => ({
    name: String(r.name),
    checksum: String(r.checksum),
    appliedAt: r.applied_at ? new Date(r.applied_at as string | number | Date).toISOString() : null,
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
  }))
}

/** 读目录 + 已应用记录，算出每个迁移的状态。 */
export function buildPlan(dir: string, applied: AppliedRow[]): PlanEntry[] {
  const byName = new Map(applied.map((row) => [row.name, row]))
  const entries: PlanEntry[] = []
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql')).sort()
    : []

  for (const file of files) {
    const path = join(dir, file)
    const text = readFileSync(path, 'utf8')
    const checksum = checksumOf(text)
    const row = byName.get(file)
    let state: PlanEntry['state'] = 'pending'
    if (row) state = row.checksum === checksum ? 'applied' : 'drift'
    entries.push({ name: file, path, checksum, state, statements: splitStatements(text).length })
    byName.delete(file)
  }
  // 记录里在、目录里已经没有的
  for (const [name] of byName) {
    entries.push({ name, path: '', checksum: '', state: 'missing', statements: 0 })
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

export interface ApplyResult {
  name: string
  statements: number
  durationMs: number
}

/** 执行一个迁移文件（调用方负责事务）。 */
export async function runMigrationFile(conn: Conn, entry: PlanEntry): Promise<ApplyResult> {
  const started = Date.now()
  const statements = splitStatements(readFileSync(entry.path, 'utf8'))
  for (const stmt of statements) {
    await conn.exec(stmt)
  }
  const durationMs = Date.now() - started
  await conn.exec(
    `insert into ${SCHEMA_TABLE}(name, checksum, duration_ms) values (?, ?, ?)`,
    [entry.name, entry.checksum, durationMs],
  )
  return { name: entry.name, statements: statements.length, durationMs }
}

export function requireDirExists(dir: string): void {
  if (!existsSync(dir)) {
    throw new AstraError('SCHEMA_DIR_MISSING', `迁移目录不存在：${dir}`, {
      exitCode: 2,
      hint: '先建目录并放 .sql 文件，例如 01_init.sql',
    })
  }
}

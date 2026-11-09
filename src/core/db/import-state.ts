/**
 * 一次性搬迁：把老的 `<ASTRA_HOME>/astra.db`（0.55 及以前的独立状态库）里的七张状态表
 * 导进当前库（`openDatabase()`，线上是 PG）。
 *
 * 规则：
 * - **幂等**：按主键 `on conflict do nothing`。跑两次结果一样；目标库里已有的行（新版本已经写进去的）不覆盖
 * - **不删源文件**：成功后把源改名成 `astra.db.migrated-<时间>` 留底，`--keep-source` 时连名字都不动
 * - 源和目标是同一个文件（没配 db-url、本机 SQLite）时什么都不做：那本来就是同一个库
 * - audit_log 的 id 是自增：搬过去之后要把 PG 序列推到 max(id)，否则下一条新审计会主键冲突
 *
 * 源库里还可能有一份早期资产库（assets / files / roots / events，`db-url` 配上 PG 之前写的）。
 * 那份不搬：PG 里是现行的那份，两边混起来会出现重复资产。结果里报告它的行数，让人知道它在。
 */
import { existsSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AstraError } from '../errors.ts'
import { homePath } from '../paths.ts'
import type { Database } from './index.ts'
import { SqliteConn } from './sqlite.ts'
import { STATE_KEYS, STATE_TABLES } from './state-schema.ts'
import { ensureStateTables } from './migrations.ts'

export interface ImportStateResult {
  source: string
  /** 每张表：源里多少行、实际新插了多少行（已存在的跳过）。 */
  tables: Record<string, { source: number; inserted: number }>
  /** 源里有、没搬的表（早期资产库残留等）。 */
  leftBehind: Record<string, number>
  /** 源被改名成什么（--keep-source 时为 null）。 */
  renamedTo: string | null
  dryRun: boolean
}

/** 默认的源：老位置的 astra.db。 */
export function legacyStatePath(): string {
  return homePath('astra.db')
}

/** 源库在、且当前库不是它自己 —— 也就是「还有一份老状态没搬」。给 doctor 用。 */
export function legacyStatePending(db: Database): boolean {
  const file = legacyStatePath()
  if (!existsSync(file)) return false
  if (db.conn instanceof SqliteConn && path.resolve(db.conn.filePath) === path.resolve(file)) return false
  return true
}

function tableExists(src: DatabaseSync, name: string): boolean {
  return src.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name) !== undefined
}

function columnsOf(src: DatabaseSync, name: string): string[] {
  return (src.prepare(`pragma table_info("${name.replace(/"/g, '""')}")`).all() as { name: string }[]).map((c) => c.name)
}

async function targetColumns(db: Database, table: string): Promise<Set<string>> {
  if (db.dialect.name === 'postgres') {
    const rows = await db.conn.query<{ column_name: string }>(
      'select column_name from information_schema.columns where table_schema = current_schema() and table_name = ?',
      [table],
    )
    return new Set(rows.map((r) => r.column_name))
  }
  const rows = await db.conn.query<{ name: string }>(`pragma table_info("${table}")`)
  return new Set(rows.map((r) => r.name))
}

export async function importLegacyState(
  db: Database,
  options: { from?: string; dryRun?: boolean; keepSource?: boolean } = {},
): Promise<ImportStateResult> {
  const source = path.resolve(options.from ?? legacyStatePath())
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new AstraError('NOT_FOUND', `没有找到老状态库：${source}`, { exitCode: 4, hint: '已经搬过的话源会被改名成 astra.db.migrated-*；用 --from 指定别的文件' })
  }
  if (db.conn instanceof SqliteConn && path.resolve(db.conn.filePath) === source) {
    throw new AstraError('INVALID_INPUT', '当前库就是这个文件，不需要搬', {
      exitCode: 2,
      hint: '没配 db-url 时状态本来就在 astra.db 里；要搬进 PG 先 `astra db use postgres://…`',
    })
  }

  await ensureStateTables(db)
  const src = new DatabaseSync(source, { readOnly: true })
  const result: ImportStateResult = { source, tables: {}, leftBehind: {}, renamedTo: null, dryRun: options.dryRun === true }
  try {
    for (const name of ['assets', 'files', 'roots', 'events', 'schema_migrations']) {
      if (tableExists(src, name)) result.leftBehind[name] = Number((src.prepare(`select count(*) n from "${name}"`).get() as { n: number }).n)
    }

    await db.conn.tx(async (tx) => {
      for (const table of STATE_TABLES) {
        if (!tableExists(src, table)) {
          result.tables[table] = { source: 0, inserted: 0 }
          continue
        }
        // 只搬两边都有的列：老库可能停在阶梯的某一级，缺几列由目标的默认值补
        const wanted = await targetColumns({ ...db, conn: tx }, table)
        const cols = columnsOf(src, table).filter((c) => wanted.has(c))
        const rows = src.prepare(`select ${cols.map((c) => `"${c}"`).join(', ')} from "${table}"`).all() as Record<string, unknown>[]
        let inserted = 0
        if (!result.dryRun && rows.length > 0) {
          const keys = STATE_KEYS[table]
          const CHUNK = Math.max(1, Math.floor(900 / cols.length))
          for (let i = 0; i < rows.length; i += CHUNK) {
            const slice = rows.slice(i, i + CHUNK)
            const values: unknown[] = []
            const marks = slice.map((row) => {
              for (const c of cols) values.push(row[c] ?? null)
              return `(${cols.map(() => '?').join(', ')})`
            })
            inserted += await tx.exec(
              `insert into ${table} (${cols.join(', ')}) values ${marks.join(', ')} on conflict (${keys.join(', ')}) do nothing`,
              values,
            )
          }
        }
        result.tables[table] = { source: rows.length, inserted }
      }
      // audit_log 的自增：显式写了 id 之后 PG 序列不会跟着走
      if (!result.dryRun && db.dialect.name === 'postgres') {
        await tx.exec("select setval(pg_get_serial_sequence('audit_log', 'id'), greatest((select coalesce(max(id), 0) from audit_log), 1))")
      }
    })
  } finally {
    src.close()
  }

  if (!result.dryRun && options.keepSource !== true) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const target = `${source}.migrated-${stamp}`
    renameSync(source, target)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${source}${suffix}`)) renameSync(`${source}${suffix}`, `${target}${suffix}`)
    }
    result.renamedTo = target
  }
  return result
}

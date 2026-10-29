/**
 * SQLite 后端（Node 内置 `node:sqlite`，零依赖）。
 *
 * 同步 API 包成 Promise，和 PG 共用 `Conn` 接口。事务用 `begin immediate`
 * （拿写锁，避免多进程同时迁移时读到旧版本号）+ 嵌套用 savepoint。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Conn, Dialect } from './adapter.ts'

export const sqliteDialect: Dialect = {
  name: 'sqlite',
  label: 'SQLite',
  ddl: {
    id: 'text',
    text: 'text',
    int: 'integer',
    bigint: 'integer',
    json: 'text',
    bool: 'integer',
    ts: 'text',
  },
  convert: (sql) => sql,
  quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
  upsertClause: (keys, cols) => {
    const sets = cols.filter((c) => !keys.includes(c)).map((c) => `${c} = excluded.${c}`)
    return sets.length > 0
      ? `on conflict (${keys.join(', ')}) do update set ${sets.join(', ')}`
      : `on conflict (${keys.join(', ')}) do nothing`
  },
  autoId: 'integer primary key autoincrement',
  backupKind: 'sqlite-vacuum',
}

export class SqliteConn implements Conn {
  private readonly db: DatabaseSync
  private readonly path: string
  /** 事务栈：每层一个 savepoint 名。空 = 不在事务里。 */
  private readonly stack: string[] = []

  constructor(file: string) {
    this.path = file
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file, { timeout: 10_000 })
    this.db.exec('pragma journal_mode = wal; pragma foreign_keys = on;')
  }

  get filePath(): string {
    return this.path
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql)
    return stmt.all(...(params as never[])) as T[]
  }

  async exec(sql: string, params: unknown[] = []): Promise<number> {
    const stmt = this.db.prepare(sql)
    const result = stmt.run(...(params as never[]))
    return Number(result.changes ?? 0)
  }

  async tx<T>(fn: (conn: Conn) => Promise<T>): Promise<T> {
    const depth = this.stack.length
    const name = `sp_${depth}`
    this.db.exec(depth === 0 ? 'begin immediate' : `savepoint ${name}`)
    this.stack.push(name)
    try {
      const result = await fn(this)
      this.stack.pop()
      this.db.exec(depth === 0 ? 'commit' : `release ${name}`)
      return result
    } catch (err) {
      this.stack.pop()
      try {
        this.db.exec(depth === 0 ? 'rollback' : `rollback to ${name}`)
        if (depth > 0) this.db.exec(`release ${name}`)
      } catch {
        // 回滚失败时保留原始错误，它更有诊断价值
      }
      throw err
    }
  }

  async ping(): Promise<boolean> {
    try {
      this.db.prepare('select 1 as ok').get()
      return true
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    this.db.close()
  }

  /** 供备份用：SQLite 自己的在线一致快照。 */
  vacuumInto(target: string): void {
    mkdirSync(path.dirname(target), { recursive: true })
    this.db.exec(`vacuum into '${target.replace(/'/g, "''")}'`)
  }
}

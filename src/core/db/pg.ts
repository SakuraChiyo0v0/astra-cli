/**
 * PostgreSQL 后端（`pg`，纯 JS，能进 esbuild 单文件包）。
 *
 * 和 SQLite 的差异集中在这里：`?` → `$n`、`jsonb`、`boolean`、`timestamptz`、
 * `on conflict … do update`（PG 和 SQLite 写法一样，MySQL 不同）。
 */
import pg from 'pg'
import type { Conn, Dialect } from './adapter.ts'
import { toDollarPlaceholders } from './adapter.ts'

export const pgDialect: Dialect = {
  name: 'postgres',
  label: 'PostgreSQL',
  ddl: {
    id: 'text',
    text: 'text',
    int: 'integer',
    bigint: 'bigint',
    json: 'jsonb',
    bool: 'boolean',
    ts: 'timestamptz',
  },
  convert: toDollarPlaceholders,
  quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
  upsertClause: (keys, cols) => {
    const sets = cols.filter((c) => !keys.includes(c)).map((c) => `${c} = excluded.${c}`)
    return sets.length > 0
      ? `on conflict (${keys.join(', ')}) do update set ${sets.join(', ')}`
      : `on conflict (${keys.join(', ')}) do nothing`
  },
  autoId: 'bigserial primary key',
  backupKind: 'pg-dump',
}

/** 绑定到单条 client 的 Conn，事务里用它。 */
class PgTxConn implements Conn {
  private readonly client: pg.PoolClient
  private readonly dialect: Dialect
  private depth: number

  constructor(client: pg.PoolClient, dialect: Dialect, depth = 0) {
    this.client = client
    this.dialect = dialect
    this.depth = depth
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.client.query(this.dialect.convert(sql), params as unknown[])
    return result.rows as T[]
  }

  async exec(sql: string, params: unknown[] = []): Promise<number> {
    const result = await this.client.query(this.dialect.convert(sql), params as unknown[])
    return result.rowCount ?? 0
  }

  async tx<T>(fn: (conn: Conn) => Promise<T>): Promise<T> {
    const depth = this.depth
    const name = `sp_${depth}`
    await this.client.query(depth === 0 ? 'begin' : `savepoint ${name}`)
    try {
      const result = await fn(new PgTxConn(this.client, this.dialect, depth + 1))
      await this.client.query(depth === 0 ? 'commit' : `release ${name}`)
      return result
    } catch (err) {
      try {
        await this.client.query(depth === 0 ? 'rollback' : `rollback to ${name}`)
      } catch {
        // 保留原始错误
      }
      throw err
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.query('select 1')
      return true
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    // 事务连接不单独关，由外层 pool 管
  }
}

export class PgConn implements Conn {
  private readonly pool: pg.Pool
  private readonly dialect = pgDialect

  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'astra',
    })
    // 连接池的错误不能让进程崩（PG 重启时会抛 idle client error）
    this.pool.on('error', () => {})
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(this.dialect.convert(sql), params as unknown[])
    return result.rows as T[]
  }

  async exec(sql: string, params: unknown[] = []): Promise<number> {
    const result = await this.pool.query(this.dialect.convert(sql), params as unknown[])
    return result.rowCount ?? 0
  }

  async tx<T>(fn: (conn: Conn) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      return await new PgTxConn(client, this.dialect).tx(fn)
    } finally {
      client.release()
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('select 1')
      return true
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  /** 咨询锁：防两个进程同时跑迁移。锁随 client 归还释放。 */
  async withLock<T>(key: number, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('select pg_advisory_lock($1)', [key])
      return await fn()
    } finally {
      try {
        await client.query('select pg_advisory_unlock($1)', [key])
      } catch {
        // 解锁失败不掩盖主流程的错误
      }
      client.release()
    }
  }
}

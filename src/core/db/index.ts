/**
 * 数据库入口：按连接串选后端。
 *
 * `ASTRA_DB_URL` 决定用哪个库：
 * - 不设 → 本机 SQLite（`<ASTRA_HOME>/astra.db`），保持 CLI 开箱可用
 * - `postgres://…` → PostgreSQL
 * - `mysql://…` → 暂未实现，明确报错而不是静默回落
 */
import { AstraError } from '../errors.ts'
import { homePath } from '../paths.ts'
import { dialectOf, sqlitePath, type Conn, type Dialect } from './adapter.ts'
import { PgConn, pgDialect } from './pg.ts'
import { SqliteConn, sqliteDialect } from './sqlite.ts'

export interface Database {
  conn: Conn
  dialect: Dialect
  /** 实际使用的连接串（脱敏后的，给日志/doctor 看）。 */
  url: string
}

export function dbUrl(): string {
  const fromEnv = process.env.ASTRA_DB_URL?.trim()
  return fromEnv && fromEnv !== '' ? fromEnv : `sqlite:${homePath('astra.db')}`
}

/** 打日志用：把连接串里的密码抹掉。 */
export function redact(url: string): string {
  return url.replace(/(:\/\/[^:/@]+:)[^@]+@/, '$1***@')
}

export async function openDatabase(url: string = dbUrl()): Promise<Database> {
  let kind: ReturnType<typeof dialectOf>
  try {
    kind = dialectOf(url)
  } catch (err) {
    throw new AstraError('CONFIG', (err as Error).message, {
      hint: '支持 postgres://user:pass@host:5432/db、mysql://…、sqlite:/path/to.db；不设则用本机 SQLite',
      exitCode: 3,
    })
  }

  if (kind === 'sqlite') {
    const file = sqlitePath(url)
    return { conn: new SqliteConn(file), dialect: sqliteDialect, url: `sqlite:${file}` }
  }

  if (kind === 'postgres') {
    const conn = new PgConn(url)
    if (!(await conn.ping())) {
      await conn.close()
      throw new AstraError('UPSTREAM', `连不上 PostgreSQL：${redact(url)}`, {
        hint: '检查 ASTRA_DB_URL、数据库是否启动、账号权限；本机临时可用 sqlite:/path 跑',
        retryable: true,
        exitCode: 5,
      })
    }
    return { conn, dialect: pgDialect, url: redact(url) }
  }

  throw new AstraError('CONFIG', 'MySQL 适配还没实现', {
    hint: '目前支持 postgres:// 和 sqlite:；MySQL 留了适配位，后续补上',
    exitCode: 3,
  })
}

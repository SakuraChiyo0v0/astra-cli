/**
 * 数据库入口：按连接串选后端。
 *
 * `ASTRA_DB_URL` 决定用哪个库：
 * - 不设 → 本机 SQLite（`<ASTRA_HOME>/astra.db`），保持 CLI 开箱可用
 * - `postgres://…` → PostgreSQL
 * - `mysql://…` → 暂未实现，明确报错而不是静默回落
 */
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * 连接串优先级：环境变量 > `<ASTRA_HOME>/db-url` 文件 > 本机 SQLite。
 *
 * 为什么要文件：`ASTRA_DB_URL` 只存在于进程环境里，Hermes 的 cron/子进程拿不到，
 * 切换数据库就得改容器环境变量并重启网关。文件方式让切换只是「写一行」。
 * 文件里放密码，所以创建时 chmod 600。
 */
export function dbUrl(): string {
  const fromEnv = process.env.ASTRA_DB_URL?.trim()
  if (fromEnv && fromEnv !== '') return fromEnv
  try {
    const fromFile = readFileSync(homePath('db-url'), 'utf8').trim()
    if (fromFile !== '') return fromFile
  } catch {
    // 没有文件就是没配，正常路径
  }
  return `sqlite:${homePath('astra.db')}`
}

/** 把连接串写进 `<ASTRA_HOME>/db-url`（600 权限，含密码）。 */
export function saveDbUrl(url: string): void {
  const file = homePath('db-url')
  writeFileSync(file, `${url.trim()}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
}

/** 删掉 db-url 文件，回落到本机 SQLite。 */
export function clearDbUrl(): boolean {
  try {
    rmSync(homePath('db-url'))
    return true
  } catch {
    return false
  }
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

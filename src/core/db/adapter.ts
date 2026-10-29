/**
 * 数据库适配层。
 *
 * 目标：业务代码只写一套 SQL（`?` 占位符、方言中性 DDL 词），
 * 具体数据库的差异全部收在 `Dialect` 里。
 *
 * 为什么要适配层而不是直接用 SQLite：
 * - SQLite 单文件适合 CLI，但多进程并发写、跨机器访问、模糊搜索都不如 PG
 * - 用户明确要「连接通用数据库」的能力，且要留出后续接 MySQL 的位置
 *
 * 设计约束（和 astra 的工程习惯对齐）：
 * - 只依赖纯 JS 驱动（`pg`），原生模块进不了 esbuild 单文件包
 * - SQLite 用 Node 内置的 `node:sqlite`，零依赖
 * - 适配层**不隐藏**方言差异，而是把差异集中到可测的几个方法里
 */

/** 目前实现的方言。`mysql` 只留了接口位置，还没实现。 */
export type DialectName = 'postgres' | 'mysql' | 'sqlite'

/** 一条连接（或连接池的句柄）。业务层只认这个接口。 */
export interface Conn {
  /** 查多行。 */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /** 执行写操作，返回受影响行数。 */
  exec(sql: string, params?: unknown[]): Promise<number>
  /** 事务。回调抛错则回滚。支持嵌套（内层用 savepoint）。 */
  tx<T>(fn: (conn: Conn) => Promise<T>): Promise<T>
  /** 连通性探测。 */
  ping(): Promise<boolean>
  close(): Promise<void>
}

/** DDL 里用到的类型映射。业务层写 `dialect.ddl.json` 而不是硬写 `jsonb`。 */
export interface DdlTypes {
  id: string
  text: string
  int: string
  bigint: string
  json: string
  bool: string
  ts: string
}

export interface Dialect {
  name: DialectName
  label: string
  ddl: DdlTypes
  /** 把业务层写的 `?` 占位符转成本方言的写法。 */
  convert(sql: string): string
  /** 标识符引用。 */
  quoteIdent(name: string): string
  /** upsert 的冲突子句（接在 insert 后面）。`cols` 是插入列，`keys` 是冲突键。 */
  upsertClause(keys: string[], cols: string[]): string
  /** 自增主键写法（只有审计日志这类内部表用）。 */
  autoId: string
  /** 备份方式。 */
  backupKind: 'sqlite-vacuum' | 'pg-dump' | 'mysql-dump'
}

/**
 * 把 `?` 占位符转成 `$1,$2…`。
 *
 * 必须跳过字符串字面量、引号标识符和注释里的问号 —— 否则
 * `where title like '%?%'` 这种会被改坏。这个函数被单测覆盖。
 */
export function toDollarPlaceholders(sql: string): string {
  let out = ''
  let n = 0
  let i = 0
  const len = sql.length

  while (i < len) {
    const ch = sql[i]!
    const next = i + 1 < len ? sql[i + 1]! : ''

    // 单引号字符串：'' 是转义
    if (ch === "'") {
      out += ch
      i += 1
      while (i < len) {
        const c = sql[i]!
        out += c
        if (c === "'") {
          if (i + 1 < len && sql[i + 1] === "'") {
            out += "'"
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }

    // 双引号标识符
    if (ch === '"') {
      out += ch
      i += 1
      while (i < len) {
        const c = sql[i]!
        out += c
        i += 1
        if (c === '"') break
      }
      continue
    }

    // 行注释
    if (ch === '-' && next === '-') {
      while (i < len && sql[i] !== '\n') {
        out += sql[i]
        i += 1
      }
      continue
    }

    // 块注释
    if (ch === '/' && next === '*') {
      out += '/*'
      i += 2
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i]
        i += 1
      }
      out += '*/'
      i = Math.min(i + 2, len)
      continue
    }

    if (ch === '?') {
      n += 1
      out += `$${n}`
      i += 1
      continue
    }

    out += ch
    i += 1
  }

  return out
}

/** 由连接串判断方言。不认识的 scheme 直接报错，不要静默回落成 SQLite。 */
export function dialectOf(url: string | undefined): DialectName {
  if (!url || url.trim() === '') return 'sqlite'
  const u = url.trim()
  if (u.startsWith('postgres://') || u.startsWith('postgresql://')) return 'postgres'
  if (u.startsWith('mysql://') || u.startsWith('mariadb://')) return 'mysql'
  if (u.startsWith('sqlite:') || u.startsWith('file:') || u.startsWith('/') || u.startsWith('.')) return 'sqlite'
  throw new Error(`无法识别的数据库连接串：${u.split('://')[0]}://…（支持 postgres:// mysql:// sqlite:/path）`)
}

/** 从 `sqlite:` / `file:` 前缀里剥出真实路径。 */
export function sqlitePath(url: string): string {
  const u = url.trim()
  if (u.startsWith('sqlite://')) return u.slice('sqlite://'.length)
  if (u.startsWith('sqlite:')) return u.slice('sqlite:'.length)
  if (u.startsWith('file://')) return u.slice('file://'.length)
  if (u.startsWith('file:')) return u.slice('file:'.length)
  return u
}

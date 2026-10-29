/**
 * 迁移引擎 + 迁移清单。
 *
 * 约定：
 * - 每个迁移有稳定 id、一组**按方言分开**的 SQL、以及 checksum
 * - 已应用的迁移被改过 → 直接报错（防止偷偷改历史迁移导致各环境不一致）
 * - 迁移在事务里跑；MySQL 的 DDL 会隐式提交，所以每个迁移必须**幂等**
 * - 不自动迁移：启动只提示，`astra db migrate` 显式执行
 */
import { createHash } from 'node:crypto'
import { AstraError } from '../errors.ts'
import type { Database } from './index.ts'
import { PgConn } from './pg.ts'
import type { DialectName } from './adapter.ts'

export interface Migration {
  id: string
  /** 这个迁移在干什么（给 `db status` 显示）。 */
  summary: string
  up: Record<DialectName, string[]>
}

/**
 * 0001：资产/位置分离的核心表。
 *
 * 为什么不是直接改 `tracks`：
 * - `tracks.file_path` 是绝对路径，文件一挪就失真
 * - 一个资产可能有多份物理副本（不同盘、不同格式）
 *
 * 所以拆成 assets（身份）+ files（位置）+ roots（存储根）+ events（变更历史）。
 */
const M0001: Migration = {
  id: '0001_assets_files',
  summary: '资产库核心表：roots / assets / files / events',
  up: {
    sqlite: [
      `create table roots (
         id text primary key,
         label text not null unique,
         abs_path text not null,
         note text,
         created_at text not null
       )`,
      `create table assets (
         id text primary key,
         platform text not null,
         native_id text not null,
         kind text not null,
         title text not null,
         artists text,
         album text,
         duration_ms integer,
         meta text,
         created_at text not null,
         unique (platform, native_id)
       )`,
      `create index assets_title on assets (title)`,
      `create index assets_kind on assets (kind)`,
      `create table files (
         id text primary key,
         asset_id text not null,
         root_id text not null,
         rel_path text not null,
         size integer,
         mtime text,
         hash text,
         state text not null default 'present',
         first_seen text not null,
         last_seen text not null,
         unique (root_id, rel_path)
       )`,
      `create index files_asset on files (asset_id)`,
      `create index files_hash on files (hash)`,
      `create index files_state on files (state)`,
      `create table events (
         id integer primary key autoincrement,
         at text not null,
         kind text not null,
         asset_id text,
         file_id text,
         detail text
       )`,
      `create index events_at on events (at desc)`,
      `create index events_asset on events (asset_id)`,
    ],
    postgres: [
      `create table roots (
         id text primary key,
         label text not null unique,
         abs_path text not null,
         note text,
         created_at timestamptz not null
       )`,
      `create table assets (
         id text primary key,
         platform text not null,
         native_id text not null,
         kind text not null,
         title text not null,
         artists text,
         album text,
         duration_ms integer,
         meta jsonb,
         created_at timestamptz not null,
         unique (platform, native_id)
       )`,
      `create index assets_title on assets (title)`,
      `create index assets_kind on assets (kind)`,
      `create table files (
         id text primary key,
         asset_id text not null,
         root_id text not null,
         rel_path text not null,
         size bigint,
         mtime timestamptz,
         hash text,
         state text not null default 'present',
         first_seen timestamptz not null,
         last_seen timestamptz not null,
         unique (root_id, rel_path)
       )`,
      `create index files_asset on files (asset_id)`,
      `create index files_hash on files (hash)`,
      `create index files_state on files (state) where state = 'present'`,
      `create table events (
         id bigserial primary key,
         at timestamptz not null,
         kind text not null,
         asset_id text,
         file_id text,
         detail jsonb
       )`,
      `create index events_at on events (at desc)`,
      `create index events_asset on events (asset_id)`,
    ],
    mysql: [],
  },
}

export const MIGRATIONS: Migration[] = [M0001]

function checksum(m: Migration): string {
  return createHash('sha256').update(JSON.stringify(m.up)).digest('hex').slice(0, 16)
}

export interface AppliedMigration {
  id: string
  checksum: string
  applied_at: string
}

export interface MigrateResult {
  dialect: DialectName
  applied: string[]
  skipped: string[]
  current: number
  total: number
}

async function ensureTable(db: Database): Promise<void> {
  await db.conn.exec(
    `create table if not exists schema_migrations (
       id text primary key,
       dialect text not null,
       checksum text not null,
       applied_at ${db.dialect.ddl.ts} not null
     )`.replace(/\n\s+/g, ' '),
  )
}

export async function appliedMigrations(db: Database): Promise<AppliedMigration[]> {
  await ensureTable(db)
  return db.conn.query<AppliedMigration>(
    'select id, checksum, applied_at from schema_migrations order by id',
  )
}

/**
 * 跑迁移。`dryRun` 只报告不执行。
 *
 * 锁：
 * - SQLite：`begin immediate` 拿写锁，另一个进程会阻塞到提交
 * - PG：`pg_advisory_lock`，锁随连接释放
 */
export async function migrate(
  db: Database,
  options: { dryRun?: boolean } = {},
): Promise<MigrateResult> {
  const dialect = db.dialect.name
  if (dialect === 'mysql') {
    throw new AstraError('CONFIG', 'MySQL 适配还没实现', { exitCode: 3 })
  }

  const run = async (): Promise<MigrateResult> => {
    const done = await appliedMigrations(db)
    const doneById = new Map(done.map((d) => [d.id, d]))

    // 历史迁移被改过 → 报错，别让它静默漂移
    for (const m of MIGRATIONS) {
      const prev = doneById.get(m.id)
      if (prev && prev.checksum !== checksum(m)) {
        throw new AstraError('CONFIG', `迁移 ${m.id} 的 SQL 被改过（checksum 不一致）`, {
          hint: '已应用的迁移不能再改；新增一个迁移去修，不要改历史',
          exitCode: 3,
        })
      }
    }

    const pending = MIGRATIONS.filter((m) => !doneById.has(m.id))
    const result: MigrateResult = {
      dialect,
      applied: [],
      skipped: done.map((d) => d.id),
      current: done.length,
      total: MIGRATIONS.length,
    }
    if (pending.length === 0 || options.dryRun) {
      result.applied = pending.map((m) => m.id)
      return result
    }

    await db.conn.tx(async (tx) => {
      for (const m of pending) {
        const sql = m.up[dialect]
        if (!sql || sql.length === 0) {
          throw new AstraError('CONFIG', `迁移 ${m.id} 没有 ${dialect} 方言的 SQL`, { exitCode: 3 })
        }
        for (const stmt of sql) {
          await tx.exec(stmt.replace(/\n\s+/g, ' ').trim())
        }
        await tx.exec(
          `insert into schema_migrations (id, dialect, checksum, applied_at) values (?, ?, ?, ?)`,
          [m.id, dialect, checksum(m), new Date().toISOString()],
        )
        result.applied.push(m.id)
      }
    })

    result.current = done.length + pending.length
    return result
  }

  if (db.conn instanceof PgConn) {
    return db.conn.withLock(0x61737472, run)
  }
  return run()
}

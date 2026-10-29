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
  /**
   * SQL 执行完之后的数据搬迁钩子（同一个事务里跑）。
   * 纯 SQL 做不了「表不存在就跳过」这类判断，只能靠它。
   */
  after?: (db: Database) => Promise<void>
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

/**
 * 0002：把 `tracks` 回填到 assets + files。
 *
 * `tracks` 表**不动**（下载路径继续双写），这样老命令零改动、随时能回退。
 *
 * 回填写在 `after` 钩子里而不是纯 SQL：新库根本没有 `tracks` 表，
 * 纯 SQL 会直接 `no such table`；钩子里可以先判断表存在再决定做不做。
 */
const M0002: Migration = {
  id: '0002_backfill_tracks',
  summary: 'tracks 回填到 assets/files（tracks 保留，双写过渡）',
  up: {
    sqlite: [`alter table files add column sha256 text`],
    postgres: [`alter table files add column sha256 text`],
    mysql: [],
  },
  after: async (db) => {
    const tables = await db.conn.query<{ name: string }>(
      db.dialect.name === 'sqlite'
        ? "select name from sqlite_master where type = 'table' and name = 'tracks'"
        : "select tablename as name from pg_tables where tablename = 'tracks'",
    )
    if (tables.length === 0) return

    const now = new Date().toISOString()
    const rootPath = '/host-root/volume1/音乐'
    const roots = await db.conn.query<{ id: string }>('select id from roots where label = ?', ['nas-music'])
    const rootId = roots[0]?.id ?? 'root_nas'
    if (roots.length === 0) {
      await db.conn.exec(
        'insert into roots (id, label, abs_path, note, created_at) values (?, ?, ?, ?, ?)',
        [rootId, 'nas-music', rootPath, '/volume1/音乐（NAS 视角）', now],
      )
    }

    const tracks = await db.conn.query<{
      platform: string; native_id: string; title: string; artists: string | null; album: string | null
      duration_ms: number | null; file_path: string; audio_sha256: string | null; created_at: string
    }>('select platform, native_id, title, artists, album, duration_ms, file_path, audio_sha256, created_at from tracks')

    for (const t of tracks) {
      if (!t.file_path || !t.file_path.startsWith(rootPath + '/')) continue
      const assetId = `${t.platform}:${t.native_id}`
      const rel = t.file_path.slice(rootPath.length + 1)
      await db.conn.exec(
        `insert into assets (id, platform, native_id, kind, title, artists, album, duration_ms, meta, created_at)
         values (?, ?, ?, 'music', ?, ?, ?, ?, null, ?)`,
        [assetId, t.platform, t.native_id, t.title, t.artists, t.album, t.duration_ms, t.created_at],
      ).catch(() => {})
      await db.conn.exec(
        `insert into files (id, asset_id, root_id, rel_path, size, mtime, hash, sha256, state, first_seen, last_seen)
         values (?, ?, ?, ?, null, null, null, ?, 'present', ?, ?)`,
        [`file_${t.platform}_${t.native_id}`, assetId, rootId, rel, t.audio_sha256, t.created_at, t.created_at],
      ).catch(() => {})
    }
  },
}

export const MIGRATIONS: Migration[] = [M0001, M0002]

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
        if (m.after) await m.after({ ...db, conn: tx })
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

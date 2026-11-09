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
import { existsSync } from 'node:fs'
import { progress } from '../output.ts'
import { AstraError } from '../errors.ts'
import type { Database } from './index.ts'
import { PgConn } from './pg.ts'
import type { DialectName } from './adapter.ts'
import { POSTGRES_STATE, climbSqliteLadder } from './state-schema.ts'

export interface Migration {
  id: string
  /** 这个迁移在干什么（给 `db status` 显示）。 */
  summary: string
  /**
   * 旧 id。改过名字的迁移靠它认领已应用的记录 —— 否则会被当成“未应用”重跑一遍 DDL。
   * 多工具共用一个库时，新迁移一律用 `astra_` 前缀，避免编号相撞。
   */
  renamedFrom?: string
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
    // 这台机器上没有 NAS 音乐目录就跳过回填：否则会在别的机器上插一条指向不存在路径的 root
    if (!existsSync(rootPath)) {
      progress('migrate.nas_music_missing', { path: rootPath })
      return
    }
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

/**
 * 0003：清掉 `files.sha256` 里不可信的值。
 *
 * 0002 回填时抄了 `tracks.audio_sha256`，但那是**下载源流**的哈希 ——
 * 落盘时会写标签、嵌封面，文件内容早就变了。实测线上 21/21 条全部对不上。
 * 与其留着让人误信，不如清空，由 `lib verify` 实测后补真值。
 */
const M0003: Migration = {
  id: '0003_clear_untrusted_sha256',
  summary: '清空 files.sha256（回填时抄的源流哈希不可信）',
  up: {
    sqlite: [`update files set sha256 = null`],
    postgres: [`update files set sha256 = null`],
    mysql: [],
  },
}

/**
 * 0004 给 files 加 dev/ino/mtime_ms。
 *
 * 为什么加这三列（抄 Filebeat + restic 的作业）：
 * - `mtime_ms`：size 和 mtime 都没变就跳过读内容。线上 2045 个文件扫描 110 秒，
 *   绝大部分时间花在「图片同尺寸 → 被迫算指纹」上，有 mtime 就能直接判未变。
 * - `dev`/`ino`：同一文件系统内 rename 不改 inode，移动识别不用读一个字节。
 *   **只当线索，不当身份** —— Filebeat 文档明确说设备号在 LVM / 网络共享 / 容器里会变，
 *   所以 inode 命中才敢认，不命中就走指纹兜底。
 */
const M0004: Migration = {
  id: '0004_file_identity_columns',
  summary: 'files 增加 dev / ino / mtime_ms（扫描剪枝与零拷贝移动识别）',
  up: {
    sqlite: [
      `alter table files add column dev text`,
      `alter table files add column ino text`,
      `alter table files add column mtime_ms integer`,
      `create index if not exists files_ino_idx on files (root_id, dev, ino)`,
    ],
    postgres: [
      `alter table files add column if not exists dev text`,
      `alter table files add column if not exists ino text`,
      `alter table files add column if not exists mtime_ms bigint`,
      `create index if not exists files_ino_idx on files (root_id, dev, ino)`,
    ],
    mysql: [],
  },
}


/** 0005：资产归属与可见性（账户机制 M4）。 */
const M0005: Migration = {
  id: 'astra_0005_asset_visibility',
  renamedFrom: '0005_asset_visibility',
  summary: 'assets 增加 owner / visibility（受限主体只看自己的或 public）',
  up: {
    sqlite: [
      `alter table assets add column owner text`,
      `alter table assets add column visibility text not null default 'private'`,
    ],
    postgres: [
      `alter table assets add column if not exists owner text`,
      `alter table assets add column if not exists visibility text not null default 'private'`,
    ],
    mysql: [],
  },
}


/**
 * 0006：Hermes 会话进同一个库，但和资产表分开。
 *
 * PG 用 `hermes` schema；SQLite 没有 schema，表名加 `hermes_` 前缀，列对齐。
 * 线上 PG 里已经按这个形状建过（外部脚本），所以全部 `if not exists`，重复执行无害。
 */
const M0006: Migration = {
  id: 'astra_0006_hermes_archive',
  // 这套表最早由本仓库之外的脚本按 0005_hermes_archive 建过并记了账。
  // 线上库就是这种状态，靠 renamedFrom 只补记、不重跑 DDL。
  renamedFrom: '0005_hermes_archive',
  summary: 'Hermes 会话存档表（sessions / messages / documents）',
  up: {
    sqlite: [
      `create table if not exists hermes_sessions (
         id text primary key,
         title text,
         started_at text,
         last_activity_at text,
         message_count integer,
         model text,
         input_tokens integer,
         output_tokens integer,
         source text,
         chat_id text,
         chat_type text,
         archived integer,
         imported_at text not null
       )`,
      `create table if not exists hermes_messages (
         session_id text not null references hermes_sessions(id) on delete cascade,
         msg_id integer not null,
         role text,
         content text,
         tool_name text,
         tool_calls text,
         ts text,
         token_count integer,
         primary key (session_id, msg_id)
       )`,
      `create index if not exists hermes_messages_session on hermes_messages (session_id)`,
      `create table if not exists hermes_documents (
         path text primary key,
         title text,
         body text,
         imported_at text not null
       )`,
    ],
    postgres: [
      `create schema if not exists hermes`,
      `create table if not exists hermes.sessions (
         id text primary key,
         title text,
         started_at timestamptz,
         last_activity_at timestamptz,
         message_count integer,
         model text,
         input_tokens bigint,
         output_tokens bigint,
         source text,
         chat_id text,
         chat_type text,
         archived boolean,
         imported_at timestamptz not null default now()
       )`,
      `create table if not exists hermes.messages (
         session_id text not null references hermes.sessions(id) on delete cascade,
         msg_id bigint not null,
         role text,
         content text,
         tool_name text,
         tool_calls jsonb,
         ts text,
         token_count integer,
         primary key (session_id, msg_id)
       )`,
      `create index if not exists messages_session on hermes.messages (session_id)`,
      `create table if not exists hermes.documents (
         path text primary key,
         title text,
         body text,
         imported_at timestamptz not null default now()
       )`,
    ],
    mysql: [],
  },
}

/**
 * 0007：运行状态表并进同一个库（0.56.0）。
 *
 * tracks / jobs / job_items / subscriptions / subscription_runs / audit_log / schedules
 * 以前单独落在 `<ASTRA_HOME>/astra.db`。PG 上直接建最终形状；SQLite 上**什么也不做**——
 * 本机 SQLite 本来就是同一个文件，表由 `climbSqliteLadder` 按老阶梯补齐（老库可能停在任意一级）。
 * 定义见 `state-schema.ts`。
 */
const M0007: Migration = {
  id: 'astra_0007_state_tables',
  summary: '运行状态表（曲库 / 任务 / 订阅 / 审计 / 调度）进同一个库',
  up: {
    sqlite: ['select 1'],
    postgres: POSTGRES_STATE,
    mysql: [],
  },
}

export const MIGRATIONS: Migration[] = [M0001, M0002, M0003, M0004, M0005, M0006, M0007]

/** 状态表必须的迁移 id。 */
export const STATE_MIGRATION = M0007.id

/**
 * 保证状态表存在。`state()` 第一次打开时调。
 *
 * 和 `migrate()` 不同：这里**只**处理状态表，不碰资产库的其它迁移（那些仍要 `astra db migrate` 显式跑）。
 * 为什么状态表要自动：它是 CLI 能跑的前提，不建表连 `music get` 都跑不了；
 * 以前的 `core/db.ts` 也是打开时自动迁移的，这里保持同样的行为。
 *
 * SQLite：补老阶梯（幂等，靠 user_version）。
 * PG：执行 M0007（全是 `if not exists`）并记账；咨询锁防两个进程同时建。
 */
export async function ensureStateTables(db: Database): Promise<void> {
  if (db.dialect.name === 'sqlite') {
    await climbSqliteLadder(db.conn)
    return
  }
  if (db.dialect.name !== 'postgres') {
    throw new AstraError('CONFIG', `状态库不支持 ${db.dialect.name}`, { exitCode: 3 })
  }
  const done = async (): Promise<boolean> => {
    await ensureTable(db)
    const rows = await db.conn.query<{ id: string }>('select id from schema_migrations where id = ?', [M0007.id])
    return rows.length > 0
  }
  if (await done()) return
  const apply = async (): Promise<void> => {
    if (await done()) return // 拿到锁之后再看一次：另一个进程可能刚建完
    await db.conn.tx(async (tx) => {
      for (const stmt of M0007.up.postgres) await tx.exec(stmt.replace(/\n\s+/g, ' ').trim())
      await tx.exec(
        'insert into schema_migrations (id, dialect, checksum, applied_at) values (?, ?, ?, ?) on conflict (id) do nothing',
        [M0007.id, 'postgres', checksum(M0007), new Date().toISOString()],
      )
    })
  }
  if (db.conn instanceof PgConn) await db.conn.withLock(0x61737472, apply)
  else await apply()
}

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

    // 改过名字的迁移：旧 id 已应用 → 只补记新 id，不重跑 DDL
    const renamed = MIGRATIONS.filter((m) => !doneById.has(m.id) && m.renamedFrom && doneById.has(m.renamedFrom))
    const renamedIds = new Set(renamed.map((m) => m.id))
    const pending = MIGRATIONS.filter((m) => !doneById.has(m.id) && !renamedIds.has(m.id))
    const result: MigrateResult = {
      dialect,
      applied: [],
      skipped: done.map((d) => d.id),
      current: done.length,
      total: MIGRATIONS.length,
    }
    if ((pending.length === 0 && renamed.length === 0) || options.dryRun) {
      result.applied = pending.map((m) => m.id)
      return result
    }

    await db.conn.tx(async (tx) => {
      // 先补记改名的迁移（不执行 DDL），再跑真正的新迁移
      for (const m of renamed) {
        await tx.exec(
          `insert into schema_migrations (id, dialect, checksum, applied_at) values (?, ?, ?, ?)`,
          [m.id, dialect, checksum(m), new Date().toISOString()],
        )
        result.skipped.push(m.id)
      }
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

    // 进度只统计**本仓库定义**的迁移：共用同一个库时，schema_migrations 里还有别的工具的记录
    const known = new Set(MIGRATIONS.map((m) => m.id))
    // 刚补记的改名迁移也算“已完成”
    const doneOwn = done.filter((d) => known.has(d.id)).length + renamed.length
    result.current = doneOwn + pending.length
    return result
  }

  if (db.conn instanceof PgConn) {
    return db.conn.withLock(0x61737472, run)
  }
  return run()
}

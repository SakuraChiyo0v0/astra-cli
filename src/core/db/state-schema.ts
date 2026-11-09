/**
 * 运行状态表（tracks / jobs / job_items / subscriptions / subscription_runs / audit_log / schedules）的建表。
 *
 * 两种方言两条路：
 * - **SQLite**：沿用 0.58 之前 `core/db.ts` 那一套按 `user_version` 递增的阶梯，一字不改。
 *   本机已有的 `astra.db` 可能停在任意一级（老版本建的），只能按原样一级级补上去；
 *   新库从 0 走到底，结果和以前完全一样。
 * - **PostgreSQL**：直接建最终形状（`astra_0007_state_tables`）。PG 上从来没有过这些表，
 *   不存在「停在中间某一级」的老库。
 *
 * 列类型刻意和 SQLite 保持一致：时间仍是 ISO 文本（业务代码按字符串比较 `next_run_at <= ?`、
 * `Date.parse(created_at)`），布尔仍是 0/1 整数（SQL 里写的是 `enabled = 1`），JSON 仍是文本。
 * 换成 timestamptz / boolean / jsonb 会让同一句 SQL 在两边语义不同，这次只搬家不改型。
 */
import type { Conn } from './adapter.ts'

/** SQLite 的老阶梯。**只许在末尾追加**：按 user_version 索引执行，插在中间会让老库重跑已执行的 alter。 */
export const SQLITE_LADDER: string[] = [
  `create table tracks (
     platform text not null,
     native_id text not null,
     title text not null,
     artists text not null,
     album text,
     duration_ms integer,
     file_path text not null,
     format text not null,
     quality text not null,
     bytes integer,
     bps integer,
     audio_sha256 text,
     source_id text,
     created_at text not null,
     primary key (platform, native_id)
   )`,
  `create table jobs (
     id text primary key,
     kind text not null,
     title text not null,
     status text not null,
     quality text not null,
     total integer not null,
     done integer not null default 0,
     failed integer not null default 0,
     skipped integer not null default 0,
     pid integer,
     error text,
     created_at text not null,
     updated_at text not null
   )`,
  `create table job_items (
     job_id text not null,
     seq integer not null,
     native_id text not null,
     title text not null,
     artists text not null,
     status text not null,
     quality text,
     file_path text,
     error text,
     updated_at text not null,
     primary key (job_id, seq)
   )`,
  `create index tracks_title on tracks (title)`,
  // 母带规格。之前只存了 quality（档位名），回答不了"这首到底是 16bit 还是 24bit"。
  `alter table tracks add column sample_rate integer`,
  `alter table tracks add column bits_per_sample integer`,
  `alter table tracks add column channels integer`,
  `alter table tracks add column has_cover integer`,
  `alter table tracks add column has_lyric integer`,
  `alter table tracks add column has_word_lyric integer`,
  `create index tracks_spec on tracks (sample_rate, bits_per_sample)`,
  // 订阅：last_seen 存上次见到的曲目 id（JSON 数组），用集合差集决定"哪些是新歌"。
  `create table subscriptions (
     id text primary key,
     kind text not null,
     target_id text not null,
     title text not null,
     quality text,
     every_hours integer not null,
     enabled integer not null default 1,
     last_checked_at text,
     last_seen text,
     last_job_id text,
     created_at text not null,
     unique (kind, target_id)
   )`,
  `create table subscription_runs (
     subscription_id text not null,
     ran_at text not null,
     new_tracks integer not null,
     job_id text,
     note text,
     primary key (subscription_id, ran_at)
   )`,
  // 各域自己的业务字段放 meta JSON，表结构不跟着每个能力域改。
  `alter table jobs add column meta text`,
  `alter table job_items add column meta text`,
  // 跨 id 的"其实已经有了"：标题 + 歌手 + 时长。
  `alter table tracks add column fingerprint text`,
  `create index tracks_fingerprint on tracks (fingerprint)`,
  // jobs.quality 原本 NOT NULL，并不是每个域都有"档位"。SQLite 改约束只能重建表。
  `create table jobs_new (
     id text primary key,
     kind text not null,
     title text not null,
     status text not null,
     quality text,
     total integer not null,
     done integer not null default 0,
     failed integer not null default 0,
     skipped integer not null default 0,
     pid integer,
     error text,
     created_at text not null,
     updated_at text not null,
     meta text
   )`,
  `insert into jobs_new (id, kind, title, status, quality, total, done, failed, skipped, pid, error, created_at, updated_at, meta)
     select id, kind, title, status, quality, total, done, failed, skipped, pid, error, created_at, updated_at, meta from jobs`,
  `drop table jobs`,
  `alter table jobs_new rename to jobs`,
  `create index jobs_created on jobs (created_at desc)`,
  // 写操作审计。
  `create table audit_log (
     id integer primary key autoincrement,
     at text not null,
     action text not null,
     summary text not null,
     ok integer not null,
     error text,
     detail text
   )`,
  `create index audit_at on audit_log (at desc)`,
  `create index audit_action on audit_log (action)`,
  // 任务项状态词统一：done → downloaded。
  `update job_items set status = 'downloaded' where status = 'done'`,
  // B 站订阅的分 P 基线。
  `alter table subscriptions add column audio_only integer not null default 0`,
  `alter table subscriptions add column pages_mode text not null default 'all'`,
  `alter table subscriptions add column seen_pages text not null default '{}'`,
  `alter table subscriptions add column audio_album text`,
  // 同曲多专辑的归属判据（P4#5）。
  `alter table tracks add column album_id text`,
  `alter table tracks add column album_year integer`,
  `alter table tracks add column album_type text`,
  // 自适应间隔（0.40.0）。
  `alter table subscriptions add column base_min integer not null default 0`,
  `alter table subscriptions add column max_min integer not null default 0`,
  `alter table subscriptions add column factor integer not null default 2`,
  `alter table subscriptions add column current_min integer not null default 0`,
  // 账户机制：审计记「谁做的」、任务记归属。
  `alter table audit_log add column principal text`,
  `alter table jobs add column owner text`,
  // 内置调度（0.49.0）。
  `create table schedules (
     name text primary key,
     command text not null,
     interval_min integer not null,
     enabled integer not null default 1,
     owner text,
     last_run_at text,
     next_run_at text,
     last_status text,
     created_at text not null
   )`,
  // 每条订阅自己的选项（0.52.0），存 JSON。
  `alter table subscriptions add column options text`,
  // 0.57.0：JM 本子域从 comic 改名 jm，comic 让给普通漫画。存量的 JM 订阅和任务改标签，
  // 否则 `jm subscribe list` / `jm jobs` 看不到它们，`comic` 域又会把它们当成自己的。
  // 这一步之前 comic 域只有 JM 一家（普通漫画 0.56.0 才出现，那时叫 manga），所以按 domain=comic 改全部是对的；
  // 0.56.0 的 manga 任务一并改成 comic。
  // **一级里三条语句，和 0.57.0 的 core/db.ts 一字不差**：线上老库已经按这个级数记过 user_version，
  // 拆开会让级数错位、改名重跑一遍。执行时由 climbSqliteLadder 按分号拆开。
  `update subscriptions set kind = 'jm-album' where kind = 'comic-album';
   update jobs set meta = json_set(meta, '$.domain', 'jm') where json_extract(meta, '$.domain') = 'comic';
   update jobs set meta = json_set(meta, '$.domain', 'comic') where json_extract(meta, '$.domain') = 'manga'`,
]

/**
 * 阶梯上 0.57.0 JM 改名那一级的下标。user_version = N 表示前 N 级跑过，
 * 所以老库 `user_version <= JM_RENAME_LEVEL` 就说明改名还没跑、数据里的 JM 还叫 comic。
 */
export const JM_RENAME_LEVEL = SQLITE_LADDER.findIndex((stmt) => stmt.includes("'jm-album'"))

/** PG 上的最终形状。和 SQLite 阶梯走到底的结果逐列对齐（`tests/state-schema.test.ts` 比对）。 */
export const POSTGRES_STATE: string[] = [
  `create table if not exists tracks (
     platform text not null,
     native_id text not null,
     title text not null,
     artists text not null,
     album text,
     duration_ms integer,
     file_path text not null,
     format text not null,
     quality text not null,
     bytes bigint,
     bps integer,
     audio_sha256 text,
     source_id text,
     created_at text not null,
     sample_rate integer,
     bits_per_sample integer,
     channels integer,
     has_cover integer,
     has_lyric integer,
     has_word_lyric integer,
     fingerprint text,
     album_id text,
     album_year integer,
     album_type text,
     primary key (platform, native_id)
   )`,
  `create index if not exists tracks_title on tracks (title)`,
  `create index if not exists tracks_spec on tracks (sample_rate, bits_per_sample)`,
  `create index if not exists tracks_fingerprint on tracks (fingerprint)`,
  `create table if not exists jobs (
     id text primary key,
     kind text not null,
     title text not null,
     status text not null,
     quality text,
     total integer not null,
     done integer not null default 0,
     failed integer not null default 0,
     skipped integer not null default 0,
     pid integer,
     error text,
     created_at text not null,
     updated_at text not null,
     meta text,
     owner text
   )`,
  `create index if not exists jobs_created on jobs (created_at desc)`,
  `create table if not exists job_items (
     job_id text not null,
     seq integer not null,
     native_id text not null,
     title text not null,
     artists text not null,
     status text not null,
     quality text,
     file_path text,
     error text,
     updated_at text not null,
     meta text,
     primary key (job_id, seq)
   )`,
  `create table if not exists subscriptions (
     id text primary key,
     kind text not null,
     target_id text not null,
     title text not null,
     quality text,
     every_hours integer not null,
     enabled integer not null default 1,
     last_checked_at text,
     last_seen text,
     last_job_id text,
     created_at text not null,
     audio_only integer not null default 0,
     pages_mode text not null default 'all',
     seen_pages text not null default '{}',
     audio_album text,
     base_min integer not null default 0,
     max_min integer not null default 0,
     factor integer not null default 2,
     current_min integer not null default 0,
     options text,
     unique (kind, target_id)
   )`,
  `create table if not exists subscription_runs (
     subscription_id text not null,
     ran_at text not null,
     new_tracks integer not null,
     job_id text,
     note text,
     primary key (subscription_id, ran_at)
   )`,
  `create table if not exists audit_log (
     id bigserial primary key,
     at text not null,
     action text not null,
     summary text not null,
     ok integer not null,
     error text,
     detail text,
     principal text
   )`,
  `create index if not exists audit_at on audit_log (at desc)`,
  `create index if not exists audit_action on audit_log (action)`,
  `create table if not exists schedules (
     name text primary key,
     command text not null,
     interval_min integer not null,
     enabled integer not null default 1,
     owner text,
     last_run_at text,
     next_run_at text,
     last_status text,
     created_at text not null
   )`,
]

/** 七张状态表，搬数据 / 校验时按这个顺序。 */
export const STATE_TABLES = ['tracks', 'jobs', 'job_items', 'subscriptions', 'subscription_runs', 'audit_log', 'schedules'] as const

/** 每张表的主键（搬数据时 `on conflict do nothing` 用）。audit_log 单独处理。 */
export const STATE_KEYS: Record<(typeof STATE_TABLES)[number], string[]> = {
  tracks: ['platform', 'native_id'],
  jobs: ['id'],
  job_items: ['job_id', 'seq'],
  subscriptions: ['id'],
  subscription_runs: ['subscription_id', 'ran_at'],
  audit_log: ['id'],
  schedules: ['name'],
}

/**
 * SQLite：按 user_version 补阶梯。
 *
 * 整个序列放进一个 `begin immediate`，拿到写锁之后**重读**版本号 —— 两个进程同时启动时
 * （`music get` 和 `bili get` 并行、cron 撞上手动命令），后到的那个阻塞到前一个提交，
 * 再读版本号就已经是最新的。早先版本号在事务外读，实测报 `duplicate column name: channels`。
 */
/** 按「分号 + 换行」拆一级里的多条语句。阶梯里的语句都是手写的，不会在字符串里出现这个组合。 */
export function splitStatements(sql: string): string[] {
  return sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)
}

export async function climbSqliteLadder(conn: Conn): Promise<void> {
  const read = async (c: Conn): Promise<number> =>
    Number((await c.query<{ user_version: number }>('pragma user_version'))[0]?.user_version ?? 0)
  if ((await read(conn)) >= SQLITE_LADDER.length) return
  await conn.tx(async (tx) => {
    const current = await read(tx)
    for (let i = current; i < SQLITE_LADDER.length; i += 1) {
      // 一级可能是几条用分号隔开的语句（0.57.0 那一级）；连接层的 exec 一次只认一条
      for (const stmt of splitStatements(SQLITE_LADDER[i]!)) await tx.exec(stmt)
      await tx.exec(`pragma user_version = ${i + 1}`)
    }
  })
}

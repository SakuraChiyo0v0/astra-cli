/**
 * 本地状态库：`<ASTRA_HOME>/astra.db`（node:sqlite，Node 24 内置）。
 *
 * 只存本工具下载过的东西和后台任务，不扫描整个音乐目录 —— 别的来源的文件混进来会让记录失真。
 */
import { DatabaseSync } from 'node:sqlite'
import { homePath } from './paths.ts'

let instance: DatabaseSync | null = null

const MIGRATIONS: string[] = [
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
  // 老记录这三列为 null，用 `music have --refresh` 回读文件补齐。
  `alter table tracks add column sample_rate integer`,
  `alter table tracks add column bits_per_sample integer`,
  `alter table tracks add column channels integer`,
  `alter table tracks add column has_cover integer`,
  `alter table tracks add column has_lyric integer`,
  `alter table tracks add column has_word_lyric integer`,
  `create index tracks_spec on tracks (sample_rate, bits_per_sample)`,
  // 订阅：定时盯一个歌单 / 专辑 / 歌手，出新歌自动下。last_seen 存上次见到的曲目 id（JSON 数组），
  // 决定"哪些是新歌"。用集合差集而不是日期，因为平台的上架时间不可靠。
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
  // 任务表原本是音乐专用的（quality 列存音质、artists 列存歌手）。
  // B 站也要批量，但它的"业务字段"完全不同（画质 / 分 P / UP 主）。
  // 加一列 meta 存各域自己的 JSON，表结构就不必跟着每个能力域改。
  `alter table jobs add column meta text`,
  `alter table job_items add column meta text`,
  // 同一首歌可能以不同 id 出现（重发版、不同专辑），只认 id 会重下一遍。
  // 指纹 = 标题 + 歌手 + 时长（秒），用于跨 id 的"其实已经有了"判断。
  `alter table tracks add column fingerprint text`,
  `create index tracks_fingerprint on tracks (fingerprint)`,
  // jobs.quality 原本是 NOT NULL，但并不是每个域都有"档位"这个概念
  // （VRChat 这类任务没有音质/画质）。SQLite 不能直接改约束，只能重建表。
  //
  // 注意：domain 不是独立列 —— 它存在 meta JSON 里（`{"domain":"bili"}`），
  // 由 core/jobs.ts 的 toView 读出来，缺省当 music。所以这里不需要保住 domain 列。
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
]

export function db(): DatabaseSync {
  if (instance) return instance
  // timeout 在打开时就生效；写在 pragma 里的 busy_timeout 晚于 journal_mode 切换，
  // 另一个进程（后台 worker）持锁时 `pragma journal_mode = wal` 本身就会直接报 database is locked
  const database = new DatabaseSync(homePath('astra.db'), { timeout: 10_000 })
  database.exec('pragma journal_mode = wal; pragma foreign_keys = on;')
  const version = (database.prepare('pragma user_version').get() as { user_version: number }).user_version
  for (let i = version; i < MIGRATIONS.length; i += 1) {
    database.exec('begin immediate')
    try {
      database.exec(MIGRATIONS[i]!)
      database.exec(`pragma user_version = ${i + 1}`)
      database.exec('commit')
    } catch (err) {
      database.exec('rollback')
      throw err
    }
  }
  instance = database
  return database
}

export function closeDb(): void {
  instance?.close()
  instance = null
}

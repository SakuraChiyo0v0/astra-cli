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

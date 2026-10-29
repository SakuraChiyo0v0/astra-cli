/**
 * 数据库备份 / 恢复 / 逻辑导出。
 *
 * 两种备份，用途不同：
 * - **原生备份**：快，只能同方言恢复（SQLite `VACUUM INTO`、PG `pg_dump -Fc`）
 * - **逻辑导出**：慢，但**跨方言**——这才是 SQLite → PG 的迁移通道
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AstraError } from '../errors.ts'
import type { Database } from './index.ts'
import { SqliteConn } from './sqlite.ts'

/** 参与备份/导出的表。顺序有意义：assets 要在 files 之前。 */
export const TABLES = ['roots', 'assets', 'files', 'events'] as const
export type TableName = (typeof TABLES)[number]

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => resolve({ code: -1, stderr: err.message }))
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }))
  })
}

export interface BackupResult {
  file: string
  bytes: number
  dialect: string
  kind: string
}

/** 原生备份。SQLite 用 VACUUM INTO，PG 用 pg_dump。 */
export async function backupDatabase(
  db: Database,
  options: { dir?: string } = {},
): Promise<BackupResult> {
  const dir = options.dir ?? path.join(process.env.ASTRA_BACKUP_DIR?.trim() || '.', 'db')
  mkdirSync(dir, { recursive: true })

  if (db.dialect.name === 'sqlite') {
    if (!(db.conn instanceof SqliteConn)) {
      throw new AstraError('INTERNAL', 'SQLite 连接类型不对', { exitCode: 1 })
    }
    const file = path.join(dir, `astra-sqlite-${stamp()}.db`)
    db.conn.vacuumInto(file)
    return { file, bytes: statSync(file).size, dialect: 'sqlite', kind: 'vacuum-into' }
  }

  if (db.dialect.name === 'postgres') {
    const file = path.join(dir, `astra-pg-${stamp()}.dump`)
    const url = process.env.ASTRA_DB_URL?.trim()
    if (!url) throw new AstraError('CONFIG', '缺少 ASTRA_DB_URL，无法 pg_dump', { exitCode: 3 })
    const result = await run('pg_dump', ['-Fc', '-f', file, url])
    if (result.code !== 0) {
      throw new AstraError('UPSTREAM', `pg_dump 失败（exit ${result.code}）`, {
        hint: `确认本机装了 pg_dump 且版本 >= 服务端；没有就用 astra db backup --logical（JSON，可跨方言恢复）。${result.stderr.slice(0, 200)}`,
        exitCode: 5,
      })
    }
    return { file, bytes: statSync(file).size, dialect: 'postgres', kind: 'pg-dump' }
  }

  throw new AstraError('CONFIG', `不支持的方言：${db.dialect.name}`, { exitCode: 3 })
}

/** 从原生备份恢复。会覆盖现有库，调用方负责二次确认。 */
export async function restoreDatabase(db: Database, file: string): Promise<void> {
  if (!existsSync(file)) {
    throw new AstraError('NOT_FOUND', `备份文件不存在：${file}`, { exitCode: 4 })
  }

  if (db.dialect.name === 'sqlite') {
    if (!(db.conn instanceof SqliteConn)) throw new AstraError('INTERNAL', '连接类型不对', { exitCode: 1 })
    const target = db.conn.filePath
    await db.conn.close()
    // 直接覆盖主库文件（WAL 文件一并清掉，否则会拿到旧事务）
    const { copyFileSync, rmSync } = await import('node:fs')
    copyFileSync(file, target)
    for (const suffix of ['-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true })
    return
  }

  if (db.dialect.name === 'postgres') {
    const url = process.env.ASTRA_DB_URL?.trim()
    if (!url) throw new AstraError('CONFIG', '缺少 ASTRA_DB_URL', { exitCode: 3 })
    const result = await run('pg_restore', ['--clean', '--if-exists', '-d', url, file])
    if (result.code !== 0) {
      throw new AstraError('UPSTREAM', `pg_restore 失败（exit ${result.code}）`, {
        hint: result.stderr.slice(0, 300),
        exitCode: 5,
      })
    }
    return
  }

  throw new AstraError('CONFIG', `不支持的方言：${db.dialect.name}`, { exitCode: 3 })
}

export interface ExportFile {
  format: 'astra-logical-v1'
  exported_at: string
  dialect: string
  tables: Record<string, Record<string, unknown>[]>
}

/** 逻辑导出：全表转 JSON，可跨方言导入。 */
export async function exportJson(db: Database, file: string): Promise<ExportFile> {
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const table of TABLES) {
    tables[table] = await db.conn.query(`select * from ${table}`)
  }
  const payload: ExportFile = {
    format: 'astra-logical-v1',
    exported_at: new Date().toISOString(),
    dialect: db.dialect.name,
    tables,
  }
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  writeFileSync(file, JSON.stringify(payload, null, 1), 'utf8')
  return payload
}

/** 逻辑导入。`truncate` 为真时先清空目标表（默认不清，靠主键冲突报错提醒）。 */
export async function importJson(
  db: Database,
  file: string,
  options: { truncate?: boolean } = {},
): Promise<{ inserted: Record<string, number> }> {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as ExportFile
  if (raw.format !== 'astra-logical-v1') {
    throw new AstraError('NOT_FOUND', `不是 astra 的逻辑导出文件（format=${String(raw.format)}）`, { exitCode: 4 })
  }

  const inserted: Record<string, number> = {}
  await db.conn.tx(async (tx) => {
    if (options.truncate) {
      for (const table of [...TABLES].reverse()) await tx.exec(`delete from ${table}`)
    }
    for (const table of TABLES) {
      const rows = raw.tables[table] ?? []
      inserted[table] = 0
      for (const row of rows) {
        const cols = Object.keys(row)
        if (cols.length === 0) continue
        const placeholders = cols.map(() => '?').join(', ')
        const sql = `insert into ${table} (${cols.join(', ')}) values (${placeholders})`
        try {
          await tx.exec(sql, cols.map((c) => normalize(row[c])))
          inserted[table] = (inserted[table] ?? 0) + 1
        } catch (err) {
          throw new AstraError('INTERNAL', `导入 ${table} 失败：${(err as Error).message}`, {
            hint: `这一行：${JSON.stringify(row).slice(0, 200)}`,
            exitCode: 1,
          })
        }
      }
    }
    // PostgreSQL 的 bigserial 不会因为「显式插入 id」自动前进 ——
    // 不重置序列，导入后第一次 insert 就撞 events_pkey（实测踩到）。
    if (db.dialect.name === 'postgres') {
      for (const table of TABLES) {
        try {
          await tx.exec(`select setval(pg_get_serial_sequence('${table}', 'id'), coalesce((select max(id) from ${table}), 1))`)
        } catch {
          // 没有 serial 列的表（roots/assets/files 的 id 是 text）直接跳过
        }
      }
    }
  })
  return { inserted }
}

/** jsonb 列在 SQLite 是 text、PG 里要给对象/字符串都行；这里统一成可绑定的值。 */
function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}

export interface DoctorReport {
  dialect: string
  url: string
  ping: boolean
  tables: Record<string, number>
  orphanFiles: number
  missingRoots: number
  duplicateHashes: number
}

/** 体检：连通性、行数、孤儿记录、重复内容。 */
export async function doctor(db: Database): Promise<DoctorReport> {
  const tables: Record<string, number> = {}
  for (const table of TABLES) {
    try {
      const rows = await db.conn.query<{ n: number | string }>(`select count(*) as n from ${table}`)
      tables[table] = Number(rows[0]?.n ?? 0)
    } catch {
      tables[table] = -1 // 表还没建
    }
  }

  const orphanFiles = tables.files && tables.files > 0
    ? Number((await db.conn.query<{ n: number | string }>(
        'select count(*) as n from files f left join assets a on a.id = f.asset_id where a.id is null',
      ))[0]?.n ?? 0)
    : 0

  const missingRoots = tables.files && tables.files > 0
    ? Number((await db.conn.query<{ n: number | string }>(
        'select count(*) as n from files f left join roots r on r.id = f.root_id where r.id is null',
      ))[0]?.n ?? 0)
    : 0

  const duplicateHashes = tables.files && tables.files > 0
    ? Number((await db.conn.query<{ n: number | string }>(
        `select count(*) as n from (
           select hash from files where hash is not null group by hash having count(*) > 1
         ) t`,
      ))[0]?.n ?? 0)
    : 0

  return {
    dialect: db.dialect.name,
    url: db.url,
    ping: await db.conn.ping(),
    tables,
    orphanFiles,
    missingRoots,
    duplicateHashes,
  }
}

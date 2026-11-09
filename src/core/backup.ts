/**
 * 状态备份。
 *
 * 要备份的东西分两类：
 * - **`astra.db`**：曲库（下载过什么、什么规格、在哪）与任务历史。丢了就得重新扫盘或重下
 * - **会话文件**：`netease-session.json` / `bili-session.json` / `vr-session.json`。丢了要重新扫码/输密码
 *
 * 刻意**不备份**：音乐/视频文件本身（太大，它们才是备份的主体，用别的方式做）、
 * 音源脚本（用户自己提供的，重新导入即可）、日志。
 *
 * 备份产物是一个目录，里面是数据库快照（用 SQLite 自己的 VACUUM INTO，能拿到一致快照，
 * 不会因为那一刻有写入而损坏）+ 会话文件的拷贝。会话文件权限强制 600。
 *
 * ## 为什么用 VACUUM INTO 而不是复制文件
 *
 * `astra.db` 是 WAL 模式，直接复制 `.db` 可能拿到不含最新事务的旧数据（WAL 还没 checkpoint）。
 * `VACUUM INTO` 由 SQLite 自己保证快照一致。
 *
 * ## 0.58.0：状态库可能是 PG
 *
 * 状态表并进了资产库那个库。配了 `db-url`（PG）时本机已经没有 `astra.db` 需要快照，
 * 这里只备会话文件，数据库请用 `astra db backup`（pg_dump）—— 结果里 `database` 字段说明走了哪条路。
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { closeState, num, one, stateDb } from './state.ts'
import { SqliteConn } from './db/sqlite.ts'
import { homePath } from './paths.ts'
import { AstraError } from './errors.ts'

const SESSION_FILES = ['netease-session.json', 'bili-session.json', 'vr-session.json'] as const

export interface BackupResult {
  dir: string
  /** 备份里都有哪些文件，及其大小。 */
  files: { name: string; bytes: number }[]
  totalBytes: number
  /** 会话文件里有几个被拷进去了。 */
  sessionCount: number
  /** 有没有备份到数据库。没下过东西时本来就没有库，属正常。 */
  hasDatabase: boolean
  /** 数据库走的哪条路：`sqlite` = 快照进了这个目录；`postgres` = 不在这里，用 `astra db backup`。 */
  database: 'sqlite' | 'postgres'
}

function stamp(): string {
  // 2026-10-21T18-45-00：冒号在部分文件系统上不合法，用连字符
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/**
 * 做一次备份。返回备份目录。
 *
 * `targetRoot` 默认 `<ASTRA_HOME>/backups`；建议配成音乐目录之外的独立盘。
 */
export async function backup(targetRoot?: string, options: { keep?: number } = {}): Promise<BackupResult> {
  const root = targetRoot ?? (process.env.ASTRA_BACKUP_DIR?.trim() || homePath('backups'))
  const dir = path.join(root, `astra-${stamp()}`)
  mkdirSync(dir, { recursive: true })

  const files: BackupResult['files'] = []

  // 数据库：交给 SQLite 自己生成一致快照。
  // 注意：从没下载过东西时库里没有 astra.db（表是在第一次写数据时才建的），
  // 这种情况下只备份到会话是正常的，返回 hasDatabase: false 让调用方说清楚。
  const current = await stateDb()
  const database: BackupResult['database'] = current.dialect.name === 'postgres' ? 'postgres' : 'sqlite'
  let hasDatabase = false
  if (current.conn instanceof SqliteConn && existsSync(current.conn.filePath)) {
    hasDatabase = true
    const target = path.join(dir, 'astra.db')
    // VACUUM INTO 要求目标不存在
    rmSync(target, { force: true })
    current.conn.vacuumInto(target)
    files.push({ name: 'astra.db', bytes: statSync(target).size })
  }

  // 会话：权限强制 600，它们里面有 cookie
  let sessionCount = 0
  for (const name of SESSION_FILES) {
    const source = homePath(name)
    if (!existsSync(source)) continue
    const target = path.join(dir, name)
    copyFileSync(source, target)
    chmodSync(target, 0o600)
    files.push({ name, bytes: statSync(target).size })
    sessionCount += 1
  }

  // 只留最近 N 份，多的删掉（默认 7）
  const keep = options.keep ?? 7
  const all = readdirSync(root)
    .filter((n) => n.startsWith('astra-'))
    .sort()
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    rmSync(path.join(root, old), { recursive: true, force: true })
  }

  return {
    dir,
    files,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
    sessionCount,
    hasDatabase,
    database,
  }
}

/** 列出已有备份（新的在前）。 */
export function listBackups(targetRoot?: string): { dir: string; name: string; bytes: number; createdAt: string }[] {
  const root = targetRoot ?? (process.env.ASTRA_BACKUP_DIR?.trim() || homePath('backups'))
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((n) => n.startsWith('astra-'))
    .sort()
    .reverse()
    .map((name) => {
      const dir = path.join(root, name)
      let bytes = 0
      const files = readdirSync(dir)
      for (const f of files) {
        try {
          bytes += statSync(path.join(dir, f)).size
        } catch {
          // 单个文件读不到就算了
        }
      }
      return { dir, name, bytes, createdAt: statSync(dir).mtime.toISOString() }
    })
}

/**
 * 从备份恢复数据库。
 *
 * **危险操作**：会覆盖当前曲库。所以调用方必须先确认，且本函数自己会先把当前库改名保留
 * （`.replaced-<时间戳>`），不做不可逆的事。
 *
 * 只在没有任务在跑时调用 —— 跑到一半的任务会写不上库。
 */
export async function restore(backupDir: string): Promise<{ restored: string; previousKept: string | null }> {
  const source = path.join(backupDir, 'astra.db')
  if (!existsSync(source)) throw new AstraError('BACKUP_NO_DB', `备份里没有 astra.db：${backupDir}`, { exitCode: 4 })
  const current = await stateDb()
  if (!(current.conn instanceof SqliteConn)) {
    throw new AstraError('BACKUP_WRONG_DB', '当前状态库是 PostgreSQL，SQLite 快照不能直接覆盖回去', {
      exitCode: 2,
      hint: '用 `astra db import-state --from <备份目录>/astra.db` 把快照里的数据导进当前库',
    })
  }

  const running = num((await one<{ n: number }>("select count(*) n from jobs where status in ('running','queued')"))?.n)
  if (running > 0) {
    throw new AstraError('JOBS_RUNNING', `还有 ${running} 个任务在跑，不能现在恢复`, {
      exitCode: 2,
      hint: '等任务结束后再试，或用 `astra jobs --active` 看看是哪些',
    })
  }

  const target = current.conn.filePath
  // 先关掉自己的连接：开着的连接还挂着 WAL，覆盖主文件后旧 WAL 会被回放进新库
  await closeState()
  for (const suffix of ['-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true })
  let previousKept: string | null = null
  if (existsSync(target)) {
    previousKept = `${target}.replaced-${stamp()}`
    copyFileSync(target, previousKept)
  }
  copyFileSync(source, target)
  return { restored: target, previousKept }
}

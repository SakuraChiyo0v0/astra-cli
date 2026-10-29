/**
 * `astra db …` —— 数据库运维命令。
 *
 * 分工：
 * - `db ping` / `db status` / `db doctor`：只读，安全
 * - `db migrate`：建表/升级，`--dry-run` 只看不干
 * - `db backup` / `db export`：产出文件
 * - `db restore` / `db import`：会覆盖数据，走二次确认令牌
 */
import path from 'node:path'
import { invalidInput } from '../errors.ts'
import { consume, prepare } from '../confirm.ts'
import type { Command } from '../command.ts'
import { openDatabase, redact, dbUrl, saveDbUrl, clearDbUrl } from './index.ts'
import { appliedMigrations, MIGRATIONS, migrate } from './migrations.ts'
import { backupDatabase, doctor, exportJson, importJson, restoreDatabase } from './backup.ts'

const PURPOSE = 'db'

export const dbCommands: Command[] = [
  {
    name: 'db ping',
    summary: '检查数据库连通性',
    usage: 'astra db ping',
    notes: ['不设 ASTRA_DB_URL 时查的是本机 SQLite（<ASTRA_HOME>/astra.db）'],
    async run() {
      const db = await openDatabase()
      try {
        const started = Date.now()
        const ok = await db.conn.ping()
        return {
          data: {
            ok,
            dialect: db.dialect.label,
            url: redact(db.url),
            latencyMs: Date.now() - started,
          },
        }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'db status',
    summary: '看迁移状态（已应用 / 待应用）',
    usage: 'astra db status',
    async run() {
      const db = await openDatabase()
      try {
        const done = await appliedMigrations(db)
        const doneIds = new Set(done.map((d) => d.id))
        return {
          data: {
            dialect: db.dialect.name,
            url: redact(db.url),
            applied: done.map((d) => ({ id: d.id, applied_at: d.applied_at })),
            pending: MIGRATIONS.filter((m) => !doneIds.has(m.id)).map((m) => ({ id: m.id, summary: m.summary })),
            upToDate: done.length >= MIGRATIONS.length,
          },
        }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'db migrate',
    summary: '执行待应用的迁移（建表/加列）',
    usage: 'astra db migrate [--dry-run]',
    options: {
      'dry-run': { type: 'boolean', description: '只报告会执行哪些迁移，不落库' },
    },
    notes: [
      '不会自动执行：启动时只提示有待应用的迁移',
      '已应用的迁移 SQL 被改动会直接报错（checksum 校验）',
    ],
    async run({ values }) {
      const db = await openDatabase()
      try {
        const result = await migrate(db, { dryRun: values['dry-run'] === true })
        return { data: { ...result, url: redact(db.url) } }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'db backup',
    summary: '原生备份数据库（SQLite: VACUUM INTO / PG: pg_dump）',
    usage: 'astra db backup [--dir <目录>] [--logical]',
    options: {
      dir: { type: 'string', valueName: '目录', description: '备份输出目录，默认 $ASTRA_BACKUP_DIR/db 或 ./db' },
      logical: { type: 'boolean', description: '用逻辑导出（JSON）代替原生备份，跨方言可恢复' },
    },
    notes: ['PG 原生备份需要本机有 pg_dump；没有就用 --logical（JSON，任何方言都能导回去）'],
    async run({ values }) {
      const db = await openDatabase()
      try {
        const dir = typeof values.dir === 'string' ? values.dir : undefined
        const outDir = dir ? path.resolve(dir) : path.resolve('db')
        if (values.logical === true) {
          const { mkdirSync } = await import('node:fs')
          mkdirSync(outDir, { recursive: true })
          const file = path.join(outDir, `astra-logical-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
          const payload = await exportJson(db, file)
          return {
            data: {
              file,
              dialect: db.dialect.name,
              kind: 'logical-json',
              rows: Object.fromEntries(Object.entries(payload.tables).map(([k, v]) => [k, v.length])),
            },
          }
        }
        const result = await backupDatabase(db, { dir: outDir })
        return { data: result }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'db export',
    summary: '逻辑导出（JSON，可跨方言导入）',
    usage: 'astra db export [--out <文件>]',
    options: {
      out: { type: 'string', valueName: '文件', description: '输出路径，默认 ./astra-export-<时间>.json' },
    },
    notes: ['SQLite → PostgreSQL 迁移就用它：export 之后 import 到新库'],
    async run({ values }) {
      const db = await openDatabase()
      try {
        const out = typeof values.out === 'string'
          ? path.resolve(values.out)
          : path.resolve(`astra-export-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
        const payload = await exportJson(db, out)
        return {
          data: {
            file: out,
            dialect: db.dialect.name,
            rows: Object.fromEntries(Object.entries(payload.tables).map(([k, v]) => [k, v.length])),
          },
        }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'db import',
    summary: '逻辑导入（JSON），会覆盖同名主键',
    usage: 'astra db import <文件> [--truncate] [--token <令牌>]',
    options: {
      truncate: { type: 'boolean', description: '导入前清空目标表（需要二次确认）' },
      token: { type: 'string', valueName: '令牌', description: '第一次不传，拿预览和令牌；带令牌再调一次才执行' },
    },
    minArgs: 1,
    maxArgs: 1,
    async run({ positionals, values }) {
      const file = path.resolve(positionals[0]!)
      const truncate = values.truncate === true
      const db = await openDatabase()
      try {
        if (truncate) {
          const token = typeof values.token === 'string' ? values.token : undefined
          if (!token) {
            return {
              data: prepare(PURPOSE, 'db.import', { file, truncate }, { file, truncate, url: redact(db.url) }, '这会清空目标库的表再导入，确认后带 --token 重跑'),
            }
          }
          consume(PURPOSE, token, 'db.import')
        }
        const result = await importJson(db, file, { truncate })
        return { data: { file, truncate, ...result, url: redact(db.url) } }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'db restore',
    summary: '从原生备份恢复（覆盖当前库）',
    usage: 'astra db restore <备份文件> [--token <令牌>]',
    options: {
      token: { type: 'string', valueName: '令牌', description: '第一次不传，拿预览和令牌；带令牌再调一次才执行' },
    },
    minArgs: 1,
    maxArgs: 1,
    notes: ['会覆盖当前数据库。SQLite 直接替换文件，PG 用 pg_restore --clean'],
    async run({ positionals, values }) {
      const file = path.resolve(positionals[0]!)
      const db = await openDatabase()
      try {
        const token = typeof values.token === 'string' ? values.token : undefined
        if (!token) {
          return {
            data: prepare(PURPOSE, 'db.restore', { file }, { file, url: redact(db.url), dialect: db.dialect.name }, '这会覆盖当前数据库，确认后带 --token 重跑'),
          }
        }
        consume(PURPOSE, token, 'db.restore')
        await restoreDatabase(db, file)
        return { data: { restored: file, dialect: db.dialect.name, url: redact(db.url) } }
      } finally {
        await db.conn.close().catch(() => {})
      }
    },
  },
  {
    name: 'db query',
    summary: '执行自定义 SQL（默认只读，写操作要显式 --write）',
    usage: 'astra db query "<sql>" [--limit <行数>] [--param 值 ...] [--write]',
    options: {
      limit: { type: 'string', valueName: '行数', description: '最多返回多少行，默认 100，上限 1000' },
      param: { type: 'string', valueName: '值', multiple: true, description: '位置参数，可重复：--param a --param b 对应 ? 占位符' },
      write: { type: 'boolean', description: '允许 insert/update/delete 等写语句（默认拒绝）' },
    },
    notes: [
      '默认只允许 select / with / explain / pragma，其他语句一律拒绝，防止手滑改库',
      'select 没写 limit 时会自动补上 --limit，返回 truncated=true 说明还有更多行',
      '占位符统一写 ?，PG 的 $1 由适配层自动转换',
      '改库前先 astra db backup --logical 做一份备份',
    ],
    minArgs: 1,
    async run({ positionals, values }) {
      const sql = positionals.join(' ').trim().replace(/;\s*$/, '')
      const limit = Math.min(Math.max(Number(values.limit ?? 100) || 100, 1), 1000)
      const allowWrite = values.write === true
      const params: unknown[] = []
      if (typeof values.param === 'string') params.push(values.param)
      else if (Array.isArray(values.param)) params.push(...(values.param as string[]))

      const head = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/g, '').split(/\s+/)[0]!.toLowerCase()
      const readonly = ['select', 'with', 'explain', 'pragma', 'show'].includes(head)
      if (!readonly && !allowWrite) {
        throw invalidInput(
          '这条语句会改数据或结构，确认后加 --write 再跑',
          `检测到语句类型：${head || '未知'}。只读查询用 select / with`,
        )
      }

      const db = await openDatabase()
      try {
        const started = Date.now()
        if (!readonly) {
          const changes = await db.conn.exec(sql, params)
          return { data: { statement: head, changes, durationMs: Date.now() - started, url: redact(db.url) } }
        }
        // 只读：没写 limit 就补一个，避免一条 select 把整表喷到终端
        const limited = /\blimit\s+\d+/i.test(sql) ? sql : `${sql} limit ${limit}`
        const rows = await db.conn.query<Record<string, unknown>>(limited, params)
        const columns = rows.length > 0 ? Object.keys(rows[0]!) : []
        return {
          data: {
            columns,
            rowCount: rows.length,
            truncated: rows.length >= limit,
            durationMs: Date.now() - started,
            rows,
            url: redact(db.url),
          },
          table: {
            headers: columns,
            rows: rows.map((r) => columns.map((c) => {
              const v = r[c]
              if (v === null || v === undefined) return 'null'
              return typeof v === 'object' ? JSON.stringify(v) : String(v)
            })),
          },
        }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'db doctor',
    summary: '体检：连通性、各表行数、孤儿记录、重复内容',
    usage: 'astra db doctor',
    notes: ['orphanFiles > 0 说明 files 指向了不存在的 asset；duplicateHashes > 0 说明同一内容有多份副本'],
    async run() {
      const db = await openDatabase()
      try {
        return { data: await doctor(db) }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'db url',
    summary: '显示当前用的数据库连接串（密码已打码）',
    usage: 'astra db url',
    async run() {
      const raw = dbUrl()
      const fromEnv = Boolean(process.env.ASTRA_DB_URL?.trim())
      return {
        data: {
          url: redact(raw),
          fromEnv,
          fromFile: !fromEnv && raw !== `sqlite:${process.env.ASTRA_HOME ?? ''}/astra.db`,
          dialect: raw.startsWith('postgres') ? 'postgres' : raw.startsWith('mysql') ? 'mysql' : 'sqlite',
        },
      }
    },
  },
  {
    name: 'db use',
    summary: '切换数据库：写进 <ASTRA_HOME>/db-url（600 权限），不用改环境变量',
    usage: 'astra db use <连接串> | astra db use --sqlite',
    options: {
      sqlite: { type: 'boolean', description: '回到本机 SQLite（删掉 db-url 文件）' },
    },
    maxArgs: 1,
    notes: [
      '会先 ping 一次，连不上就不写，避免把 CLI 切到一个坏库上',
      '切过去之后别忘了 astra db migrate（新库还没有表）',
      '环境变量 ASTRA_DB_URL 优先级更高；临时测试请用环境变量，别写文件',
    ],
    async run({ positionals, values }) {
      if (values.sqlite === true) {
        const removed = clearDbUrl()
        return { data: { switched: false, sqlite: true, removedFile: removed, url: redact(dbUrl()) } }
      }
      const target = positionals[0]
      if (!target) throw invalidInput('缺少连接串', '用法：astra db use postgres://user:pass@host:5432/astra')
      const db = await openDatabase(target)
      try {
        const ok = await db.conn.ping()
        if (!ok) throw new Error('ping 失败')
        saveDbUrl(target)
        return { data: { switched: true, dialect: db.dialect.name, url: redact(target), next: 'astra db migrate' } }
      } finally {
        await db.conn.close()
      }
    },
  },
]

/** 启动时用：有待应用的迁移就提示一句（不自动执行）。 */
export async function migrationHint(): Promise<string | null> {
  try {
    const db = await openDatabase()
    try {
      const done = await appliedMigrations(db)
      const pending = MIGRATIONS.length - done.length
      return pending > 0 ? `数据库有 ${pending} 个待应用的迁移，跑 astra db migrate` : null
    } finally {
      await db.conn.close()
    }
  } catch (err) {
    return `数据库连不上：${(err as Error).message}`
  }
}

export function assertKnownDialect(name: string): void {
  if (!['postgres', 'sqlite', 'mysql'].includes(name)) throw invalidInput(`不支持的方言：${name}`)
}

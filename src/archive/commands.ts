/**
 * `astra archive sync`：把 Hermes 会话增量写进当前数据库。
 *
 * 给定时任务用。Hermes 每天已经把 state.db 导出成文件；这条命令读的是
 * state.db 本身，所以不必等那次导出，新消息进来后再跑就会补上。
 */
import { existsSync } from 'node:fs'
import { AstraError } from '../core/errors.ts'
import type { Command } from '../core/command.ts'
import { openDatabase, redact } from '../core/db/index.ts'
import { appliedMigrations, MIGRATIONS } from '../core/db/migrations.ts'
import { syncArchive } from './sync.ts'

function statePath(explicit: string | undefined): string {
  if (explicit && explicit.trim() !== '') return explicit
  if (process.env.HERMES_STATE_DB && process.env.HERMES_STATE_DB.trim() !== '') return process.env.HERMES_STATE_DB
  return '/opt/data/state.db'
}

function docsDir(explicit: string | undefined): string | undefined {
  if (explicit && explicit.trim() !== '') return explicit
  const candidates = [
    process.env.ASTRA_ARCHIVE_DOCS,
    '/opt/data/文档/AI绘图',
  ].filter((item): item is string => Boolean(item && item.trim() !== ''))
  return candidates.find((dir) => existsSync(dir))
}

export const archiveCommands: Command[] = [
  {
    name: 'archive sync',
    summary: '把 Hermes 会话增量写入当前数据库',
    usage: 'astra archive sync [--state <state.db>] [--docs <目录>]',
    options: {
      state: { type: 'string', valueName: '路径', description: 'Hermes 的 state.db，默认 /opt/data/state.db 或 HERMES_STATE_DB' },
      docs: { type: 'string', valueName: '目录', description: '绘画清单目录，默认 /opt/data/文档/AI绘图' },
    },
    notes: [
      '写入 hermes.sessions / hermes.messages（SQLite 上是 hermes_* 表），不碰资产表',
      '消息条数和最大 id 都没变的会话会跳过，适合 cron 反复跑',
      '先 astra db migrate，缺会话表迁移时会拒绝写入',
    ],
    async run({ values }) {
      const db = await openDatabase()
      try {
        const ARCHIVE_MIGRATION = 'astra_0006_hermes_archive'
        const done = await appliedMigrations(db).catch(() => [])
        if (!done.some((item) => item.id === ARCHIVE_MIGRATION)) {
          const pending = MIGRATIONS.some((item) => item.id === ARCHIVE_MIGRATION)
          throw new AstraError('CONFIG', '会话存档表还没建好', {
            exitCode: 3,
            hint: pending ? '先跑 astra db migrate' : '当前 astra 版本没有会话存档迁移',
          })
        }
        const state = statePath(typeof values.state === 'string' ? values.state : undefined)
        const docs = docsDir(typeof values.docs === 'string' ? values.docs : undefined)
        const result = await syncArchive(db, { statePath: state, ...(docs ? { docsDir: docs } : {}) })
        return { data: { ...result, url: redact(db.url), state } }
      } finally {
        await db.conn.close()
      }
    },
  },
]

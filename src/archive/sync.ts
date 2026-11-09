/**
 * 把 Hermes 的 `state.db` 增量写进 astra 正在用的数据库。
 *
 * 和资产表分开：PostgreSQL 写 `hermes.*`，SQLite 写 `hermes_*`。
 * 一个会话的消息条数和最大 id 都没变就跳过，所以定时跑是便宜的。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AstraError } from '../core/errors.ts'
import type { Database } from '../core/db/index.ts'
import type { DialectName } from '../core/db/adapter.ts'

export interface ArchiveTables {
  sessions: string
  messages: string
  documents: string
}

export function archiveTables(dialect: DialectName): ArchiveTables {
  if (dialect === 'postgres') {
    return { sessions: 'hermes.sessions', messages: 'hermes.messages', documents: 'hermes.documents' }
  }
  return { sessions: 'hermes_sessions', messages: 'hermes_messages', documents: 'hermes_documents' }
}

/** Hermes 的时间戳有时是秒、有时是毫秒、有时是 ISO 字符串。 */
export function toIso(value: unknown): string | null {
  if (value == null || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  if (Number.isFinite(num) && String(value).trim() !== '') {
    const ms = num > 1e12 ? num : num * 1000
    return new Date(ms).toISOString()
  }
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export interface SyncResult {
  sessions: number
  written: number
  unchanged: number
  messages: number
  documents: number
}

interface SourceSession {
  id: string
  title: string | null
  started_at: unknown
  last_activity_at: unknown
  message_count: number | null
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  source: string | null
  chat_id: string | null
  chat_type: string | null
  archived: number | null
}

interface SourceMessage {
  id: number
  role: string | null
  content: string | null
  tool_name: string | null
  tool_calls: string | null
  timestamp: unknown
  token_count: number | null
}

function openSource(file: string): DatabaseSync {
  if (!existsSync(file)) {
    throw new AstraError('CONFIG', `找不到 Hermes 会话库：${file}`, {
      exitCode: 3,
      hint: '在 Hermes 容器里默认是 /opt/data/state.db，也可以用 --state 指定',
    })
  }
  return new DatabaseSync(file, { readOnly: true })
}

export async function syncArchive(
  db: Database,
  options: { statePath: string; docsDir?: string },
): Promise<SyncResult> {
  const tables = archiveTables(db.dialect.name)
  const src = openSource(options.statePath)
  const result: SyncResult = {
    sessions: 0, written: 0, unchanged: 0, messages: 0, documents: 0,
  }
  try {
    const sessions = src.prepare(
      `select id, title, started_at, last_activity_at, message_count, model,
              input_tokens, output_tokens, source, chat_id, chat_type, archived
       from sessions`,
    ).all() as unknown as SourceSession[]

    for (const session of sessions) {
      const stamp = src.prepare(
        'select count(*) as n, max(id) as max_id from messages where session_id = ?',
      ).get(session.id) as { n: number; max_id: number | null }
      result.sessions += 1

      const existing = await db.conn.query<{ n: number | string; max_id: number | string | null }>(
        `select count(*) as n, max(msg_id) as max_id from ${tables.messages} where session_id = ?`,
        [session.id],
      )
      const have = Number(existing[0]?.n ?? 0)
      const haveMax = existing[0]?.max_id == null ? null : Number(existing[0].max_id)
      const same = have === Number(stamp.n) && haveMax === (stamp.max_id == null ? null : Number(stamp.max_id))

      let wrote = false
      await db.conn.tx(async (tx) => {
        await tx.exec(
          `insert into ${tables.sessions} (
             id, title, started_at, last_activity_at, message_count, model,
             input_tokens, output_tokens, source, chat_id, chat_type, archived, imported_at
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict (id) do update set
             title = excluded.title,
             started_at = excluded.started_at,
             last_activity_at = excluded.last_activity_at,
             message_count = excluded.message_count,
             model = excluded.model,
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             source = excluded.source,
             chat_id = excluded.chat_id,
             chat_type = excluded.chat_type,
             archived = excluded.archived,
             imported_at = excluded.imported_at`,
          [
            session.id,
            session.title,
            toIso(session.started_at),
            toIso(session.last_activity_at),
            session.message_count,
            session.model,
            session.input_tokens,
            session.output_tokens,
            session.source,
            session.chat_id,
            session.chat_type,
            db.dialect.name === 'postgres' ? Boolean(session.archived) : (session.archived ? 1 : 0),
            new Date().toISOString(),
          ],
        )
        if (same) return
        await tx.exec(`delete from ${tables.messages} where session_id = ?`, [session.id])
        const rows = src.prepare(
          `select id, role, content, tool_name, tool_calls, timestamp, token_count
           from messages where session_id = ? order by id`,
        ).all(session.id) as unknown as SourceMessage[]
        for (const row of rows) {
          await tx.exec(
            `insert into ${tables.messages}
               (session_id, msg_id, role, content, tool_name, tool_calls, ts, token_count)
             values (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              session.id,
              row.id,
              row.role,
              row.content,
              row.tool_name,
              row.tool_calls,
              toIso(row.timestamp) ?? (row.timestamp == null ? null : String(row.timestamp)),
              row.token_count,
            ],
          )
        }
        wrote = true
        result.messages += rows.length
      })
      if (wrote) result.written += 1
      if (same) result.unchanged += 1
    }
  } finally {
    src.close()
  }

  if (options.docsDir && existsSync(options.docsDir) && statSync(options.docsDir).isDirectory()) {
    for (const name of readdirSync(options.docsDir)) {
      const file = path.join(options.docsDir, name)
      if (!statSync(file).isFile()) continue
      const body = readFileSync(file, 'utf8')
      await db.conn.exec(
        `insert into ${tables.documents} (path, title, body, imported_at) values (?, ?, ?, ?)
         on conflict (path) do update set title = excluded.title, body = excluded.body, imported_at = excluded.imported_at`,
        [`文档/AI绘图/${name}`, name, body, new Date().toISOString()],
      )
      result.documents += 1
    }
  }
  return result
}

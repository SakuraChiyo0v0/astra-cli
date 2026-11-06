/**
 * 账户存储（M1）：主体 + 令牌。
 *
 * 存哪：走 `core/db` 的抽象层 —— 配了 PG 就在 PG（多 bot 共享），
 * 没配就落本机 SQLite（`<ASTRA_HOME>/astra.db`），不另建一套连接。
 *
 * 表名不带 schema（`astra_principal` / `astra_token`），PG 与 SQLite 都能跑。
 * 令牌**只存 sha256**，明文只在创建时返回一次。
 */
import { randomUUID } from 'node:crypto'
import { openDatabase, type Database } from './db/index.ts'
import { hashToken, newToken, type PrincipalKind } from './identity.ts'
import { AstraError, invalidInput } from './errors.ts'

export interface Principal {
  id: string
  kind: PrincipalKind
  name: string
  status: string
  note: string | null
  createdAt: string
}

export interface TokenRow {
  id: string
  principalId: string
  label: string | null
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

const SCHEMA = [
  `create table if not exists astra_principal (
     id text primary key,
     kind text not null,
     name text not null unique,
     status text not null default 'active',
     note text,
     created_at text not null
   )`,
  `create table if not exists astra_token (
     id text primary key,
     principal_id text not null,
     token_hash text not null unique,
     label text,
     created_at text not null,
     last_used_at text,
     expires_at text,
     revoked_at text
   )`,
]

/** 打开库并确保表在。调用方负责 `close()`。 */
export async function openAuth(): Promise<Database> {
  const db = await openDatabase()
  for (const sql of SCHEMA) await db.conn.exec(sql)
  await ensureOwner(db)
  return db
}

/** 本机使用者主体，固定 id `owner`。 */
async function ensureOwner(db: Database): Promise<void> {
  await db.conn.exec(
    `insert into astra_principal (id, kind, name, status, note, created_at)
     values (?, 'owner', 'owner', 'active', '本机使用者（无令牌时的默认身份）', ?)
     on conflict (id) do nothing`,
    ['owner', new Date().toISOString()],
  )
}

function principalFrom(row: Record<string, unknown>): Principal {
  return {
    id: String(row.id),
    kind: String(row.kind) as PrincipalKind,
    name: String(row.name),
    status: String(row.status),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    createdAt: String(row.created_at),
  }
}

function tokenFrom(row: Record<string, unknown>): TokenRow {
  const opt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
  return {
    id: String(row.id),
    principalId: String(row.principal_id),
    label: opt(row.label),
    createdAt: String(row.created_at),
    lastUsedAt: opt(row.last_used_at),
    expiresAt: opt(row.expires_at),
    revokedAt: opt(row.revoked_at),
  }
}

export async function listPrincipals(db: Database): Promise<Principal[]> {
  const rows = await db.conn.query('select * from astra_principal order by created_at')
  return rows.map(principalFrom)
}

export async function findPrincipal(db: Database, name: string): Promise<Principal | null> {
  const rows = await db.conn.query('select * from astra_principal where name = ? or id = ?', [name, name])
  return rows[0] ? principalFrom(rows[0]) : null
}

export async function addPrincipal(
  db: Database,
  input: { name: string; kind: PrincipalKind; note?: string },
): Promise<Principal> {
  const name = input.name.trim()
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(name)) {
    throw invalidInput(`主体名不合法：${name}`, '小写字母/数字/下划线，2–32 位，例如 social-bot')
  }
  if (await findPrincipal(db, name)) throw invalidInput(`主体已存在：${name}`, '用 `astra auth principal list` 看现有主体')
  const row: Principal = {
    id: randomUUID(),
    kind: input.kind,
    name,
    status: 'active',
    note: input.note ?? null,
    createdAt: new Date().toISOString(),
  }
  await db.conn.exec(
    `insert into astra_principal (id, kind, name, status, note, created_at) values (?, ?, ?, ?, ?, ?)`,
    [row.id, row.kind, row.name, row.status, row.note, row.createdAt],
  )
  return row
}

/** 给主体发一个令牌。**明文只在这里出现一次**。 */
export async function createToken(
  db: Database,
  input: { principal: string; label?: string; days?: number },
): Promise<{ token: string; row: TokenRow; principal: Principal }> {
  const principal = await findPrincipal(db, input.principal)
  if (!principal) throw new AstraError('NOT_FOUND', `主体不存在：${input.principal}`, { hint: '先 `astra auth principal add <名字> --kind bot`' })

  const days = input.days ?? 0
  if (!Number.isFinite(days) || days < 0 || days > 3650) {
    throw invalidInput('--days 取值 0–3650（0 表示不过期）', '例如 `--days 90`')
  }
  const token = newToken()
  const now = new Date()
  const expiresAt = days > 0 ? new Date(now.getTime() + days * 86_400_000).toISOString() : null
  const row: TokenRow = {
    id: randomUUID().slice(0, 8),
    principalId: principal.id,
    label: input.label ?? null,
    createdAt: now.toISOString(),
    lastUsedAt: null,
    expiresAt,
    revokedAt: null,
  }
  await db.conn.exec(
    `insert into astra_token (id, principal_id, token_hash, label, created_at, expires_at)
     values (?, ?, ?, ?, ?, ?)`,
    [row.id, row.principalId, hashToken(token), row.label, row.createdAt, row.expiresAt],
  )
  return { token, row, principal }
}

/** 令牌 → 主体。过期的、被吊销的、主体停用的一律当无效。 */
export async function resolveToken(
  db: Database,
  token: string,
): Promise<{ principal: Principal; tokenId: string } | null> {
  const rows = await db.conn.query(
    `select t.id token_id, t.expires_at, t.revoked_at, p.*
     from astra_token t join astra_principal p on p.id = t.principal_id
     where t.token_hash = ?`,
    [hashToken(token)],
  )
  const row = rows[0]
  if (!row) return null
  if (row.revoked_at) return null
  if (row.expires_at && String(row.expires_at) < new Date().toISOString()) return null
  if (String(row.status) !== 'active') return null
  const tokenId = String(row.token_id)
  await db.conn.exec('update astra_token set last_used_at = ? where id = ?', [new Date().toISOString(), tokenId])
  return { principal: principalFrom(row), tokenId }
}

export async function listTokens(db: Database, principalName?: string): Promise<Array<TokenRow & { principal: string }>> {
  const sql = `select t.*, p.name principal_name from astra_token t
               join astra_principal p on p.id = t.principal_id
               ${principalName ? 'where p.name = ? or p.id = ?' : ''}
               order by t.created_at desc`
  const rows = await db.conn.query(sql, principalName ? [principalName, principalName] : [])
  return rows.map((r) => ({ ...tokenFrom(r), principal: String(r.principal_name) }))
}

/** 按 id 前缀吊销（表格里只显示 8 位，避免整串复制）。 */
export async function revokeToken(db: Database, idPrefix: string): Promise<TokenRow> {
  const rows = await db.conn.query('select * from astra_token where id = ? or id like ?', [
    idPrefix,
    `${idPrefix}%`,
  ])
  if (rows.length === 0) throw new AstraError('NOT_FOUND', `没有这个令牌：${idPrefix}`, { hint: '`astra auth token list` 看现有令牌' })
  if (rows.length > 1) throw invalidInput(`前缀匹配到 ${rows.length} 个令牌`, '多给几位再试')
  const row = tokenFrom(rows[0]!)
  if (row.revokedAt) return row
  await db.conn.exec('update astra_token set revoked_at = ? where id = ?', [new Date().toISOString(), row.id])
  return { ...row, revokedAt: new Date().toISOString() }
}

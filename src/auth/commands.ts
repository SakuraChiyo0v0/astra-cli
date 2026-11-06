/**
 * `astra auth ...` —— 账户与令牌（M1：只有身份、令牌、审计，还没有权限拦截）。
 *
 * 用法：
 *   astra auth whoami                       # 我现在是谁
 *   astra auth principal add social-bot --kind bot
 *   astra auth principal list
 *   astra auth token create social-bot --label feishu --days 90
 *   astra auth token list [social-bot]
 *   astra auth token revoke <id>
 */
import type { Command } from '../core/command.ts'
import { okResult, progress } from '../core/output.ts'
import { invalidInput } from '../core/errors.ts'
import { readToken, type PrincipalKind } from '../core/identity.ts'
import {
  addPrincipal,
  createToken,
  findPrincipal,
  listPrincipals,
  listTokens,
  openAuth,
  resolveToken,
  revokeToken,
} from '../core/auth.ts'

const KINDS: PrincipalKind[] = ['user', 'bot', 'service']

function parseKind(raw: string | boolean | string[] | undefined): PrincipalKind {
  const kind = String(raw ?? 'bot') as PrincipalKind
  if (!KINDS.includes(kind)) throw invalidInput(`--kind 只能是 ${KINDS.join(' / ')}`, '例如 `--kind bot`')
  return kind
}

const whoami: Command = {
  name: 'auth whoami',
  summary: '当前身份（有令牌按令牌，没有则是本机 owner）',
  usage: 'astra auth whoami',
  async run() {
    const token = readToken()
    if (!token) {
      return okResult({
        identity: { id: 'owner', name: 'owner', kind: 'owner', source: 'local' },
        note: '没有带令牌（ASTRA_TOKEN 或 <ASTRA_HOME>/token），按本机 owner 处理',
      })
    }
    const db = await openAuth()
    try {
      const hit = await resolveToken(db, token.token)
      if (!hit) {
        return okResult({
          identity: { id: null, name: null, kind: null, source: token.source },
          note: '令牌无效（已吊销 / 过期 / 主体停用），M1 阶段仍按 owner 放行',
        })
      }
      return okResult({
        identity: {
          id: hit.principal.id,
          name: hit.principal.name,
          kind: hit.principal.kind,
          source: token.source,
        },
        tokenId: hit.tokenId,
      })
    } finally {
      await db.conn.close()
    }
  },
}

const principalAdd: Command = {
  name: 'auth principal add',
  summary: '新建主体（人 / 机器人 / 服务）',
  usage: 'astra auth principal add <名字> [--kind bot|user|service] [--note 说明]',
  minArgs: 1,
  maxArgs: 1,
  options: {
    kind: { type: 'string', description: '主体类型，默认 bot', valueName: 'bot' },
    note: { type: 'string', description: '备注（谁在用这个主体）', valueName: '说明' },
  },
  async run(ctx) {
    const db = await openAuth()
    try {
      const created = await addPrincipal(db, {
        name: ctx.positionals[0]!,
        kind: parseKind(ctx.values.kind),
        ...(typeof ctx.values.note === 'string' ? { note: ctx.values.note } : {}),
      })
      return okResult(created)
    } finally {
      await db.conn.close()
    }
  },
}

const principalList: Command = {
  name: 'auth principal list',
  summary: '列出所有主体',
  usage: 'astra auth principal list',
  async run() {
    const db = await openAuth()
    try {
      const rows = await listPrincipals(db)
      return {
        ...okResult({ total: rows.length, principals: rows }),
        table: {
          headers: ['名字', '类型', '状态', '备注', '创建时间'],
          rows: rows.map((p) => [p.name, p.kind, p.status, p.note ?? '', p.createdAt.slice(0, 19).replace('T', ' ')]),
        },
      }
    } finally {
      await db.conn.close()
    }
  },
}

const tokenCreate: Command = {
  name: 'auth token create',
  summary: '给主体发令牌（明文只显示这一次）',
  usage: 'astra auth token create <主体名> [--label 用途] [--days 90]',
  notes: ['令牌只存 sha256，丢了只能重新发；`--days 0`（默认）表示不过期。'],
  minArgs: 1,
  maxArgs: 1,
  options: {
    label: { type: 'string', description: '用途标记，如 feishu / qq', valueName: '用途' },
    days: { type: 'string', description: '有效天数，0 = 不过期', valueName: '天数' },
  },
  async run(ctx) {
    const days = ctx.values.days === undefined ? 0 : Number(ctx.values.days)
    const db = await openAuth()
    try {
      const made = await createToken(db, {
        principal: ctx.positionals[0]!,
        ...(typeof ctx.values.label === 'string' ? { label: ctx.values.label } : {}),
        days,
      })
      progress('auth.token_created', { principal: made.principal.name, id: made.row.id })
      return okResult({
        token: made.token,
        id: made.row.id,
        principal: made.principal.name,
        label: made.row.label,
        expiresAt: made.row.expiresAt,
        hint: '把它放进调用方的 ASTRA_TOKEN 环境变量；服务端只存哈希，无法再取回明文',
      })
    } finally {
      await db.conn.close()
    }
  },
}

const tokenList: Command = {
  name: 'auth token list',
  summary: '列出令牌（不含明文）',
  usage: 'astra auth token list [主体名]',
  maxArgs: 1,
  async run(ctx) {
    const db = await openAuth()
    try {
      const rows = await listTokens(db, ctx.positionals[0])
      const now = new Date().toISOString()
      return {
        ...okResult({
          total: rows.length,
          tokens: rows.map((t) => ({
            id: t.id,
            principal: t.principal,
            label: t.label,
            createdAt: t.createdAt,
            lastUsedAt: t.lastUsedAt,
            expiresAt: t.expiresAt,
            status: t.revokedAt ? 'revoked' : t.expiresAt && t.expiresAt < now ? 'expired' : 'active',
          })),
        }),
        table: {
          headers: ['id', '主体', '用途', '状态', '最后使用'],
          rows: rows.map((t) => [
            t.id,
            t.principal,
            t.label ?? '',
            t.revokedAt ? 'revoked' : t.expiresAt && t.expiresAt < now ? 'expired' : 'active',
            t.lastUsedAt ? t.lastUsedAt.slice(0, 19).replace('T', ' ') : '',
          ]),
        },
      }
    } finally {
      await db.conn.close()
    }
  },
}

const tokenRevoke: Command = {
  name: 'auth token revoke',
  summary: '吊销令牌（按 id 前缀）',
  usage: 'astra auth token revoke <id前缀>',
  minArgs: 1,
  maxArgs: 1,
  async run(ctx) {
    const db = await openAuth()
    try {
      const row = await revokeToken(db, ctx.positionals[0]!)
      return okResult({ id: row.id, revokedAt: row.revokedAt, alreadyRevoked: row.revokedAt !== null })
    } finally {
      await db.conn.close()
    }
  },
}

const status: Command = {
  name: 'auth status',
  summary: '账户机制状态（存储后端、主体数、令牌数）',
  usage: 'astra auth status',
  async run() {
    const db = await openAuth()
    try {
      const principals = await listPrincipals(db)
      const tokens = await listTokens(db)
      const token = readToken()
      const hit = token ? await resolveToken(db, token.token) : null
      return {
        ...okResult({
          backend: db.url,
          principals: principals.length,
          tokens: tokens.length,
          activeTokens: tokens.filter((t) => !t.revokedAt).length,
          identity: hit ? { name: hit.principal.name, kind: hit.principal.kind, source: token!.source } : { name: 'owner', kind: 'owner', source: 'local' },
          enforcement: 'off',
          note: 'M1：身份与审计已就绪，权限判定（M2）还没开',
        }),
        table: {
          headers: ['项', '值'],
          rows: [
            ['存储', db.url],
            ['主体', String(principals.length)],
            ['令牌', String(tokens.length)],
            ['当前身份', hit ? `${hit.principal.name}（${token!.source}）` : 'owner（本机）'],
            ['权限拦截', 'off（M1）'],
          ],
        },
      }
    } finally {
      await db.conn.close()
    }
  },
}

/** 供 main 解析身份用：令牌有效就返回主体。 */
export async function resolveIdentityFromToken(token: string) {
  const db = await openAuth()
  try {
    return await resolveToken(db, token)
  } finally {
    await db.conn.close()
  }
}

export async function principalByName(name: string) {
  const db = await openAuth()
  try {
    return await findPrincipal(db, name)
  } finally {
    await db.conn.close()
  }
}

export const authCommands: Command[] = [
  whoami,
  status,
  principalAdd,
  principalList,
  tokenCreate,
  tokenList,
  tokenRevoke,
]

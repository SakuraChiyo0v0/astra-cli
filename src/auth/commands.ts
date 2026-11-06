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
import { AstraError, invalidInput } from '../core/errors.ts'
import { getCommandRegistry } from '../core/registry.ts'
import { currentIdentity, currentToken, readToken, saveLocalToken, type PrincipalKind } from '../core/identity.ts'
import {
  addPrincipal,
  allowedPatterns,
  assignRole,
  createToken,
  ensureRole,
  findPrincipal,
  grantScope,
  listGrants,
  disablePrincipal,
  listPrincipals,
  listRoles,
  listTokens,
  openAuth,
  auditGrants,
  principalRoles,
  purgePrincipal,
  resolveToken,
  revokeScope,
  revokeToken,
  scopeOf,
  unassignRole,
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
    const ident = currentIdentity()
    const resolved = currentToken()
    const token = resolved ? { token: resolved, source: ident.source } : readToken()
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
      const roles = await principalRoles(db, hit.principal.name)
      const patterns = await allowedPatterns(db, hit.principal)
      return okResult({
        identity: {
          id: hit.principal.id,
          name: hit.principal.name,
          kind: hit.principal.kind,
          source: token.source,
        },
        tokenId: hit.tokenId,
        roles,
        scopeCount: patterns.length,
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


const roleAdd: Command = {
  name: 'auth role add',
  summary: '新建角色',
  usage: 'astra auth role add <名字> [--note 说明]',
  minArgs: 1,
  maxArgs: 1,
  options: { note: { type: 'string', description: '备注', valueName: '说明' } },
  async run(ctx) {
    const db = await openAuth()
    try {
      const role = await ensureRole(db, ctx.positionals[0]!, typeof ctx.values.note === 'string' ? ctx.values.note : undefined)
      return okResult(role)
    } finally {
      await db.conn.close()
    }
  },
}

const roleList: Command = {
  name: 'auth role list',
  summary: '列出角色（含 scope 数与主体数）',
  usage: 'astra auth role list',
  async run() {
    const db = await openAuth()
    try {
      const rows = await listRoles(db)
      return {
        ...okResult({ total: rows.length, roles: rows }),
        table: {
          headers: ['角色', 'scope 数', '主体数', '备注'],
          rows: rows.map((r) => [r.name, String(r.grants), String(r.principals), r.note ?? '']),
        },
      }
    } finally {
      await db.conn.close()
    }
  },
}

const roleGrant: Command = {
  name: 'auth role grant',
  summary: '给角色加 scope（可一次多条；支持 bili.* 通配）',
  usage: 'astra auth role grant <角色> <scope...>',
  notes: ['scope 就是命令名换点：`bili get` → `bili.get`，`x media` → `x.media`；`*` 表示全通。'],
  minArgs: 2,
  async run(ctx) {
    const db = await openAuth()
    try {
      const added = await grantScope(db, ctx.positionals[0]!, ctx.positionals.slice(1))
      const all = await listGrants(db, ctx.positionals[0]!)
      return okResult({ added, total: all.length })
    } finally {
      await db.conn.close()
    }
  },
}

const roleRevoke: Command = {
  name: 'auth role revoke',
  summary: '从角色删掉一个 scope',
  usage: 'astra auth role revoke <角色> <scope>',
  minArgs: 2,
  maxArgs: 2,
  async run(ctx) {
    const db = await openAuth()
    try {
      const removed = await revokeScope(db, ctx.positionals[0]!, ctx.positionals[1]!)
      return okResult({ removed })
    } finally {
      await db.conn.close()
    }
  },
}

const roleGrants: Command = {
  name: 'auth role grants',
  summary: '列出角色的 scope',
  usage: 'astra auth role grants <角色>',
  minArgs: 1,
  maxArgs: 1,
  async run(ctx) {
    const db = await openAuth()
    try {
      const rows = await listGrants(db, ctx.positionals[0]!)
      return {
        ...okResult({ role: ctx.positionals[0], total: rows.length, grants: rows }),
        table: { headers: ['scope'], rows: rows.map((r) => [r]) },
      }
    } finally {
      await db.conn.close()
    }
  },
}

const principalGrant: Command = {
  name: 'auth principal grant',
  summary: '把角色发给主体（或 --remove 收回）',
  usage: 'astra auth principal grant <主体> <角色> [--remove]',
  minArgs: 2,
  maxArgs: 2,
  options: { remove: { type: 'boolean', description: '收回这个角色' } },
  async run(ctx) {
    const db = await openAuth()
    try {
      if (ctx.values.remove === true) {
        const removed = await unassignRole(db, ctx.positionals[0]!, ctx.positionals[1]!)
        return okResult({ removed, roles: await principalRoles(db, ctx.positionals[0]!) })
      }
      await assignRole(db, ctx.positionals[0]!, ctx.positionals[1]!)
      return okResult({ assigned: ctx.positionals[1], roles: await principalRoles(db, ctx.positionals[0]!) })
    } finally {
      await db.conn.close()
    }
  },
}

const principalRolesCmd: Command = {
  name: 'auth principal roles',
  summary: '看主体有哪些角色与生效的 scope 模式',
  usage: 'astra auth principal roles <主体>',
  minArgs: 1,
  maxArgs: 1,
  async run(ctx) {
    const db = await openAuth()
    try {
      const principal = await findPrincipal(db, ctx.positionals[0]!)
      const roles = await principalRoles(db, ctx.positionals[0]!)
      const patterns = principal ? await allowedPatterns(db, principal) : []
      return {
        ...okResult({ principal: ctx.positionals[0], roles, patterns, scopeCount: patterns.length }),
        table: {
          headers: ['项', '值'],
          rows: [
            ['主体', ctx.positionals[0]!],
            ['角色', roles.join(', ') || '（无）'],
            ['scope 模式', String(patterns.length)],
          ],
        },
      }
    } finally {
      await db.conn.close()
    }
  },
}


const ownerToken: Command = {
  name: 'auth owner-token',
  summary: '给本机 owner 发令牌并写到 <ASTRA_HOME>/token（600）',
  usage: 'astra auth owner-token [--rotate]',
  notes: [
    '这是唯一的免令牌入口：没有它，本机就再也拿不到 owner 身份。',
    '写入后本机所有脚本、cron 通过文件自动认成 owner，不需要改调用方。',
  ],
  options: { rotate: { type: 'boolean', description: '吊销已有 owner 令牌后重发' } },
  async run(ctx) {
    const db = await openAuth()
    try {
      const owner = await findPrincipal(db, 'owner')
      if (!owner) throw new AstraError('NOT_FOUND', '库里没有 owner 主体', { hint: '先跑一次 `astra auth status` 建表' })
      if (ctx.values.rotate === true) {
        const rows = await listTokens(db, 'owner')
        for (const row of rows) if (!row.revokedAt) await revokeToken(db, row.id)
      }
      const made = await createToken(db, { principal: 'owner', label: 'local-owner', days: 0 })
      const file = saveLocalToken(made.token)
      progress('auth.owner_token', { id: made.row.id, file })
      return okResult({ id: made.row.id, file, note: '本机后续调用自动使用它；不要外传' })
    } finally {
      await db.conn.close()
    }
  },
}


const principalDisable: Command = {
  name: 'auth principal disable',
  summary: '停用主体（令牌立刻失效，记录保留）',
  usage: 'astra auth principal disable <主体>',
  minArgs: 1,
  maxArgs: 1,
  async run(ctx) {
    const db = await openAuth()
    try {
      const p = await disablePrincipal(db, ctx.positionals[0]!)
      return okResult({ principal: p.name, status: p.status, tokensRevoked: true })
    } finally {
      await db.conn.close()
    }
  },
}

const principalPurge: Command = {
  name: 'auth principal purge',
  summary: '彻底删除主体（连带令牌与角色绑定），需 --yes',
  usage: 'astra auth principal purge <主体> --yes',
  notes: ['没有外键级联，所以这是显式清理；日常建议用 disable 而不是 purge。'],
  minArgs: 1,
  maxArgs: 1,
  options: { yes: { type: 'boolean', description: '确认删除' } },
  async run(ctx) {
    if (ctx.values.yes !== true) {
      throw invalidInput('purge 会真删数据，需显式加 --yes', '只想让人失效请用 `astra auth principal disable <主体>`')
    }
    const db = await openAuth()
    try {
      const out = await purgePrincipal(db, ctx.positionals[0]!)
      return okResult({ principal: ctx.positionals[0], ...out })
    } finally {
      await db.conn.close()
    }
  },
}


const doctorCmd: Command = {
  name: 'auth doctor',
  summary: '授权体检：未被任何角色覆盖的命令、匹配不到命令的授权模式',
  usage: 'astra auth doctor',
  notes: [
    '“未被覆盖”不等于出错：owner 本身不需要授权；这里列的是公开命令里没人授权的部分。',
    '“未知授权”通常是命令改名后留下的旧 scope，会让授权面悄悄失效。',
  ],
  async run() {
    const db = await openAuth()
    try {
      const roles = await listRoles(db)
      const grants: Array<{ role: string; pattern: string }> = []
      for (const r of roles) {
        for (const pattern of await listGrants(db, r.name)) grants.push({ role: r.name, pattern })
      }
      const report = auditGrants(getCommandRegistry(), grants)
      return {
        ...okResult(report),
        table: {
          headers: ['项', '值'],
          rows: [
            ['公开命令', String(report.totalCommands)],
            ['授权模式', String(report.totalGrants)],
            ['未被角色覆盖', String(report.uncovered.length)],
            ['匹配不到命令', String(report.unknownGrants.length)],
          ],
        },
      }
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
      const resolved = currentToken()
      const token = resolved ? { token: resolved, source: currentIdentity().source } : readToken()
      const hit = token ? await resolveToken(db, token.token) : null
      return {
        ...okResult({
          backend: db.url,
          principals: principals.length,
          tokens: tokens.length,
          activeTokens: tokens.filter((t) => !t.revokedAt).length,
          identity: hit ? { name: hit.principal.name, kind: hit.principal.kind, source: token!.source } : { name: 'owner', kind: 'owner', source: 'local' },
          enforcement: 'on',
          note: 'M2：带令牌的调用按角色判权；不带令牌的本机调用按 owner 全通',
        }),
        table: {
          headers: ['项', '值'],
          rows: [
            ['存储', db.url],
            ['主体', String(principals.length)],
            ['令牌', String(tokens.length)],
            ['当前身份', hit ? `${hit.principal.name}（${token!.source}）` : 'owner（本机）'],
            ['权限拦截', 'on（M2）'],
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
  ownerToken,
  status,
  roleAdd,
  roleList,
  roleGrant,
  roleRevoke,
  roleGrants,
  principalGrant,
  principalRolesCmd,
  principalDisable,
  principalPurge,
  doctorCmd,
  principalAdd,
  principalList,
  tokenCreate,
  tokenList,
  tokenRevoke,
]

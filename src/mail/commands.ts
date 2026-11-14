/**
 * `astra mail`：读邮箱里的验证码（IMAP 只读）。
 *
 * 命令形态（越短越好，主流程不带必填 flag）：
 *   mail login <名字> <邮箱地址>            # 授权码走 stdin，不落 argv
 *   mail accounts | mail default <名字> | mail logout <名字>
 *   mail code [--account qq] [--minutes 10] [--from steam] [--wait 120]
 *   mail list [--limit 10] [--minutes 1440]
 *   mail doctor [名字]
 *
 * 安全口径：
 * - 只读：全部用 `BODY.PEEK[]`，取信不会把邮件标为已读
 * - 只存授权码，回显一律脱敏（`maskSecret`）
 * - 不发信、不删信、不改标签 —— 这个域没有任何写操作
 */
import { createInterface } from 'node:readline'
import type { Command, CommandContext, CommandResult } from '../core/command.ts'
import { invalidInput } from '../core/errors.ts'
import { okResult } from '../core/output.ts'
import { extractCode, oneLine } from './code.ts'
import { ImapClient } from './imap.ts'
import { extractText, parseMailDate, readHeaders } from './mime.ts'
import {
  guessHost,
  loadStore,
  maskSecret,
  removeAccount,
  resolveAccount,
  saveStore,
  upsertAccount,
} from './store.ts'
import type { MailAccount, MailMessage } from './types.ts'

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/
const MAX_FETCH = 40

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function num(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) {
    throw invalidInput(`${name} 必须在 ${min}..${max} 之间`, `收到：${String(value)}`)
  }
  return n
}

function stamp(d: Date | null): string {
  if (!d) return ''
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

/** 授权码从 stdin 读（不回显、不进 argv）；TTY 下手敲也走这里。 */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
    return Buffer.concat(chunks).toString('utf8').trim()
  }
  process.stderr.write(prompt)
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  const muted = rl as unknown as { _writeToOutput?: (s: string) => void }
  const original = muted._writeToOutput?.bind(rl)
  muted._writeToOutput = (s: string) => {
    if (s.includes('\n') || s.includes('\r')) original?.(s)
  }
  const answer = await new Promise<string>((resolve) => rl.question('', (a) => resolve(a)))
  rl.close()
  process.stderr.write('\n')
  return answer.trim()
}

/** 拉最近一批邮件：先按日期 SEARCH，再取最新的 N 封（只看时间窗内的）。 */
async function fetchMessages(
  account: MailAccount,
  opts: { minutes: number; limit: number; sender?: string; withBody?: boolean },
): Promise<MailMessage[]> {
  const client = new ImapClient()
  await client.connect({ host: account.host, port: account.port })
  try {
    await client.login(account.user, account.password)
    await client.select(account.folder)
    const since = new Date(Date.now() - Math.max(opts.minutes, 1) * 60_000)
    const uids = await client.searchSince(since)
    if (uids.length === 0) return []
    const newest = uids.slice(-Math.min(Math.max(opts.limit, 1), MAX_FETCH))
    const cutoff = Date.now() - Math.max(opts.minutes, 1) * 60_000
    const out: MailMessage[] = []
    for (const uid of newest.reverse()) {
      const raw = await client.fetchRaw(uid)
      if (!raw) continue
      const headers = readHeaders(raw)
      const date = parseMailDate(headers.date)
      if (date && date.getTime() < cutoff) continue
      const from = headers.from ?? ''
      if (opts.sender && !from.toLowerCase().includes(opts.sender.toLowerCase())) continue
      const subject = headers.subject ?? ''
      const body = opts.withBody === false ? '' : extractText(raw)
      out.push({
        uid,
        from: oneLine(from, 120),
        subject: oneLine(subject, 160),
        date: stamp(date),
        code: extractCode(subject, body),
        preview: oneLine(body),
      })
    }
    return out
  } finally {
    await client.close()
  }
}

function tableOf(rows: MailMessage[]): { headers: string[]; rows: string[][] } {
  return {
    headers: ['时间', '发件人', '验证码', '主题'],
    rows: rows.map((r) => [r.date, r.from, r.code || '—', r.subject]),
  }
}

const commonOptions = {
  account: { type: 'string', description: '账号名（默认用 mail.json 里的 default）', valueName: '名字' },
  minutes: { type: 'string', description: '只看最近多少分钟内的邮件（默认 10）', valueName: '分钟' },
  from: { type: 'string', description: '按发件人过滤（子串，不区分大小写）', valueName: '关键词' },
} as const

const login: Command = {
  name: 'mail login',
  summary: '添加一个邮箱（IMAP 只读），授权码从 stdin 读',
  usage: 'mail login <名字> <邮箱地址> [--host imap.qq.com] [--folder INBOX] [--port 993] [--default]',
  notes: [
    '授权码从 stdin 读，不进 argv、不回显：`printf %s "$CODE" | astra mail login qq 123@qq.com`',
    'QQ/163 要先在邮箱设置里开启 IMAP 并生成授权码，用登录密码连不上',
    '只做只读取信，不发信、不删信、不改已读状态',
  ],
  options: {
    host: { type: 'string', description: 'IMAP 主机（能按邮箱域名自动认，认不出才需要给）', valueName: '主机' },
    folder: { type: 'string', description: '邮箱目录，默认 INBOX', valueName: '目录' },
    port: { type: 'string', description: 'IMAP 端口，默认 993', valueName: '端口' },
    default: { type: 'boolean', description: '把这个邮箱设成默认账号' },
  },
  minArgs: 2,
  maxArgs: 2,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const [rawName = '', email = ''] = ctx.positionals
    const name = rawName.trim()
    if (!NAME_RE.test(name)) throw invalidInput(`账号名不合法：${name}`, '用小写字母/数字/下划线，如 qq、163、work')
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw invalidInput(`邮箱地址不合法：${email}`, '例：123456@qq.com')
    const host = str(ctx.values.host) || guessHost(email)
    const folder = str(ctx.values.folder) || 'INBOX'
    const port = num(ctx.values.port, 993, 1, 65535, '--port')
    const password = await readSecret(`授权码（不回显，不存盘为明文以外任何形式）: `)
    if (!password) throw invalidInput('没读到授权码', '重新运行，把授权码粘进去后回车')

    // 先验一次再存：连不上就不留下坏记录
    const client = new ImapClient()
    await client.connect({ host, port })
    let messages = 0
    try {
      await client.login(email, password)
      messages = await client.select(folder)
    } finally {
      await client.close()
    }

    const store = loadStore()
    upsertAccount(store, { name, host, port, user: email, password, folder }, ctx.values.default === true)
    saveStore(store)
    return okResult({
      ok: true,
      account: { name, host, port, user: email, folder, secret: maskSecret(password) },
      messages,
      default: store.default ?? null,
    })
  },
}

const accounts: Command = {
  name: 'mail accounts',
  summary: '列出已配置的邮箱（授权码脱敏）',
  usage: 'mail accounts',
  maxArgs: 0,
  async run(): Promise<CommandResult> {
    const store = loadStore()
    const rows = Object.values(store.accounts).map((a) => ({
      name: a.name,
      user: a.user,
      host: a.host,
      endpoint: `${a.host}:${a.port}`,
      folder: a.folder,
      secret: maskSecret(a.password),
      default: store.default === a.name,
    }))
    rows.sort((x, y) => Number(y.default) - Number(x.default) || x.name.localeCompare(y.name))
    return okResult({
      total: rows.length,
      default: store.default ?? null,
      accounts: rows,
      table: {
        headers: ['账号', '邮箱', 'IMAP', '目录', '授权码', '默认'],
        rows: rows.map((r) => [r.name, r.user, r.endpoint, r.folder, r.secret, r.default ? '✓' : '']),
      },
    })
  },
}

const setDefault: Command = {
  name: 'mail default',
  summary: '设置默认邮箱',
  usage: 'mail default <名字>',
  minArgs: 1,
  maxArgs: 1,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const store = loadStore()
    const name = (ctx.positionals[0] ?? '').trim()
    if (!store.accounts[name]) throw invalidInput(`没有账号 ${name}`, `已配置：${Object.keys(store.accounts).join('、') || '（空）'}`)
    store.default = name
    saveStore(store)
    return okResult({ default: name })
  },
}

const logout: Command = {
  name: 'mail logout',
  summary: '删掉一个邮箱的授权码',
  usage: 'mail logout <名字>',
  notes: ['只删本机配置；邮箱侧的授权码要自己去邮箱设置里撤销'],
  minArgs: 1,
  maxArgs: 1,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const store = loadStore()
    const name = (ctx.positionals[0] ?? '').trim()
    const removed = removeAccount(store, name)
    if (removed) saveStore(store)
    return okResult({ removed, default: store.default ?? null })
  },
}

const code: Command = {
  name: 'mail code',
  summary: '取最新的邮箱验证码（两步验证用）',
  usage: 'mail code [--account qq] [--minutes 10] [--from 关键词] [--wait 秒] [--any]',
  notes: [
    '默认只找最近 10 分钟内、能抽出验证码的邮件，按时间倒序返回，`code` 是最新那封的码',
    '`--wait 120` 会每 5 秒重新查一次，来新邮件立刻返回（做两步验证时用）',
    '抽不到码时 `code` 为 null，`matches` 为空数组 —— 不是报错，只是这封不像验证码邮件',
    '只读：取信不会把邮件标成已读',
  ],
  options: {
    ...commonOptions,
    wait: { type: 'string', description: '最多等多少秒（每 5 秒查一次），默认 0 = 只查一次', valueName: '秒' },
    any: { type: 'boolean', description: '不过滤掉没抽到码的邮件（排障用）' },
  },
  maxArgs: 0,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const store = loadStore()
    const account = resolveAccount(store, str(ctx.values.account))
    const minutes = num(ctx.values.minutes, 10, 1, 1440, '--minutes')
    const wait = num(ctx.values.wait, 0, 0, 600, '--wait')
    const sender = str(ctx.values.from)
    const deadline = Date.now() + wait * 1000

    const pick = (rows: MailMessage[]) => (ctx.values.any === true ? rows : rows.filter((r) => r.code))
    let rows: MailMessage[] = []
    for (;;) {
      rows = pick(await fetchMessages(account, { minutes, limit: 20, sender, withBody: true }))
      if (rows.length > 0 || Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }

    const top = rows[0]
    return okResult({
      account: account.name,
      window_minutes: minutes,
      code: top?.code ?? null,
      from: top?.from ?? null,
      subject: top?.subject ?? null,
      date: top?.date ?? null,
      matches: rows.map((r) => ({ code: r.code, from: r.from, subject: r.subject, date: r.date })),
      table: tableOf(rows),
    })
  },
}

const list: Command = {
  name: 'mail list',
  summary: '列出最近的邮件（顺带抽出验证码）',
  usage: 'mail list [--account qq] [--limit 10] [--minutes 1440] [--from 关键词]',
  notes: ['不发信、不删信、不标已读；只回摘要，正文前 160 字在 JSON 的 preview 里'],
  options: {
    ...commonOptions,
    limit: { type: 'string', description: '最多返回几封（1..40，默认 10）', valueName: '条数' },
  },
  maxArgs: 0,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const store = loadStore()
    const account = resolveAccount(store, str(ctx.values.account))
    const minutes = num(ctx.values.minutes, 1440, 1, 10080, '--minutes')
    const limit = num(ctx.values.limit, 10, 1, MAX_FETCH, '--limit')
    const rows = await fetchMessages(account, { minutes, limit, sender: str(ctx.values.from), withBody: true })
    return okResult({
      account: account.name,
      returned: rows.length,
      truncated: rows.length >= limit,
      messages: rows,
      table: tableOf(rows),
    })
  },
}

const doctor: Command = {
  name: 'mail doctor',
  summary: '检查邮箱能不能连上、目录里有多少封',
  usage: 'mail doctor [名字]',
  notes: ['三态：没配置账号 / 连不上（网络或授权码）/ 正常（给出目录里邮件数与最新一封时间）'],
  maxArgs: 1,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const store = loadStore()
    const account = resolveAccount(store, str(ctx.positionals[0]))
    const client = new ImapClient()
    await client.connect({ host: account.host, port: account.port })
    try {
      await client.login(account.user, account.password)
      const exists = await client.select(account.folder)
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
      const uids = await client.searchSince(since)
      let latest: string | null = null
      const lastUid = uids.at(-1)
      if (lastUid) {
        const raw = await client.fetchRaw(lastUid)
        if (raw) latest = stamp(parseMailDate(readHeaders(raw).date))
      }
      return okResult({
        ok: true,
        account: account.name,
        user: account.user,
        host: `${account.host}:${account.port}`,
        folder: account.folder,
        exists,
        last_7d: uids.length,
        latest,
      })
    } finally {
      await client.close()
    }
  },
}

export const mailCommands: Command[] = [login, accounts, setDefault, logout, code, list, doctor]

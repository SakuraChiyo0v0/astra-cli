/**
 * `astra vr ...` 命令。
 *
 * 只读命令直接返回数据；写命令统一走"预览 → 令牌 → 确认"两步（见 core/confirm.ts）。
 */
import { AstraError, invalidInput } from '../core/errors.ts'
import type { Command } from '../core/command.ts'
import { clearPending, consume, prepare, readPending } from '../core/confirm.ts'
import * as api from './data.ts'
import * as actions from './actions.ts'
import {
  clearPending as clearTwoFactor, clearSession, currentUser, loadSession, login, logout,
  readPending as readTwoFactorPending, submitTwoFactor,
} from './auth.ts'

const PURPOSE = 'vr'

function needString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalidInput(`缺少 --${name}`, `用法见 \`astra vr ${name} --help\``)
  return value.trim()
}

function intOf(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw invalidInput(`--${name} 必须是 ${min}..${max} 的整数`)
  return n
}

// ---------- 登录 ----------

const loginCmd: Command = {
  name: 'vr login',
  summary: '登录 VRChat（账号密码，支持两步验证）',
  usage: 'astra vr login --username <账号> --password <密码> [--code <验证码>]',
  notes: [
    '开了两步验证时会返回 status: needs_2fa 和可用的方式；把验证码用 --code 传回来即可',
    '账号密码只用于这一次请求，不会落盘；落盘的是会话 cookie（600）',
    '两步验证的中间态 5 分钟有效',
  ],
  options: {
    username: { type: 'string', description: '邮箱或用户名', valueName: 'text' },
    password: { type: 'string', description: '密码', valueName: 'text' },
    code: { type: 'string', description: '两步验证码（已有待验证状态时用它）', valueName: 'code' },
  },
  maxArgs: 0,
  async run({ values, signal }) {
    // 已有待验证状态时，--code 就是提交验证码
    if (values.code !== undefined) {
      const pending = readTwoFactorPending()
      if (!pending) throw new AstraError('VRCHAT_NO_PENDING_2FA', '没有待完成的两步验证', { exitCode: 2, hint: '重新执行 `astra vr login --username <账号> --password <密码>`' })
      const session = await submitTwoFactor(String(values.code), signal)
      return { data: { status: 'done', account: { id: session.userId, displayName: session.displayName } } }
    }
    const username = needString(values.username, 'username')
    const password = needString(values.password, 'password')
    const result = await login(username, password, signal)
    if (result.status === 'needs_2fa') return { data: { status: 'needs_2fa', methods: result.methods, next: result.next } }
    return { data: { status: 'done', account: { id: result.session.userId, displayName: result.session.displayName } } }
  },
}

const accountCmd: Command = {
  name: 'vr account',
  summary: '看登录状态与自己的资料',
  usage: 'astra vr account',
  maxArgs: 0,
  async run({ signal }) {
    const session = loadSession()
    if (!session) return { data: { loggedIn: false } }
    try {
      const me = await currentUser(signal)
      const avatar = await api.currentAvatar(signal)
      return {
        data: {
          loggedIn: true,
          id: me.id,
          displayName: me.displayName,
          status: me.status ?? null,
          statusDescription: me.statusDescription ?? null,
          currentAvatar: avatar ? { id: avatar.id, name: avatar.name } : null,
          savedAt: session.savedAt,
        },
      }
    } catch (err) {
      return { data: { loggedIn: true, stale: true, savedAt: session.savedAt, error: (err as Error).message } }
    }
  },
}

const logoutCmd: Command = {
  name: 'vr logout',
  summary: '退出登录（清本地会话）',
  usage: 'astra vr logout',
  maxArgs: 0,
  async run() {
    clearTwoFactor()
    return { data: { loggedOut: await logout() } }
  },
}

// ---------- 只读 ----------

const friendsCmd: Command = {
  name: 'vr friends',
  summary: '好友列表；只看在线的加 --online',
  usage: 'astra vr friends [--online]',
  notes: ['在线的好友会带 worldId 与 location，可以直接 `astra vr world <id>` 看他们在哪'],
  options: { online: { type: 'boolean', description: '只看在线的' } },
  maxArgs: 0,
  async run({ values, signal }) {
    const list = await api.friends({ onlineOnly: values.online === true, signal })
    return {
      data: {
        total: list.length,
        online: list.filter((u) => u.location && u.location !== 'offline').length,
        friends: list.map((u) => ({
          id: u.id,
          displayName: u.displayName,
          status: u.status,
          statusDescription: u.statusDescription,
          online: u.location !== null && u.location !== 'offline' && u.location !== 'private',
          worldId: u.worldId,
          location: u.location,
          platform: u.platform,
        })),
      },
    }
  },
}

const notificationsCmd: Command = {
  name: 'vr notifications',
  summary: '通知列表（好友请求、邀请、群公告等）',
  usage: 'astra vr notifications [--unread] [--limit 50]',
  options: {
    unread: { type: 'boolean', description: '只看未读' },
    limit: { type: 'string', short: 'n', description: '默认 50', valueName: 'n' },
  },
  maxArgs: 0,
  async run({ values, signal }) {
    const list = await api.notifications({ unreadOnly: values.unread === true, limit: intOf(values.limit, 50, 1, 100, 'limit'), signal })
    return {
      data: {
        total: list.length,
        unread: list.filter((n) => !n.seen).length,
        notifications: list.map((n) => ({ id: n.id, type: n.type, message: n.message, seen: n.seen, createdAt: n.createdAt, senderUserId: n.senderUserId, details: n.details })),
      },
    }
  },
}

const worldCmd: Command = {
  name: 'vr world',
  summary: '世界详情，或列它的当前实例',
  usage: 'astra vr world <wrld_xxx> [--instances]',
  options: { instances: { type: 'boolean', description: '顺便列出当前实例与人数' } },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const id = positionals[0]!
    const w = await api.world(id, signal)
    const data: Record<string, unknown> = { world: w }
    if (values.instances === true) {
      const list = await api.worldInstances(id, signal)
      data.instances = list.map((i) => ({ location: i.location, occupants: i.occupants, capacity: i.capacity, accessType: i.accessType, region: i.region, friendsInside: i.friendsInside }))
    }
    return { data }
  },
}

const searchWorldsCmd: Command = {
  name: 'vr worlds search',
  summary: '搜索世界',
  usage: 'astra vr worlds search <关键词> [--limit 20]',
  options: { limit: { type: 'string', short: 'n', description: '默认 20', valueName: 'n' } },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const list = await api.searchWorlds(positionals[0]!, { limit: intOf(values.limit, 20, 1, 100, 'limit'), signal })
    return { data: { total: list.length, worlds: list.map((w) => ({ id: w.id, name: w.name, authorName: w.authorName, occupants: w.occupants, capacity: w.capacity, releaseStatus: w.releaseStatus })) } }
  },
}

const instanceCmd: Command = {
  name: 'vr instance',
  summary: '实例详情（谁在里面）',
  usage: 'astra vr instance <wrld_xxx:instanceId>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, signal }) {
    const i = await api.instance(positionals[0]!, signal)
    return { data: i }
  },
}

const groupsCmd: Command = {
  name: 'vr groups',
  summary: '我加入的群组',
  usage: 'astra vr groups [--limit 50]',
  options: { limit: { type: 'string', short: 'n', description: '默认 50', valueName: 'n' } },
  maxArgs: 0,
  async run({ values, signal }) {
    const list = await api.myGroups({ limit: intOf(values.limit, 50, 1, 100, 'limit'), signal })
    return { data: { total: list.length, groups: list } }
  },
}

const searchGroupsCmd: Command = {
  name: 'vr groups search',
  summary: '搜索群组',
  usage: 'astra vr groups search <关键词> [--limit 20]',
  options: { limit: { type: 'string', short: 'n', description: '默认 20', valueName: 'n' } },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const list = await api.searchGroups(positionals[0]!, { limit: intOf(values.limit, 20, 1, 100, 'limit'), signal })
    return { data: { total: list.length, groups: list } }
  },
}

const avatarsCmd: Command = {
  name: 'vr avatars',
  summary: '我的头像列表与当前头像',
  usage: 'astra vr avatars [--limit 50]',
  options: { limit: { type: 'string', short: 'n', description: '默认 50', valueName: 'n' } },
  maxArgs: 0,
  async run({ values, signal }) {
    const [list, current] = await Promise.all([api.myAvatars({ limit: intOf(values.limit, 50, 1, 100, 'limit'), signal }), api.currentAvatar(signal)])
    return { data: { total: list.length, current, avatars: list.map((a) => ({ id: a.id, name: a.name, authorName: a.authorName, releaseStatus: a.releaseStatus })) } }
  },
}

const favoritesCmd: Command = {
  name: 'vr favorites',
  summary: '收藏列表与分组',
  usage: 'astra vr favorites [--type world|avatar|friend]',
  options: { type: { type: 'string', description: 'world（默认）/ avatar / friend', valueName: 'type' } },
  maxArgs: 0,
  async run({ values, signal }) {
    const type = (values.type as string | undefined) ?? 'world'
    const [list, groups] = await Promise.all([api.favorites({ type, signal }), api.favoriteGroups({ type, signal })])
    return { data: { type, total: list.length, groups, favorites: list } }
  },
}

const economyCmd: Command = {
  name: 'vr economy',
  summary: '余额与订阅状态',
  usage: 'astra vr economy',
  notes: ['只读。上游没给余额时是 null，不是 0 —— 两者含义不同，别把 null 说成"没余额"'],
  maxArgs: 0,
  async run({ signal }) {
    const [bal, limits] = await Promise.all([api.balance(signal), api.favoriteLimits(signal)])
    return { data: { ...bal, favoriteLimits: limits } }
  },
}

const transactionsCmd: Command = {
  name: 'vr transactions',
  summary: '交易明细（只读，不发起任何交易）',
  usage: 'astra vr transactions [--limit 20] [--offset 0]',
  notes: [
    'status 已知取值：active / failed / succeeded / cancelled；出现新值就原样转述，不要自己解释成成功或失败',
    '只读，不会买东西、不会退款',
  ],
  options: {
    limit: { type: 'string', short: 'n', description: '1..100，默认 20', valueName: 'n' },
    offset: { type: 'string', description: '跳过多少条，默认 0', valueName: 'n' },
  },
  maxArgs: 0,
  async run({ values, signal }) {
    const limit = intOf(values.limit, 20, 1, 100, 'limit')
    const offset = intOf(values.offset, 0, 0, 100000, 'offset')
    const list = await api.transactions({ limit, offset, signal })
    return {
      data: {
        count: list.length,
        transactions: list.map((t) => ({ id: t.id, status: t.status, type: t.type, description: t.description, amount: t.amount, balanceAfter: t.balance, createdAt: t.createdAt })),
        truncated: list.length >= limit,
      },
    }
  },
}

const doctorCmd: Command = {
  name: 'vr doctor',
  summary: '自检：会话、API 连通、好友/通知能否读到',
  usage: 'astra vr doctor',
  maxArgs: 0,
  async run({ signal }) {
    const checks: { name: string; ok: boolean; detail: string }[] = []
    const session = loadSession()
    checks.push({ name: 'session', ok: session !== null, detail: session ? `已保存（${session.displayName ?? '未知账号'}）` : '未登录' })
    const probe = await api.probeApi(signal)
    checks.push({ name: 'api', ok: probe.reachable, detail: probe.detail })
    if (session) {
      try {
        const friends = await api.friends({ onlineOnly: true, signal })
        checks.push({ name: 'friends', ok: true, detail: `${friends.length} 个在线好友` })
      } catch (err) {
        checks.push({ name: 'friends', ok: false, detail: (err as Error).message })
      }
    }
    return { data: { ok: checks.every((c) => c.ok), checks } }
  },
}

// ---------- 写操作（预览 + 确认） ----------

/** 写命令的公共骨架：不带 --confirm 时生成预览，带了就执行。 */
function writeCommand(config: {
  name: string
  summary: string
  usage: string
  notes?: string[]
  options?: Command['options']
  minArgs?: number
  maxArgs?: number
  action: string
  /** 预览要展示什么，以及执行时用到的参数。 */
  prepare: (ctx: { positionals: string[]; values: Record<string, string | boolean | string[] | undefined>; signal: AbortSignal }) => Promise<{ params: unknown; preview: unknown; instruction: string }>
  execute: (params: Record<string, unknown>, signal: AbortSignal) => Promise<actions.ActionResult>
  /** 从 params 还原出执行参数（预览里存的是 params）。 */
  toExecute: (params: Record<string, unknown>) => Record<string, unknown>
}): Command {
  return {
    name: config.name,
    summary: config.summary,
    usage: config.usage,
    ...(config.notes ? { notes: config.notes } : {}),
    options: { ...(config.options ?? {}), confirm: { type: 'string', description: '执行之前预览生成的令牌', valueName: 'token' } },
    ...(config.minArgs === undefined ? {} : { minArgs: config.minArgs }),
    ...(config.maxArgs === undefined ? {} : { maxArgs: config.maxArgs }),
    async run({ positionals, values, signal }) {
      if (typeof values.confirm === 'string') {
        const pending = consume(PURPOSE, values.confirm, config.action)
        const result = await config.execute(config.toExecute(pending.preview as Record<string, unknown>), signal)
        clearPending(PURPOSE)
        return { data: { status: 'done', action: config.action, ...result } }
      }
      const prepared = await config.prepare({ positionals, values, signal })
      return { data: prepare(PURPOSE, config.action, prepared.params, prepared.preview, prepared.instruction) }
    },
  }
}

const friendRequestCmd = writeCommand({
  name: 'vr friends request',
  summary: '给某人发好友请求（需要确认）',
  usage: 'astra vr friends request <usr_xxx> [--confirm <token>]',
  action: 'friends.request',
  minArgs: 1,
  maxArgs: 1,
  async prepare({ positionals }) {
    const userId = positionals[0]!
    if (!/^usr_[0-9a-f-]+$/i.test(userId)) throw invalidInput(`「${userId}」不像 VRChat 用户 id`, '形如 usr_xxxxxxxx-xxxx-...；可以用 `astra vr friends` 看好友 id')
    return { params: { userId }, preview: { userId }, instruction: '把 userId 给用户确认后执行 `astra vr friends request ' + userId + ' --confirm <token>`。' }
  },
  toExecute: (p) => ({ userId: String(p.userId) }),
  async execute(p, signal) {
    return actions.sendFriendRequest(String(p.userId), signal)
  },
})

const friendRemoveCmd = writeCommand({
  name: 'vr friends remove',
  summary: '删除好友（需要确认）',
  usage: 'astra vr friends remove <usr_xxx> [--confirm <token>]',
  action: 'friends.remove',
  minArgs: 1,
  maxArgs: 1,
  async prepare({ positionals, signal }) {
    const userId = positionals[0]!
    // 删除前先确认这个人确实是好友，避免 AI 拿错 id
    const list = await api.friends({ signal })
    const target = list.find((f) => f.id === userId)
    if (!target) throw new AstraError('NOT_A_FRIEND', `${userId} 不在好友列表里`, { exitCode: 4 })
    return {
      params: { userId, displayName: target.displayName },
      preview: { userId, displayName: target.displayName },
      instruction: `把要删除的好友「${target.displayName}」告诉用户确认，再执行 \`astra vr friends remove ${userId} --confirm <token>\`。`,
    }
  },
  toExecute: (p) => ({ userId: String(p.userId) }),
  async execute(p, signal) {
    return actions.removeFriend(String(p.userId), signal)
  },
})

const favoriteAddCmd = writeCommand({
  name: 'vr favorites add',
  summary: '收藏世界 / 头像 / 好友（需要确认）',
  usage: 'astra vr favorites add <id> [--type world|avatar|friend] [--group <分组名>] [--confirm <token>]',
  action: 'favorites.add',
  minArgs: 1,
  maxArgs: 1,
  options: {
    type: { type: 'string', description: 'world（默认）/ avatar / friend', valueName: 'type' },
    group: { type: 'string', description: '收藏分组名，默认 VRChat 的第一个分组', valueName: 'name' },
  },
  async prepare({ positionals, values, signal }) {
    const id = positionals[0]!
    const type = ((values.type as string | undefined) ?? 'world') as actions.FavoriteType
    if (!['world', 'avatar', 'friend'].includes(type)) throw invalidInput('--type 只能是 world / avatar / friend')
    // 分组名必须是账号里真实存在的，否则上游会拒
    const groups = await api.favoriteGroups({ type, signal })
    const groupName = (values.group as string | undefined) ?? groups[0]?.name
    if (!groupName) throw new AstraError('NO_FAVORITE_GROUP', `没有可用的 ${type} 收藏分组`, { exitCode: 4, hint: '先在 VRChat 客户端里建一个收藏分组' })
    if (!groups.some((g) => g.name === groupName)) {
      throw invalidInput(`没有叫「${groupName}」的分组`, `现有分组：${groups.map((g) => g.name).join(', ')}`)
    }
    return {
      params: { type, favoriteId: id, tags: groupName },
      preview: { type, favoriteId: id, group: groupName },
      instruction: `告诉用户要把 ${id} 收藏到「${groupName}」，确认后执行 \`astra vr favorites add ${id} --type ${type} --group ${groupName} --confirm <token>\`。`,
    }
  },
  toExecute: (p) => ({ type: String(p.type), favoriteId: String(p.favoriteId), tags: String(p.tags) }),
  async execute(p, signal) {
    return actions.addFavorite(p.type as actions.FavoriteType, String(p.favoriteId), String(p.tags), signal)
  },
})

const favoriteRemoveCmd = writeCommand({
  name: 'vr favorites remove',
  summary: '取消收藏（需要确认，参数是收藏记录 id 不是世界 id）',
  usage: 'astra vr favorites remove <fvrt_xxx> [--confirm <token>]',
  action: 'favorites.remove',
  minArgs: 1,
  maxArgs: 1,
  async prepare({ positionals }) {
    const id = positionals[0]!
    return {
      params: { favoriteId: id },
      preview: { favoriteId: id },
      instruction: `确认后执行 \`astra vr favorites remove ${id} --confirm <token>\`。注意这是**收藏记录 id**（fvrt_ 开头），不是世界 id。`,
    }
  },
  toExecute: (p) => ({ favoriteId: String(p.favoriteId) }),
  async execute(p, signal) {
    return actions.removeFavorite(String(p.favoriteId), signal)
  },
})

const inviteCmd = writeCommand({
  name: 'vr invites send',
  summary: '邀请好友来某个实例（需要确认）',
  usage: 'astra vr invites send <usr_xxx> <wrld_xxx:instance> [--confirm <token>]',
  action: 'invites.send',
  minArgs: 2,
  maxArgs: 2,
  async prepare({ positionals }) {
    const [userId, location] = positionals as [string, string]
    if (!location.startsWith('wrld_')) throw invalidInput(`「${location}」不像实例地址`, '形如 wrld_xxx:12345（可以直接用好友的 location）')
    return {
      params: { userId, location },
      preview: { userId, location },
      instruction: `确认后执行 \`astra vr invites send ${userId} ${location} --confirm <token>\`。`,
    }
  },
  toExecute: (p) => ({ userId: String(p.userId), location: String(p.location) }),
  async execute(p, signal) {
    return actions.inviteToInstance(String(p.userId), String(p.location), signal)
  },
})

const statusCmd = writeCommand({
  name: 'vr status set',
  summary: '改自己的状态（需要确认）',
  usage: 'astra vr status set <offline|active|busy|join me|ask me> [--description 文字] [--confirm <token>]',
  action: 'status.set',
  minArgs: 1,
  maxArgs: 1,
  options: { description: { type: 'string', description: '状态说明文字', valueName: 'text' } },
  async prepare({ positionals, values }) {
    const status = positionals[0]!
    const allowed = ['offline', 'active', 'busy', 'join me', 'ask me']
    if (!allowed.includes(status)) throw invalidInput(`状态只能是：${allowed.join(' / ')}`)
    const description = (values.description as string | undefined) ?? null
    return {
      params: { status, description },
      preview: { status, description },
      instruction: `确认后执行 \`astra vr status set "${status}"${description ? ` --description "${description}"` : ''} --confirm <token>\`。`,
    }
  },
  toExecute: (p) => ({ status: String(p.status), description: p.description === null ? null : String(p.description) }),
  async execute(p, signal) {
    return actions.updateStatus(String(p.status), p.description === null ? null : String(p.description), signal)
  },
})

const notifyReadCmd = writeCommand({
  name: 'vr notifications read',
  summary: '把通知标记为已读（需要确认）',
  usage: 'astra vr notifications read <通知id> | --all [--confirm <token>]',
  action: 'notifications.read',
  maxArgs: 1,
  options: { all: { type: 'boolean', description: '全部标为已读' } },
  async prepare({ positionals, values }) {
    const all = values.all === true
    const id = positionals[0]
    if (!all && !id) throw invalidInput('需要通知 id，或者 --all', '先用 `astra vr notifications` 看有哪些')
    return {
      params: all ? { all: true } : { id },
      preview: all ? { all: true } : { id },
      instruction: all ? '确认后执行 `astra vr notifications read --all --confirm <token>`' : `确认后执行 \`astra vr notifications read ${id} --confirm <token>\``,
    }
  },
  toExecute: (p) => (p.all === true ? { all: true } : { id: String(p.id) }),
  async execute(p, signal) {
    if (p.all === true) return actions.clearNotifications(signal)
    return actions.markNotificationRead(String(p.id), signal)
  },
})

// ---------- 收藏分组管理 ----------

const favoriteGroupCreateCmd = writeCommand({
  name: 'vr favorites groups create',
  summary: '创建收藏分组（需要确认）',
  usage: 'astra vr favorites groups create <分组名> [--type world|avatar|friend] [--private] [--confirm <token>]',
  action: 'favorites.groups.create',
  minArgs: 1,
  maxArgs: 1,
  options: {
    type: { type: 'string', description: 'world（默认）/ avatar / friend', valueName: 'type' },
    private: { type: 'boolean', description: '只有自己可见' },
  },
  async prepare({ positionals, values, signal }) {
    const name = positionals[0]!
    const type = ((values.type as string | undefined) ?? 'world') as actions.FavoriteType
    if (!['world', 'avatar', 'friend'].includes(type)) throw invalidInput('--type 只能是 world / avatar / friend')
    // 同名分组已存在就不必再建
    const groups = await api.favoriteGroups({ type, signal })
    if (groups.some((g) => g.name === name)) {
      throw new AstraError('GROUP_EXISTS', `已经有叫「${name}」的 ${type} 分组了`, { exitCode: 2, hint: '换个名字，或直接用现有分组' })
    }
    const visible = values.private !== true
    return {
      params: { type, name, visible },
      preview: { type, name, visible, existingGroups: groups.map((g) => g.name) },
      instruction: `告诉用户要新建 ${type} 分组「${name}」（${visible ? '公开' : '仅自己可见'}），确认后执行 \`astra vr favorites groups create "${name}" --type ${type}${visible ? '' : ' --private'} --confirm <token>\`。`,
    }
  },
  toExecute: (p) => ({ type: String(p.type), name: String(p.name), visible: p.visible === true }),
  async execute(p, signal) {
    return actions.createFavoriteGroup({ type: p.type as actions.FavoriteType, name: String(p.name), visible: p.visible === true }, signal)
  },
})

const favoriteGroupDeleteCmd = writeCommand({
  name: 'vr favorites groups delete',
  summary: '删除收藏分组（需要确认；分组里的收藏会一起没）',
  usage: 'astra vr favorites groups delete <分组名> [--type world|avatar|friend] [--confirm <token>]',
  action: 'favorites.groups.delete',
  minArgs: 1,
  maxArgs: 1,
  options: { type: { type: 'string', description: 'world（默认）/ avatar / friend', valueName: 'type' } },
  async prepare({ positionals, values, signal }) {
    const name = positionals[0]!
    const type = ((values.type as string | undefined) ?? 'world') as actions.FavoriteType
    const groups = await api.favoriteGroups({ type, signal })
    const target = groups.find((g) => g.name === name)
    if (!target) throw new AstraError('GROUP_NOT_FOUND', `没有叫「${name}」的 ${type} 分组`, { exitCode: 4, hint: `现有分组：${groups.map((g) => g.name).join(', ') || '（无）'}` })
    return {
      params: { type, name },
      preview: { type, name, count: target.count, displayName: target.displayName },
      instruction: `**提醒用户这个分组里有 ${target.count} 个收藏，删分组会一起删掉**。确认后执行 \`astra vr favorites groups delete "${name}" --type ${type} --confirm <token>\`。`,
    }
  },
  toExecute: (p) => ({ type: String(p.type), name: String(p.name) }),
  async execute(p, signal) {
    // 上游删除按分组名
    return actions.deleteFavoriteGroup(String(p.name), signal)
  },
})

// ---------- 头像选择 ----------

const avatarSelectCmd = writeCommand({
  name: 'vr avatars select',
  summary: '切换当前头像（需要确认）',
  usage: 'astra vr avatars select <avtr_xxx> [--confirm <token>]',
  action: 'avatars.select',
  minArgs: 1,
  maxArgs: 1,
  async prepare({ positionals, signal }) {
    const id = positionals[0]!
    if (!/^avtr_[0-9a-f-]+$/i.test(id)) throw invalidInput(`「${id}」不像头像 id`, '形如 avtr_xxxxxxxx-xxxx-...；用 `astra vr avatars` 看自己的头像 id')
    // 先确认这个头像在自己名下，避免 AI 拿错 id
    const mine = await api.myAvatars({ limit: 100, signal })
    const target = mine.find((a) => a.id === id)
    const current = await api.currentAvatar(signal)
    return {
      params: { avatarId: id },
      preview: {
        avatarId: id,
        name: target?.name ?? null,
        owned: target !== undefined,
        current: current ? { id: current.id, name: current.name } : null,
        note: target === undefined ? '这个 id 不在你自己的头像列表里，上游可能会拒绝' : null,
      },
      instruction: `告诉用户要从「${current?.name ?? '当前头像'}」换成「${target?.name ?? id}」，确认后执行 \`astra vr avatars select ${id} --confirm <token>\`。`,
    }
  },
  toExecute: (p) => ({ avatarId: String(p.avatarId) }),
  async execute(p, signal) {
    return actions.selectAvatar(String(p.avatarId), signal)
  },
})

const avatarFallbackCmd = writeCommand({
  name: 'vr avatars fallback',
  summary: '设置回退头像（掉线时用，需要确认）',
  usage: 'astra vr avatars fallback <avtr_xxx> [--confirm <token>]',
  action: 'avatars.fallback',
  minArgs: 1,
  maxArgs: 1,
  async prepare({ positionals, signal }) {
    const id = positionals[0]!
    if (!/^avtr_[0-9a-f-]+$/i.test(id)) throw invalidInput(`「${id}」不像头像 id`, '用 `astra vr avatars` 看自己的头像 id')
    const mine = await api.myAvatars({ limit: 100, signal })
    const target = mine.find((a) => a.id === id)
    return {
      params: { avatarId: id },
      preview: { avatarId: id, name: target?.name ?? null, owned: target !== undefined },
      instruction: `确认后执行 \`astra vr avatars fallback ${id} --confirm <token>\`。`,
    }
  },
  toExecute: (p) => ({ avatarId: String(p.avatarId) }),
  async execute(p, signal) {
    return actions.selectFallbackAvatar(String(p.avatarId), signal)
  },
})

// ---------- 系统 ----------

const systemCmd: Command = {
  name: 'vr system',
  summary: 'VRChat 平台信息：在线人数、上游时间（都不用登录）',
  usage: 'astra vr system',
  maxArgs: 0,
  async run({ signal }) {
    const [users, time] = await Promise.all([api.onlineUsers(signal), api.serverTime(signal)])
    return { data: { onlineUsers: users, serverTime: time } }
  },
}

const permissionsCmd: Command = {
  name: 'vr permissions',
  summary: '平台的权限位清单（需要登录）',
  usage: 'astra vr permissions [--id <权限id>]',
  notes: [
    '这是 **VRChat 定义了哪些权限**，不是"我这个账号有哪些权限"',
    '--id 按 id 精确取一条',
  ],
  options: { id: { type: 'string', description: '按 id 取单个', valueName: 'id' } },
  maxArgs: 0,
  async run({ values, signal }) {
    if (typeof values.id === 'string') return { data: await api.permission(values.id, signal) }
    const list = await api.permissions(signal)
    return { data: { total: list.length, permissions: list } }
  },
}

// ---------- 群组详情 / 成员 / 角色 / 权限 / 公告 ----------

const groupInfoCmd: Command = {
  name: 'vr groups info',
  summary: '群组详情、成员、角色、启用权限与公告（一次拿全）',
  usage: 'astra vr groups info <grp_xxx> [--members 50] [--no-roles]',
  notes: [
    '群组权限（这个群开了哪些）和 `vr permissions`（平台定义了哪些）**不是一回事**，别混着说',
    '公告只读；发布公告不在这里',
  ],
  options: {
    members: { type: 'string', short: 'n', description: '列多少个成员，0 表示不列，默认 50', valueName: 'n' },
    'no-roles': { type: 'boolean', description: '不查角色列表' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const id = positionals[0]!
    const memberLimit = intOf(values.members, 50, 0, 100, 'members')
    const [detail, permissions, announcement] = await Promise.all([
      api.group(id, signal),
      api.groupPermissions(id, signal).catch(() => [] as string[]),
      api.groupAnnouncement(id, signal).catch(() => null),
    ])
    const data: Record<string, unknown> = {
      group: detail,
      permissions: { count: permissions.length, items: permissions },
      announcement,
    }
    if (memberLimit > 0) data.members = await groupMembersView(id, memberLimit, signal)
    if (values['no-roles'] !== true) {
      data.roles = (await api.groupRoles(id, signal).catch(() => [])).map((r) => ({ id: r.id, name: r.name, isDefault: r.isDefault, permissions: r.permissions.length, order: r.order }))
    }
    return { data }
  },
}

async function groupMembersView(groupId: string, limit: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  const list = await api.groupMembers(groupId, { limit, signal }).catch(() => [])
  return {
    count: list.length,
    items: list.map((m) => ({ userId: m.userId, displayName: m.displayName, joinedAt: m.joinedAt, isRepresentation: m.isRepresentation })),
    truncated: list.length >= limit,
  }
}

const groupMemberCmd: Command = {
  name: 'vr groups member',
  summary: '查某人在这个群里的身份（不在群里返回 inGroup: false）',
  usage: 'astra vr groups member <grp_xxx> <usr_xxx>',
  minArgs: 2,
  maxArgs: 2,
  async run({ positionals, signal }) {
    const [groupId, userId] = positionals as [string, string]
    const member = await api.groupMember(groupId, userId, signal)
    return { data: member === null ? { inGroup: false, groupId, userId } : { inGroup: true, ...member } }
  },
}

// ---------- 群组写操作 ----------

const groupJoinCmd = writeCommand({
  name: 'vr groups join',
  summary: '加入群组（需要确认；需审批的群只会变成"申请中"）',
  usage: 'astra vr groups join <grp_xxx> [--confirm <token>]',
  action: 'groups.join',
  minArgs: 1,
  maxArgs: 1,
  async prepare({ positionals, signal }) {
    const groupId = positionals[0]!
    const g = await api.group(groupId, signal)
    if (g.isMember) throw new AstraError('ALREADY_MEMBER', `你已经是「${g.name}」的成员了`, { exitCode: 2 })
    return {
      params: { groupId },
      preview: { groupId, name: g.name, memberCount: g.memberCount, shortCode: g.shortCode },
      instruction: `告诉用户要加入群组「${g.name}」（${g.memberCount ?? '?'} 人），确认后执行 \`astra vr groups join ${groupId} --confirm <token>\`。注意有些群需要审批，加入后只是"申请中"，要用 \`vr groups member\` 再确认。`,
    }
  },
  toExecute: (p) => ({ groupId: String(p.groupId) }),
  async execute(p, signal) {
    return actions.joinGroup(String(p.groupId), signal)
  },
})

const groupLeaveCmd = writeCommand({
  name: 'vr groups leave',
  summary: '退出群组（需要确认）',
  usage: 'astra vr groups leave <grp_xxx> [--confirm <token>]',
  action: 'groups.leave',
  minArgs: 1,
  maxArgs: 1,
  async prepare({ positionals, signal }) {
    const groupId = positionals[0]!
    // 只允许退自己真的在的群
    const g = await api.group(groupId, signal)
    if (!g.isMember) throw new AstraError('NOT_A_MEMBER', `你不在「${g.name}」里`, { exitCode: 4 })
    return {
      params: { groupId },
      preview: { groupId, name: g.name, memberCount: g.memberCount },
      instruction: `告诉用户要退出群组「${g.name}」，确认后执行 \`astra vr groups leave ${groupId} --confirm <token>\`。`,
    }
  },
  toExecute: (p) => ({ groupId: String(p.groupId) }),
  async execute(p, signal) {
    return actions.leaveGroup(String(p.groupId), signal)
  },
})

export const vrCommands: Command[] = [
  loginCmd, accountCmd, logoutCmd, doctorCmd,
  friendsCmd, friendRequestCmd, friendRemoveCmd,
  notificationsCmd, notifyReadCmd,
  worldCmd, searchWorldsCmd, instanceCmd,
  groupsCmd, searchGroupsCmd,
  avatarsCmd, favoritesCmd, favoriteAddCmd, favoriteRemoveCmd,
  economyCmd, transactionsCmd, statusCmd, inviteCmd,
  favoriteGroupCreateCmd, favoriteGroupDeleteCmd,
  avatarSelectCmd, avatarFallbackCmd,
  systemCmd, permissionsCmd,
  groupInfoCmd, groupMemberCmd, groupJoinCmd, groupLeaveCmd,
]

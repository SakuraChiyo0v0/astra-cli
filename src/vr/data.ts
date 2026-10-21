/**
 * VRChat 的只读数据接口：好友、用户、世界、实例、通知、收藏、群组、头像、经济。
 *
 * 只做"把上游的形状收拾干净"，不做业务判断。每个函数都返回精简后的对象，
 * 避免把 VRChat 那份几百字段的原始响应直接丢给 AI（又长又难读）。
 */
import { AstraError } from '../core/errors.ts'
import { getJson } from './api.ts'
import { cookieOf, loadSession, type VrSession } from './auth.ts'

function needSession(session?: VrSession): VrSession {
  const s = session ?? loadSession()
  if (!s) throw new AstraError('VRCHAT_NOT_LOGGED_IN', '还没登录 VRChat', { exitCode: 3, hint: '`astra vr login --username <账号> --password <密码>`' })
  return s
}

export interface VrUser {
  id: string
  displayName: string
  /** offline / active / busy / join me / ask me / 等。 */
  status: string | null
  statusDescription: string | null
  /** 当前在哪个世界（在线时才有）。 */
  worldId: string | null
  location: string | null
  /** 平台：standalonewindows / android / ios / web 等。 */
  platform: string | null
  lastLogin: string | null
  isFriend: boolean
  /** 好友分组（VRChat 的 group(0..3) 标签）。 */
  tags: string[]
}

interface RawUser {
  id?: string
  displayName?: string
  status?: string
  statusDescription?: string
  location?: string
  worldId?: string
  platform?: string
  last_login?: string
  isFriend?: boolean
  tags?: string[]
}

export function toUser(raw: RawUser): VrUser {
  const location = raw.location ?? null
  // VRChat 的 location 形如 `wrld_xxx:12345~region(us)`，离线时是 `offline`
  const worldId = raw.worldId ?? (location && location.startsWith('wrld_') ? location.split(':')[0]! : null)
  return {
    id: raw.id ?? '',
    displayName: raw.displayName ?? '',
    status: raw.status ?? null,
    statusDescription: raw.statusDescription ?? null,
    worldId,
    location,
    platform: raw.platform ?? null,
    lastLogin: raw.last_login ?? null,
    isFriend: raw.isFriend === true,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
  }
}

/** 好友列表。`onlineOnly` 只保留当前在线的。 */
export async function friends(options: { onlineOnly?: boolean; signal?: AbortSignal } = {}): Promise<VrUser[]> {
  const session = needSession()
  const raw = await getJson<RawUser[]>('/auth/user/friends', { cookie: cookieOf(session), ...(options.signal ? { signal: options.signal } : {}) })
  const list = (Array.isArray(raw) ? raw : []).map(toUser)
  if (options.onlineOnly) return list.filter((u) => u.location !== null && u.location !== 'offline' && u.location !== 'private')
  return list
}

export interface VrWorld {
  id: string
  name: string
  authorName: string | null
  description: string | null
  capacity: number | null
  occupants: number | null
  favorites: number | null
  visits: number | null
  releaseStatus: string | null
  thumbnailImageUrl: string | null
  updatedAt: string | null
  tags: string[]
}

interface RawWorld {
  id?: string
  name?: string
  authorName?: string
  authorId?: string
  description?: string
  capacity?: number
  occupants?: number
  favorites?: number
  visits?: number
  releaseStatus?: string
  thumbnailImageUrl?: string
  updated_at?: string
  tags?: string[]
}

export function toWorld(raw: RawWorld): VrWorld {
  return {
    id: raw.id ?? '',
    name: raw.name ?? '',
    authorName: raw.authorName ?? null,
    description: raw.description ?? null,
    capacity: raw.capacity ?? null,
    occupants: raw.occupants ?? null,
    favorites: raw.favorites ?? null,
    visits: raw.visits ?? null,
    releaseStatus: raw.releaseStatus ?? null,
    thumbnailImageUrl: raw.thumbnailImageUrl ?? null,
    updatedAt: raw.updated_at ?? null,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
  }
}

export async function world(worldId: string, signal?: AbortSignal): Promise<VrWorld> {
  const session = needSession()
  const raw = await getJson<RawWorld>(`/worlds/${encodeURIComponent(worldId)}`, { cookie: cookieOf(session), ...(signal ? { signal } : {}) })
  return toWorld(raw)
}

export async function searchWorlds(query: string, options: { limit?: number; offset?: number; signal?: AbortSignal } = {}): Promise<VrWorld[]> {
  const session = needSession()
  const raw = await getJson<RawWorld[]>('/worlds', {
    cookie: cookieOf(session),
    query: { search: query, n: options.limit ?? 20, offset: options.offset ?? 0 },
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return (Array.isArray(raw) ? raw : []).map(toWorld)
}

export interface VrInstance {
  /** `wrld_xxx:instanceId` 形式的完整地址。 */
  location: string
  worldId: string
  instanceId: string | null
  occupants: number | null
  capacity: number | null
  /** 这个实例是不是"公开"（private / friends+ / invite 等会标出来）。 */
  accessType: string | null
  region: string | null
  world: VrWorld | null
  /** 在里面的好友（上游给时有）。 */
  friendsInside: { id: string; displayName: string }[]
}

interface RawInstance {
  location?: string
  occupants?: number
  capacity?: number
  n_users?: number
  accessType?: string
  region?: string
  world?: RawWorld
  worldId?: string
  friends?: { id: string; displayName: string }[]
}

function parseLocation(location: string): { worldId: string; instanceId: string | null; region: string | null } {
  const [base] = location.split('~')
  const [worldId, instanceId] = (base ?? '').split(':')
  const regionMatch = location.match(/~region\(([^)]+)\)/)
  return { worldId: worldId ?? location, instanceId: instanceId ?? null, region: regionMatch?.[1] ?? null }
}

export function toInstance(raw: RawInstance): VrInstance {
  const location = raw.location ?? ''
  const parsed = parseLocation(location)
  return {
    location,
    worldId: raw.worldId ?? parsed.worldId,
    instanceId: parsed.instanceId,
    occupants: raw.occupants ?? raw.n_users ?? null,
    capacity: raw.capacity ?? null,
    accessType: raw.accessType ?? null,
    region: raw.region ?? parsed.region,
    world: raw.world ? toWorld(raw.world) : null,
    friendsInside: Array.isArray(raw.friends) ? raw.friends.map((f) => ({ id: f.id, displayName: f.displayName })) : [],
  }
}

export async function instance(location: string, signal?: AbortSignal): Promise<VrInstance> {
  const session = needSession()
  const raw = await getJson<RawInstance>(`/instances/${encodeURIComponent(location)}`, { cookie: cookieOf(session), ...(signal ? { signal } : {}) })
  return toInstance(raw)
}

/** 某世界当前的实例列表。 */
export async function worldInstances(worldId: string, signal?: AbortSignal): Promise<VrInstance[]> {
  const session = needSession()
  const raw = await getJson<RawInstance[]>(`/worlds/${encodeURIComponent(worldId)}/instances`, { cookie: cookieOf(session), ...(signal ? { signal } : {}) })
  return (Array.isArray(raw) ? raw : []).map(toInstance)
}

export interface VrNotification {
  id: string
  type: string
  message: string
  seen: boolean
  createdAt: string
  /** 发通知的人（好友请求、邀请这类才有）。 */
  senderUserId: string | null
  /** 关联的世界 / 群组 / 邀请 id。 */
  details: Record<string, unknown>
}

interface RawNotification {
  id?: string
  type?: string
  message?: string
  seen?: boolean
  created_at?: string
  senderUserId?: string
  details?: Record<string, unknown>
}

export function toNotification(raw: RawNotification): VrNotification {
  return {
    id: raw.id ?? '',
    type: raw.type ?? '',
    message: raw.message ?? '',
    seen: raw.seen === true,
    createdAt: raw.created_at ?? '',
    senderUserId: raw.senderUserId ?? null,
    details: raw.details ?? {},
  }
}

export async function notifications(options: { unreadOnly?: boolean; limit?: number; signal?: AbortSignal } = {}): Promise<VrNotification[]> {
  const session = needSession()
  const raw = await getJson<RawNotification[]>('/auth/user/notifications', {
    cookie: cookieOf(session),
    query: { n: options.limit ?? 50 },
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const list = (Array.isArray(raw) ? raw : []).map(toNotification)
  return options.unreadOnly ? list.filter((n) => !n.seen) : list
}

export interface VrFavorite {
  id: string
  type: string
  favoriteId: string
  tags: string[]
}

interface RawFavorite {
  id?: string
  type?: string
  favoriteId?: string
  tags?: string[]
}

export async function favorites(options: { type?: string; signal?: AbortSignal } = {}): Promise<VrFavorite[]> {
  const session = needSession()
  const raw = await getJson<RawFavorite[]>('/favorites', {
    cookie: cookieOf(session),
    query: { type: options.type ?? 'world' },
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return (Array.isArray(raw) ? raw : []).map((f) => ({ id: f.id ?? '', type: f.type ?? '', favoriteId: f.favoriteId ?? '', tags: Array.isArray(f.tags) ? f.tags : [] }))
}

export async function favoriteGroups(options: { type?: string; signal?: AbortSignal } = {}): Promise<{ name: string; displayName: string; count: number; capacity: number }[]> {
  const session = needSession()
  const raw = await getJson<{ name?: string; displayName?: string; count?: number; capacity?: number }[]>('/favorite/groups', {
    cookie: cookieOf(session),
    query: { type: options.type ?? 'world' },
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return (Array.isArray(raw) ? raw : []).map((g) => ({ name: g.name ?? '', displayName: g.displayName ?? '', count: g.count ?? 0, capacity: g.capacity ?? 0 }))
}

export interface VrGroup {
  id: string
  name: string
  shortCode: string | null
  description: string | null
  memberCount: number | null
  isMember: boolean
  joinedAt: string | null
  bannerUrl: string | null
  iconUrl: string | null
}

interface RawGroup {
  id?: string
  name?: string
  shortCode?: string
  description?: string
  memberCount?: number
  isMember?: boolean
  joinedAt?: string
  bannerUrl?: string
  iconUrl?: string
}

export function toGroup(raw: RawGroup): VrGroup {
  return {
    id: raw.id ?? '',
    name: raw.name ?? '',
    shortCode: raw.shortCode ?? null,
    description: raw.description ?? null,
    memberCount: raw.memberCount ?? null,
    isMember: raw.isMember === true,
    joinedAt: raw.joinedAt ?? null,
    bannerUrl: raw.bannerUrl ?? null,
    iconUrl: raw.iconUrl ?? null,
  }
}

export async function myGroups(options: { limit?: number; offset?: number; signal?: AbortSignal } = {}): Promise<VrGroup[]> {
  const session = needSession()
  const me = await getJson<{ id?: string }>('/auth/user', { cookie: cookieOf(session), ...(options.signal ? { signal: options.signal } : {}) })
  if (!me.id) throw new AstraError('VRCHAT_NO_USER_ID', '拿不到自己的用户 id', { exitCode: 5 })
  const raw = await getJson<RawGroup[]>('/users/' + encodeURIComponent(me.id) + '/groups', {
    cookie: cookieOf(session),
    query: { n: options.limit ?? 50, offset: options.offset ?? 0 },
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return (Array.isArray(raw) ? raw : []).map(toGroup)
}

export async function group(groupId: string, signal?: AbortSignal): Promise<VrGroup> {
  const session = needSession()
  return toGroup(await getJson<RawGroup>(`/groups/${encodeURIComponent(groupId)}`, { cookie: cookieOf(session), ...(signal ? { signal } : {}) }))
}

export async function searchGroups(query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<VrGroup[]> {
  const session = needSession()
  const raw = await getJson<RawGroup[]>('/groups', {
    cookie: cookieOf(session),
    query: { query, n: options.limit ?? 20 },
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return (Array.isArray(raw) ? raw : []).map(toGroup)
}

export interface VrAvatar {
  id: string
  name: string
  description: string | null
  authorName: string | null
  releaseStatus: string | null
  thumbnailImageUrl: string | null
  updatedAt: string | null
}

interface RawAvatar {
  id?: string
  name?: string
  description?: string
  authorName?: string
  releaseStatus?: string
  thumbnailImageUrl?: string
  updated_at?: string
}

export function toAvatar(raw: RawAvatar): VrAvatar {
  return {
    id: raw.id ?? '',
    name: raw.name ?? '',
    description: raw.description ?? null,
    authorName: raw.authorName ?? null,
    releaseStatus: raw.releaseStatus ?? null,
    thumbnailImageUrl: raw.thumbnailImageUrl ?? null,
    updatedAt: raw.updated_at ?? null,
  }
}

export async function myAvatars(options: { limit?: number; signal?: AbortSignal } = {}): Promise<VrAvatar[]> {
  const session = needSession()
  const raw = await getJson<RawAvatar[]>('/avatars', {
    cookie: cookieOf(session),
    query: { user: 'me', n: options.limit ?? 50 },
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return (Array.isArray(raw) ? raw : []).map(toAvatar)
}

/** 当前选中的头像。上游 404 表示还没选过，这里返回 null 而不是报错。 */
export async function currentAvatar(signal?: AbortSignal): Promise<VrAvatar | null> {
  const session = needSession()
  try {
    const raw = await getJson<RawAvatar>('/avatars/avatar/current', { cookie: cookieOf(session), ...(signal ? { signal } : {}) })
    return toAvatar(raw)
  } catch (err) {
    if (err instanceof AstraError && err.code === 'VRCHAT_NOT_FOUND') return null
    throw err
  }
}

export interface VrBalance {
  balance: number | null
  /** 活跃支持者的等级 / 是否订阅等，上游给什么就带什么。 */
  subscription: Record<string, unknown> | null
}

/**
 * 余额（`GET /user/{id}/balance`，需要登录）。
 *
 * 只读，不包含购买或付款。上游没给就是 null，不补 0 —— 0 和"没数据"是两回事。
 */
export async function balance(signal?: AbortSignal): Promise<VrBalance> {
  const session = needSession()
  const id = await selfId(signal)
  const raw = await getJson<{ balance?: number; subscriptions?: unknown }>(`/user/${encodeURIComponent(id)}/balance`, {
    cookie: cookieOf(session),
    ...(signal ? { signal } : {}),
  })
  return { balance: typeof raw.balance === 'number' ? raw.balance : null, subscription: (raw.subscriptions as Record<string, unknown>) ?? null }
}

export interface VrTransaction {
  id: string
  status: string | null
  /** 交易类型：purchase / subscription 等，上游给什么就带什么。 */
  type: string | null
  description: string | null
  amount: number | null
  balance: number | null
  createdAt: string | null
  /** 原始字段整体保留：交易详情随版本变化，宁可多带不乱解释。 */
  raw: Record<string, unknown>
}

/**
 * 交易明细（`GET /user/{id}/economy/transactions`，需要登录）。
 *
 * status 已知取值 active / failed / succeeded / cancelled；**出现新取值时原样转述**，
 * 不拒绝也不改写。只读，不发起任何交易。
 */
export async function transactions(options: { limit?: number; offset?: number; signal?: AbortSignal } = {}): Promise<VrTransaction[]> {
  const session = needSession()
  const id = await selfId(options.signal)
  const raw = await getJson<Record<string, unknown>[]>(`/user/${encodeURIComponent(id)}/economy/transactions`, {
    cookie: cookieOf(session),
    query: { n: options.limit ?? 20, offset: options.offset ?? 0 },
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return (Array.isArray(raw) ? raw : []).map((t) => ({
    id: typeof t.id === 'string' ? t.id : '',
    status: typeof t.status === 'string' ? t.status : null,
    type: typeof t.type === 'string' ? t.type : null,
    description: typeof t.description === 'string' ? t.description : null,
    amount: typeof t.amount === 'number' ? t.amount : null,
    balance: typeof t.balance === 'number' ? t.balance : null,
    createdAt: typeof t.created_at === 'string' ? t.created_at : null,
    raw: t,
  }))
}

/** 各类型收藏的数量上限（`GET /auth/user/favoritelimits`）。三种分开给，不合并。 */
export async function favoriteLimits(signal?: AbortSignal): Promise<{ avatar: number | null; friend: number | null; world: number | null }> {
  const session = needSession()
  const raw = await getJson<{ avatar?: number; friend?: number; world?: number }>('/auth/user/favoritelimits', {
    cookie: cookieOf(session),
    ...(signal ? { signal } : {}),
  })
  const pick = (v: unknown): number | null => (typeof v === 'number' ? v : null)
  return { avatar: pick(raw.avatar), friend: pick(raw.friend), world: pick(raw.world) }
}

async function selfId(signal?: AbortSignal): Promise<string> {
  const session = needSession()
  const me = await getJson<{ id?: string }>('/auth/user', { cookie: cookieOf(session), ...(signal ? { signal } : {}) })
  if (!me.id) throw new AstraError('VRCHAT_NO_USER_ID', '拿不到自己的用户 id', { exitCode: 5 })
  return me.id
}

/**
 * 连通性探活。
 *
 * `/health` 实测需要登录（401），`/config` 免认证但返回几十 KB。
 * 所以用 `/config` 探活、只取一个字段判断，不把整份配置带回来。
 */
export async function probeApi(signal?: AbortSignal): Promise<{ reachable: boolean; detail: string }> {
  try {
    const cfg = await getJson<{ availableLanguageCodes?: string[] }>('/config', { ...(signal ? { signal } : {}) })
    const languages = Array.isArray(cfg.availableLanguageCodes) ? cfg.availableLanguageCodes.length : 0
    return { reachable: true, detail: languages > 0 ? `可达（${languages} 种语言可用）` : '可达' }
  } catch (err) {
    return { reachable: false, detail: (err as Error).message }
  }
}

// ---------- 系统与权限 ----------

/** 在线人数（`GET /visits` 免认证，上游直接返回一个数字）。 */
export async function onlineUsers(signal?: AbortSignal): Promise<number> {
  const raw = await getJson<number>('/visits', { ...(signal ? { signal } : {}) })
  return typeof raw === 'number' ? raw : 0
}

/**
 * 上游时间（`GET /time` 免认证）。
 *
 * 实测 2026-10-21 返回标准 ISO `2026-10-21T10:23:31+00:00`；
 * astrahub 在 2026-09 记录的是 `09/23/2026 20:35:32` —— 上游改过格式。
 * 所以这里**原样返回字符串**，不解析、不换算时区。
 */
export async function serverTime(signal?: AbortSignal): Promise<string> {
  const raw = await getJson<string>('/time', { ...(signal ? { signal } : {}) })
  return typeof raw === 'string' ? raw : String(raw)
}

export interface VrPermission {
  id: string
  name: string
  /** 权限所属的域，例如 friends / worlds。 */
  ownerId: string | null
  displayName: string | null
  description: string | null
}

interface RawPermission {
  id?: string
  name?: string
  ownerId?: string
  displayName?: string
  description?: string
}

/**
 * 平台的权限位清单（`GET /permissions`，**需要登录**）。
 *
 * 注意这是"VRChat 定义了哪些权限"，**不是"我这个账号有哪些权限"** —— 别把它当成后者转述。
 */
export function permissionFrom(raw: RawPermission): VrPermission {
  return {
    id: raw.id ?? '',
    name: raw.name ?? '',
    ownerId: raw.ownerId ?? null,
    displayName: raw.displayName ?? null,
    description: raw.description ?? null,
  }
}

export async function permissions(signal?: AbortSignal): Promise<VrPermission[]> {
  const session = needSession()
  const raw = await getJson<RawPermission[]>('/permissions', { cookie: cookieOf(session), ...(signal ? { signal } : {}) })
  return (Array.isArray(raw) ? raw : []).map(permissionFrom)
}

/** 单个权限位。 */
export async function permission(id: string, signal?: AbortSignal): Promise<VrPermission> {
  const all = await permissions(signal)
  const found = all.find((p) => p.id === id)
  if (!found) throw new AstraError('VRCHAT_PERMISSION_NOT_FOUND', `没有 id 为 ${id} 的权限位`, { exitCode: 4 })
  return found
}

// ---------- 群组成员 / 角色 / 权限 / 公告 ----------

export interface VrGroupMember {
  userId: string
  displayName: string | null
  roleIds: string[]
  joinedAt: string | null
  /** 在群组里的可见性：public / private 等。 */
  visibility: string | null
  isRepresentation: boolean
}

interface RawGroupMember {
  userId?: string
  user?: { displayName?: string }
  displayName?: string
  roleIds?: string[]
  joinedAt?: string
  visibility?: string
  isRepresentation?: boolean
}

export function toGroupMember(raw: RawGroupMember): VrGroupMember {
  return {
    userId: raw.userId ?? '',
    displayName: raw.user?.displayName ?? raw.displayName ?? null,
    roleIds: Array.isArray(raw.roleIds) ? raw.roleIds : [],
    joinedAt: raw.joinedAt ?? null,
    visibility: raw.visibility ?? null,
    isRepresentation: raw.isRepresentation === true,
  }
}

export async function groupMembers(groupId: string, options: { limit?: number; offset?: number; signal?: AbortSignal } = {}): Promise<VrGroupMember[]> {
  const session = needSession()
  const raw = await getJson<RawGroupMember[]>(`/groups/${encodeURIComponent(groupId)}/members`, {
    cookie: cookieOf(session),
    query: { n: options.limit ?? 50, offset: options.offset ?? 0 },
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return (Array.isArray(raw) ? raw : []).map(toGroupMember)
}

/**
 * 查某个成员在群组里的身份。
 * 上游 404 = 这个人不在群里（不是错误），返回 null。
 */
export async function groupMember(groupId: string, userId: string, signal?: AbortSignal): Promise<VrGroupMember | null> {
  const session = needSession()
  try {
    const raw = await getJson<RawGroupMember>(`/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, {
      cookie: cookieOf(session),
      ...(signal ? { signal } : {}),
    })
    return toGroupMember(raw)
  } catch (err) {
    if (err instanceof AstraError && err.code === 'VRCHAT_NOT_FOUND') return null
    throw err
  }
}

export interface VrGroupRole {
  id: string
  name: string
  description: string | null
  /** 角色带哪些权限（字符串列表）。 */
  permissions: string[]
  /** 默认角色（新人自动获得）。 */
  isDefault: boolean
  /** 这个角色在群组里的排序位。 */
  order: number | null
}

interface RawGroupRole {
  id?: string
  name?: string
  description?: string
  permissions?: string[]
  isDefault?: boolean
  order?: number
}

export function toGroupRole(raw: RawGroupRole): VrGroupRole {
  return {
    id: raw.id ?? '',
    name: raw.name ?? '',
    description: raw.description ?? null,
    permissions: Array.isArray(raw.permissions) ? raw.permissions : [],
    isDefault: raw.isDefault === true,
    order: typeof raw.order === 'number' ? raw.order : null,
  }
}

export async function groupRoles(groupId: string, signal?: AbortSignal): Promise<VrGroupRole[]> {
  const session = needSession()
  const raw = await getJson<RawGroupRole[]>(`/groups/${encodeURIComponent(groupId)}/roles`, { cookie: cookieOf(session), ...(signal ? { signal } : {}) })
  return (Array.isArray(raw) ? raw : []).map(toGroupRole)
}

/**
 * 群组自身的权限字符串（`GET /groups/{id}/permissions`）。
 *
 * **和 `vr permissions` 不是一回事**：那个是平台定义的全部权限位，
 * 这个是**这个群组启用了哪些**。不要混着说。
 */
export async function groupPermissions(groupId: string, signal?: AbortSignal): Promise<string[]> {
  const session = needSession()
  const raw = await getJson<string[]>(`/groups/${encodeURIComponent(groupId)}/permissions`, { cookie: cookieOf(session), ...(signal ? { signal } : {}) })
  return (Array.isArray(raw) ? raw : []).filter((x): x is string => typeof x === 'string')
}

export interface VrGroupAnnouncement {
  title: string | null
  text: string | null
  createdAt: string | null
  authorId: string | null
}

export async function groupAnnouncement(groupId: string, signal?: AbortSignal): Promise<VrGroupAnnouncement> {
  const session = needSession()
  const raw = await getJson<{ title?: string; text?: string; createdAt?: string; authorId?: string }>(`/groups/${encodeURIComponent(groupId)}/announcement`, {
    cookie: cookieOf(session),
    ...(signal ? { signal } : {}),
  })
  return { title: raw.title ?? null, text: raw.text ?? null, createdAt: raw.createdAt ?? null, authorId: raw.authorId ?? null }
}

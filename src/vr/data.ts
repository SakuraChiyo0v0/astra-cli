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

export async function balance(signal?: AbortSignal): Promise<VrBalance> {
  const session = needSession()
  const raw = await getJson<{ balance?: number; subscriptions?: unknown }>('/user/subscription', { cookie: cookieOf(session), ...(signal ? { signal } : {}) })
  return { balance: typeof raw.balance === 'number' ? raw.balance : null, subscription: (raw.subscriptions as Record<string, unknown>) ?? null }
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

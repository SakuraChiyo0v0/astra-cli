/**
 * VRChat 的写操作：好友请求、收藏、邀请、改自己的状态。
 *
 * 全部走 `core/confirm.ts` 的二次确认：先预览拿令牌，带 `--confirm` 才执行。
 * 这里的函数只负责"执行"，预览与令牌由命令层调用 confirm 模块完成。
 */
import { AstraError } from '../core/errors.ts'
import { request } from './api.ts'
import { cookieOf, loadSession, type VrSession } from './auth.ts'

function needSession(): VrSession {
  const s = loadSession()
  if (!s) throw new AstraError('VRCHAT_NOT_LOGGED_IN', '还没登录 VRChat', { exitCode: 3, hint: '`astra vr login --username <账号> --password <密码>`' })
  return s
}

export interface ActionResult {
  ok: boolean
  /** 上游返回的关键字段（比如新好友请求的 id），没有就 null。 */
  detail: Record<string, unknown> | null
}

async function send(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<ActionResult> {
  const session = needSession()
  const { status, data } = await request<Record<string, unknown>>(method, path, {
    cookie: cookieOf(session),
    ...(body === undefined ? {} : { body }),
    ...(signal ? { signal } : {}),
  })
  // 204 / 空响应也算成功
  return { ok: status < 400, detail: data ?? null }
}

/** 加好友（发好友请求）。 */
export async function sendFriendRequest(userId: string, signal?: AbortSignal): Promise<ActionResult> {
  return send('POST', '/user/' + encodeURIComponent(userId) + '/friendRequest', undefined, signal)
}

/** 取消（撤回）自己发出去的好友请求。 */
export async function cancelFriendRequest(userId: string, signal?: AbortSignal): Promise<ActionResult> {
  return send('DELETE', '/user/' + encodeURIComponent(userId) + '/friendRequest', undefined, signal)
}

/** 删除好友（双向解除）。 */
export async function removeFriend(userId: string, signal?: AbortSignal): Promise<ActionResult> {
  return send('DELETE', '/auth/user/friends/' + encodeURIComponent(userId), undefined, signal)
}

export type FavoriteType = 'world' | 'avatar' | 'friend'

/** 收藏一个世界 / 头像 / 好友。`tags` 是收藏分组名（上游的 group）。 */
export async function addFavorite(type: FavoriteType, favoriteId: string, tags: string, signal?: AbortSignal): Promise<ActionResult> {
  return send('POST', '/favorites', { type, favoriteId, tags }, signal)
}

export async function removeFavorite(favoriteId: string, signal?: AbortSignal): Promise<ActionResult> {
  return send('DELETE', '/favorites/' + encodeURIComponent(favoriteId), undefined, signal)
}

/** 邀请好友加入某个实例。`location` 是 `wrld_xxx:instance` 形式的完整地址。 */
export async function inviteToInstance(userId: string, location: string, signal?: AbortSignal): Promise<ActionResult> {
  return send('POST', '/invite/' + encodeURIComponent(userId), { instanceId: location, worldId: location.split(':')[0] ?? location, rsvp: true }, signal)
}

/** 邀请自己（相当于"进这个房间"的快捷方式）。 */
export async function inviteSelf(location: string, signal?: AbortSignal): Promise<ActionResult> {
  return send('POST', '/invite/myself/to/' + encodeURIComponent(location), undefined, signal)
}

/** 回应收到的邀请（接受 / 拒绝）。 */
export async function respondToInvite(notificationId: string, action: 'accept' | 'decline', signal?: AbortSignal): Promise<ActionResult> {
  return send('POST', '/invite/' + encodeURIComponent(notificationId) + '/response', { responseSlot: action === 'accept' ? 1 : 0 }, signal)
}

/** 改自己的状态。`status` 是 offline/active/busy/join me/ask me 之一。 */
export async function updateStatus(status: string, statusDescription: string | null, signal?: AbortSignal): Promise<ActionResult> {
  const id = await selfId(signal)
  const body: Record<string, unknown> = { status }
  if (statusDescription !== null) body.statusDescription = statusDescription
  return send('PUT', `/users/${encodeURIComponent(id)}`, body, signal)
}

async function selfId(signal?: AbortSignal): Promise<string> {
  const session = needSession()
  const { data } = await request<{ id?: string }>('GET', '/auth/user', { cookie: cookieOf(session), ...(signal ? { signal } : {}) })
  if (!data?.id) throw new AstraError('VRCHAT_NO_USER_ID', '拿不到自己的用户 id', { exitCode: 5 })
  return data.id
}

/** 把通知标记为已读。 */
export async function markNotificationRead(notificationId: string, signal?: AbortSignal): Promise<ActionResult> {
  return send('PUT', '/auth/user/notifications/' + encodeURIComponent(notificationId) + '/see', undefined, signal)
}

/** 清空所有通知。 */
export async function clearNotifications(signal?: AbortSignal): Promise<ActionResult> {
  return send('PUT', '/auth/user/notifications/clear', undefined, signal)
}

/**
 * Steam 凭据：Web API key 与 SteamID64。
 *
 * 实测（2026-10-21，NAS 上）哪些接口需要 key：
 * - `IWishlistService/GetWishlist` **不需要 key**（有公开愿望单的账号直接能读）
 * - `ISteamUser/*`、大部分 `IPlayerService/*` **需要 key**
 * - 库存（`steamcommunity.com/inventory`）不需要 key，但该域名在 NAS 上直连不通，要走代理
 *
 * key 存在 `<ASTRA_HOME>/steam-credentials.json`，权限 600，不回显。
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homePath } from '../core/paths.ts'
import { AstraError } from '../core/errors.ts'

export interface SteamCredentials {
  /** Web API key（32 位十六进制）。留空时只有愿望单这类免 key 接口可用。 */
  apiKey: string | null
  /** 默认 SteamID64 —— 大多数命令不传 --user 时用它。 */
  steamId64: string | null
  /**
   * 客户端登录态（`astra steam login` 扫码拿到的 refreshToken）。
   *
   * 它等价于「这台机器能一直以你的身份登录 Steam」，所以只存本机、权限 600、
   * 任何输出里都不回显（只给指纹）。挂时长必须靠它，Web API key 做不到。
   */
  refreshToken?: string | null
  /** refreshToken 对应的账号名（登录时 Steam 告诉我们）。 */
  accountName?: string | null
  savedAt: string
}

function credentialsFile(): string {
  return homePath('steam-credentials.json')
}

export function loadSteamCredentials(): SteamCredentials | null {
  try {
    const parsed = JSON.parse(readFileSync(credentialsFile(), 'utf8')) as SteamCredentials
    if (!parsed.steamId64 && !parsed.apiKey && !parsed.refreshToken) return null
    return parsed
  } catch {
    return null
  }
}

export function saveSteamCredentials(credentials: Omit<SteamCredentials, 'savedAt'>): SteamCredentials {
  const record: SteamCredentials = { ...credentials, savedAt: new Date().toISOString() }
  const file = credentialsFile()
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  chmodSync(file, 0o600)
  return record
}

export function clearSteamCredentials(): boolean {
  if (!existsSync(credentialsFile())) return false
  rmSync(credentialsFile(), { force: true })
  return true
}

/** key 的指纹，用于"是不是同一个 key"的判断，不泄露内容。 */
export function apiKeyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

/**
 * 校验 SteamID64 的形状：17 位数字、属于公开个人账号（universe=1、类型=1）。
 *
 * 这里只做**格式**校验，不发请求确认账号存在 —— 格式对不代表账号存在，
 * 也不代表愿望单公开。那些要靠调接口时的返回判断。
 */
export function validateSteamId64(value: string): string | null {
  const text = value.trim()
  if (!/^\d{17}$/.test(text)) return 'SteamID64 是 17 位数字'
  // 首位 7656 是个人账号的固定前缀（个体账号的 universe/type/instance 编码）
  if (!text.startsWith('7656')) return '个人账号的 SteamID64 以 7656 开头'
  return null
}

/** 从 SteamID64 反推 32 位的 AccountID（部分接口用）。 */
export function accountIdFromSteamId64(steamId64: string): string {
  const value = BigInt(steamId64) - 76561197960265728n
  return value.toString()
}

/**
 * 需要 key 的接口在没配 key 时给出明确指引，而不是让上游返回 403。
 */
export function requireApiKey(credentials: SteamCredentials | null): string {
  const key = credentials?.apiKey
  if (!key) {
    throw new AstraError('STEAM_NO_API_KEY', '这个接口需要 Steam Web API key', {
      exitCode: 3,
      hint: '到 https://steamcommunity.com/dev/apikey 申请（免费），然后 `astra steam auth set-key <key>`',
    })
  }
  return key
}

/** 取默认 SteamID64，没有就报错。 */
export function requireSteamId(credentials: SteamCredentials | null): string {
  const id = credentials?.steamId64
  if (!id) {
    throw new AstraError('STEAM_NO_STEAMID', '没有设置默认 SteamID64', {
      exitCode: 3,
      hint: '`astra steam auth set-user <17 位 SteamID64>`，或命令里加 --user',
    })
  }
  return id
}

/** refreshToken 的指纹：用来判断「还是不是同一个登录态」，不泄露内容。 */
export function refreshTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8)
}

/**
 * 取客户端登录态（refreshToken）。挂时长 / 任何需要「以你的身份在线」的操作都要它。
 */
export function requireRefreshToken(credentials: SteamCredentials | null): string {
  const token = credentials?.refreshToken
  if (!token) {
    throw new AstraError('STEAM_NOT_LOGGED_IN', '还没有 Steam 客户端登录态', {
      exitCode: 3,
      hint: '先跑 `astra steam login` 扫码登录（只存 refreshToken，不存密码）',
    })
  }
  return token
}

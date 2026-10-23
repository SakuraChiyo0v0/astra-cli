/**
 * Steam 运行时状态：登录 / 挂时长的状态文件，以及后台进程的生死判断。
 *
 * 为什么要状态文件：`steam idle start` 起一个**分离进程**常驻（Steam 要求客户端
 * 一直在线，进程一退就掉线），父进程立刻返回。之后 `steam idle status` 只能靠
 * 这个文件知道它还在不在挂、挂在哪个游戏、重连了几次。
 *
 * 文件都在 `<ASTRA_HOME>` 下，权限 600：里面有账号名和二维码内容，不放密码，
 * refreshToken 只存在 `steam-credentials.json` 里。
 */
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { homePath } from '../core/paths.ts'
import { AstraError } from '../core/errors.ts'

export type IdleStatus = 'starting' | 'online' | 'failed' | 'stopped'
export type LoginStatus = 'starting' | 'waiting_scan' | 'done' | 'failed' | 'cancelled'

export interface IdleState {
  /** 常驻进程 pid。进程没了但状态还是 online → 判定为意外中断。 */
  pid: number
  appIDs: number[]
  games: string[]
  status: IdleStatus
  /** 上线时间（ISO）。掉线重连后会被刷新。 */
  connectedAt: string | null
  startedAt: string
  updatedAt: string
  /** 掉线自动重连的次数。 */
  reconnects: number
  /** 最近一次错误（掉线原因 / 登录失败）。 */
  error: string | null
  /** 走代理的地址，空表示直连 CM。 */
  proxy: string | null
}

export interface LoginState {
  pid: number
  status: LoginStatus
  /** 二维码 PNG 的绝对路径（给 Hermes 发图用）。 */
  qrPng: string | null
  /** 二维码里的原始 URL，文字回复里要一起给。 */
  qrContent: string | null
  accountName: string | null
  error: string | null
  /** 二维码过期时间（ISO）。扫码要在这个时间之前完成。 */
  expiresAt: string | null
  startedAt: string
  updatedAt: string
}

type Kind = 'login' | 'idle'

function stateFile(kind: Kind): string {
  return homePath(`steam-${kind}.json`)
}

/** 写状态文件：先写再 chmod —— 光靠 writeFileSync 的 mode 在某些文件系统上不生效。 */
function writeRaw(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
  chmodSync(file, 0o600)
}

export function readState(kind: 'idle'): IdleState | null
export function readState(kind: 'login'): LoginState | null
export function readState(kind: Kind): IdleState | LoginState | null
export function readState(kind: Kind): IdleState | LoginState | null {
  try {
    return JSON.parse(readFileSync(stateFile(kind), 'utf8')) as IdleState | LoginState
  } catch {
    return null
  }
}

/** 合并写：只传要改的字段。每次都会刷新 `updatedAt`（心跳就靠它）。 */
export function writeState(kind: 'idle', patch: Partial<IdleState>): IdleState
export function writeState(kind: 'login', patch: Partial<LoginState>): LoginState
export function writeState(kind: Kind, patch: object): IdleState | LoginState
export function writeState(kind: Kind, patch: object): IdleState | LoginState {
  const current = readState(kind) ?? {}
  const next = Object.assign({}, current, patch, { updatedAt: new Date().toISOString() })
  writeRaw(stateFile(kind), next)
  return next as IdleState | LoginState
}

/** 起一个空状态（第一次写时把 startedAt 定下来）。 */
export function initState(kind: 'idle', base: Omit<IdleState, 'updatedAt'>): IdleState
export function initState(kind: 'login', base: Omit<LoginState, 'updatedAt'>): LoginState
export function initState(kind: Kind, base: object): IdleState | LoginState
export function initState(kind: Kind, base: object): IdleState | LoginState {
  const next = Object.assign({}, base, { updatedAt: new Date().toISOString() })
  writeRaw(stateFile(kind), next)
  return next as IdleState | LoginState
}

export function clearState(kind: Kind): void {
  rmSync(stateFile(kind), { force: true })
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = 进程在，但不是我们的；ESRCH = 真没了
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 起分离进程跑内部 worker。
 *
 * 和 `core/jobs.ts` 的 spawnWorker 同一套办法：detached + unref + 日志落盘，
 * 父进程退出不影响它。开发态（.ts）和打包态（.mjs）都用当前入口与 execArgv。
 */
export function spawnDetached(args: string[], logName: string, extraEnv: Record<string, string> = {}): number {
  const logDir = homePath('logs')
  mkdirSync(logDir, { recursive: true })
  const log = openSync(path.join(logDir, `${logName}.log`), 'a')
  const entry = process.argv[1]
  if (!entry) throw new AstraError('INTERNAL', '无法确定 CLI 入口文件', { exitCode: 1 })
  const child = spawn(process.execPath, [...process.execArgv, entry, ...args], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: { ...process.env, ASTRA_QUIET: '0', ...extraEnv },
  })
  child.unref()
  const pid = child.pid
  if (!pid) throw new AstraError('INTERNAL', '后台进程没起来', { exitCode: 1 })
  return pid
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等状态文件变成期望的状态，超时返回最后读到的（可能仍是中间态）。 */
export async function waitForState<T extends IdleState | LoginState>(
  kind: Kind,
  accept: (state: T | null) => boolean,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  const read = (): T | null => readState(kind) as T | null
  let last = read()
  while (Date.now() < deadline) {
    last = read()
    if (accept(last)) return last
    await sleep(intervalMs)
  }
  return last
}

/** SIGTERM 之后等它自己退；超时就 SIGKILL。 */
export async function terminate(pid: number, graceMs = 5000): Promise<boolean> {
  if (!pidAlive(pid)) return true
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return true
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await sleep(150)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return true
  }
  await sleep(200)
  return !pidAlive(pid)
}

export function logFileExists(logName: string): boolean {
  return existsSync(path.join(homePath('logs'), `${logName}.log`))
}

export function logPath(logName: string): string {
  return path.join(homePath('logs'), `${logName}.log`)
}

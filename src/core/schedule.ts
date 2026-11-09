/**
 * 内置调度：`astra schedule`。
 *
 * 为什么需要它：astra 原来只会「执行」，定时全靠宿主（Hermes cron / 系统 crontab）。
 * 要做到「离开 Hermes 也能用」，调度得自己有一份最小实现。
 *
 * 形态刻意做成**无守护进程**：`astra schedule tick` 跑所有到期的任务，由宿主的
 * crontab / systemd timer / Hermes cron 每分钟调一次即可。这样：
 * - 不需要常驻进程和 pid 文件
 * - 机器重启后不需要恢复状态（下次 tick 按 next_run_at 补跑）
 * - 谁调它都行，Windows 任务计划也能用
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import path from 'node:path'
import { all, num, one, run } from './state.ts'
import { AstraError, invalidInput } from './errors.ts'
import { homePath } from './paths.ts'
import { currentIdentity, currentToken } from './identity.ts'
import { record as recordAudit } from './audit.ts'

export interface Schedule {
  name: string
  command: string
  intervalMin: number
  enabled: boolean
  owner: string | null
  lastRunAt: string | null
  nextRunAt: string | null
  lastStatus: string | null
  createdAt: string
}

const INTERVAL_RE = /^(\d+)\s*(s|m|h|d)?$/i

/** `30` / `30m` / `6h` / `1d` → 分钟。最小 1 分钟。 */
export function parseInterval(raw: string): number {
  const m = INTERVAL_RE.exec(raw.trim())
  if (!m) throw invalidInput(`无法解析间隔：${raw}`, '写法：30m / 6h / 1d，或直接给分钟数')
  const n = Number(m[1])
  const unit = (m[2] ?? 'm').toLowerCase()
  const minutes = unit === 's' ? Math.ceil(n / 60) : unit === 'h' ? n * 60 : unit === 'd' ? n * 1440 : n
  if (minutes < 1) throw invalidInput('间隔最小 1 分钟', '例如 `--every 1m`')
  return minutes
}

/** 受限主体只看到自己建的计划。 */
function ownerScope(): string | null {
  const identity = currentIdentity()
  return identity.kind === 'owner' ? null : identity.name
}

function rowToSchedule(row: Record<string, unknown>): Schedule {
  return {
    name: String(row.name),
    command: String(row.command),
    intervalMin: num(row.interval_min),
    enabled: num(row.enabled) === 1,
    owner: row.owner === null || row.owner === undefined ? null : String(row.owner),
    lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
    nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
    lastStatus: row.last_status ? String(row.last_status) : null,
    createdAt: String(row.created_at),
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function plusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString()
}

export async function addSchedule(input: { name: string; command: string; interval: string; runNow?: boolean }): Promise<Schedule> {
  const name = input.name.trim()
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(name)) {
    throw invalidInput(`任务名不合法：${name}`, '小写字母/数字/下划线/短横线，最长 48 位')
  }
  const command = input.command.trim()
  if (!command) throw invalidInput('缺少 --cmd', '例如 `--cmd "music subscribe run"`')
  if (command.startsWith('astra ')) throw invalidInput('--cmd 不用写 astra 前缀', '例如 `--cmd "music subscribe run"`')
  const intervalMin = parseInterval(input.interval)

  const exists = await one('select 1 as x from schedules where name = ?', [name])
  if (exists) throw invalidInput(`调度已存在：${name}`, '`astra schedule list` 看现有计划，或先 remove')

  const now = nowIso()
  await run(
    `insert into schedules (name, command, interval_min, enabled, owner, next_run_at, created_at)
     values (?, ?, ?, 1, ?, ?, ?)`,
    [name, command, intervalMin, currentIdentity().name, now, now],
  )
  recordAudit({ action: 'schedule.add', summary: `${name}：每 ${intervalMin} 分钟跑 ${command}`, ok: true })
  const row = await one<Record<string, unknown>>('select * from schedules where name = ?', [name])
  return rowToSchedule(row!)
}

export async function listSchedules(): Promise<Schedule[]> {
  const scope = ownerScope()
  const rows = await all<Record<string, unknown>>('select * from schedules order by created_at desc')
  return rows.map(rowToSchedule).filter((s) => (scope ? s.owner === scope : true))
}

async function getSchedule(name: string): Promise<Schedule> {
  const row = await one<Record<string, unknown>>('select * from schedules where name = ?', [name])
  if (!row) throw new AstraError('NOT_FOUND', `没有这个调度：${name}`, { exitCode: 4, hint: '`astra schedule list` 看现有计划' })
  const schedule = rowToSchedule(row)
  const scope = ownerScope()
  if (scope && schedule.owner !== scope) {
    throw new AstraError('NOT_FOUND', `没有这个调度：${name}`, { exitCode: 4, hint: '`astra schedule list` 看现有计划' })
  }
  return schedule
}

/** 供 `schedule run` 用：按名字取（含归属校验）。 */
export function getScheduleForRun(name: string): Promise<Schedule> {
  return getSchedule(name)
}

export async function removeSchedule(name: string): Promise<boolean> {
  const schedule = await getSchedule(name)
  const n = await run('delete from schedules where name = ?', [schedule.name])
  recordAudit({ action: 'schedule.remove', summary: schedule.name, ok: true })
  return n > 0
}

export async function setEnabled(name: string, enabled: boolean): Promise<Schedule> {
  const schedule = await getSchedule(name)
  await run('update schedules set enabled = ?, next_run_at = ? where name = ?', [enabled ? 1 : 0, enabled ? (schedule.nextRunAt ?? nowIso()) : schedule.nextRunAt, schedule.name])
  recordAudit({ action: enabled ? 'schedule.enable' : 'schedule.disable', summary: schedule.name, ok: true })
  return getSchedule(name)
}

/** 拆参数：支持双引号包住带空格的值，不解释 shell 语法。 */
export function splitCommand(command: string): string[] {
  const out: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else buf += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (buf) out.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf) out.push(buf)
  return out
}

/** 起一个分离进程跑这次调度，日志落 `<ASTRA_HOME>/logs/schedule-<name>.log`。 */
export async function spawnSchedule(schedule: Schedule): Promise<number> {
  const entry = process.argv[1]
  if (!entry) throw new AstraError('INTERNAL', '无法确定 CLI 入口文件', { exitCode: 1 })
  const logDir = homePath('logs')
  mkdirSync(logDir, { recursive: true })
  const log = openSync(path.join(logDir, `schedule-${schedule.name}.log`), 'a')
  const args = [...process.execArgv, entry, ...splitCommand(schedule.command)]
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: {
      ...process.env,
      ASTRA_QUIET: '0',
      ...(currentToken() ? { ASTRA_TOKEN: currentToken()! } : {}),
    },
  })
  child.unref()

  const at = nowIso()
  await run('update schedules set last_run_at = ?, next_run_at = ?, last_status = ? where name = ?', [at, plusMinutes(at, schedule.intervalMin), 'started', schedule.name])
  recordAudit({ action: 'schedule.run', summary: `${schedule.name}：${schedule.command}`, ok: true })
  return child.pid ?? 0
}

/** 跑所有到期的调度，返回实际触发的名字。给 `schedule tick` 用。 */
export async function runDue(): Promise<string[]> {
  const at = nowIso()
  const rows = await all<Record<string, unknown>>('select * from schedules where enabled = 1 and (next_run_at is null or next_run_at <= ?)', [at])
  const started: string[] = []
  for (const row of rows) {
    const schedule = rowToSchedule(row)
    const scope = ownerScope()
    if (scope && schedule.owner !== scope) continue
    await spawnSchedule(schedule)
    started.push(schedule.name)
  }
  return started
}

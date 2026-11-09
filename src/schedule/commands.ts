/**
 * `astra schedule ...` —— 内置调度（无守护进程）。
 *
 *   astra schedule add daily-report --every 1d --cmd "music subscribe run"
 *   astra schedule list
 *   astra schedule run daily-report     # 立刻跑一次
 *   astra schedule tick                 # 跑所有到期的（交给 crontab / 任务计划，每分钟一次）
 */
import type { Command } from '../core/command.ts'
import { okResult } from '../core/output.ts'
import { invalidInput } from '../core/errors.ts'
import {
  addSchedule,
  listSchedules,
  removeSchedule,
  runDue,
  setEnabled,
  spawnSchedule,
  getScheduleForRun,
} from '../core/schedule.ts'

const add: Command = {
  name: 'schedule add',
  summary: '新建定时任务（间隔式）',
  usage: 'astra schedule add <名字> --every 6h --cmd "music subscribe run"',
  notes: [
    '`--every` 支持 30m / 6h / 1d，也可直接给分钟数。',
    '不需要守护进程：`schedule tick` 跑到期任务，用 crontab 每分钟调一次即可。',
    '`--cmd` 不写 astra 前缀。',
  ],
  minArgs: 1,
  maxArgs: 1,
  options: {
    every: { type: 'string', description: '间隔，如 30m / 6h / 1d', valueName: '间隔' },
    cmd: { type: 'string', description: '要执行的 astra 子命令（不含 astra）', valueName: '命令' },
  },
  async run(ctx) {
    const every = typeof ctx.values.every === 'string' ? ctx.values.every : ''
    const cmd = typeof ctx.values.cmd === 'string' ? ctx.values.cmd : ''
    if (!every) throw invalidInput('缺少 --every', '例如 `--every 6h`')
    if (!cmd) throw invalidInput('缺少 --cmd', '例如 `--cmd "music subscribe run"`')
    const created = await addSchedule({ name: ctx.positionals[0]!, command: cmd, interval: every })
    return okResult(created)
  },
}

/** ISO → 本地时间（按进程时区，不写死 Asia/Shanghai）。 */
function local(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('sv-SE', { hour12: false }).slice(0, 16)
  } catch {
    return iso.slice(0, 16).replace('T', ' ')
  }
}

const list: Command = {
  name: 'schedule list',
  summary: '列出定时任务',
  usage: 'astra schedule list',
  async run() {
    const rows = await listSchedules()
    return {
      ...okResult({ total: rows.length, schedules: rows }),
      table: {
        headers: ['名字', '间隔', '状态', '上次', '下次', '命令'],
        rows: rows.map((s) => [
          s.name,
          `${s.intervalMin}m`,
          s.enabled ? '启用' : '停用',
          local(s.lastRunAt),
          local(s.nextRunAt),
          s.command,
        ]),
      },
    }
  },
}

const remove: Command = {
  name: 'schedule remove',
  summary: '删除定时任务',
  usage: 'astra schedule remove <名字>',
  minArgs: 1,
  maxArgs: 1,
  async run(ctx) {
    return okResult({ removed: await removeSchedule(ctx.positionals[0]!) })
  },
}

const enable: Command = {
  name: 'schedule enable',
  summary: '启用定时任务',
  usage: 'astra schedule enable <名字>',
  minArgs: 1,
  maxArgs: 1,
  async run(ctx) {
    return okResult(await setEnabled(ctx.positionals[0]!, true))
  },
}

const disable: Command = {
  name: 'schedule disable',
  summary: '停用定时任务',
  usage: 'astra schedule disable <名字>',
  minArgs: 1,
  maxArgs: 1,
  async run(ctx) {
    return okResult(await setEnabled(ctx.positionals[0]!, false))
  },
}

const run: Command = {
  name: 'schedule run',
  summary: '立刻跑一次（会重置下次时间）',
  usage: 'astra schedule run <名字>',
  minArgs: 1,
  maxArgs: 1,
  async run(ctx) {
    const schedule = await getScheduleForRun(ctx.positionals[0]!)
    const pid = await spawnSchedule(schedule)
    return okResult({ name: schedule.name, pid, command: schedule.command })
  },
}

const tick: Command = {
  name: 'schedule tick',
  summary: '跑所有到期的任务（给 crontab 调用）',
  usage: 'astra schedule tick',
  notes: ['每分钟调一次即可；没有到期任务时零输出、退出码 0，适合 cron 静默。'],
  async run() {
    const started = await runDue()
    return okResult({ started, count: started.length })
  },
}

export const scheduleCommands: Command[] = [add, list, remove, enable, disable, run, tick]

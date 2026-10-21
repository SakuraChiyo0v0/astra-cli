#!/usr/bin/env node
/**
 * astra —— 给 AI 用的个人能力 CLI。
 *
 * 约定：
 * - stdout 只输出一个 JSON：`{ ok, data, warnings? }` 或 `{ ok: false, error: { code, message, hint, retryable } }`
 * - stderr 是进度与诊断（每行一个 JSON），不当结果解析
 * - 退出码：0 成功 / 2 参数错 / 3 需要配置 / 4 没找到 / 5 上游或网络 / 130 取消
 */
import { readFileSync } from 'node:fs'
import { AstraError, toAstraError } from './core/errors.ts'
import { failResult, okResult, writeJson } from './core/output.ts'
import { describeCommand, parseCommandArgs, type Command } from './core/command.ts'
import { CONFIG_KEYS, getConfig, listConfig, musicRoot, setConfig, unsetConfig } from './core/config.ts'
import { astraHome } from './core/paths.ts'
import { closeDb } from './core/db.ts'
import { runDoctor } from './core/doctor.ts'
import { allSessions } from './core/sessions.ts'
import { musicCommands } from './music/commands.ts'
import { biliCommands } from './bili/commands.ts'
import { mediaCommands } from './media/commands.ts'
import { vrCommands } from './vr/commands.ts'
import { listSources } from './lx/store.ts'
import { notify } from './core/notify.ts'

declare const ASTRA_VERSION: string | undefined

function version(): string {
  if (typeof ASTRA_VERSION === 'string') return ASTRA_VERSION
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
  } catch {
    return 'dev'
  }
}

const help: Command = {
  name: 'help',
  summary: '列出所有命令（给 AI 读的说明书）',
  usage: 'astra help [命令前缀]',
  async run({ positionals }) {
    const prefix = positionals.join(' ')
    const visible = commands.filter((c) => !c.hidden && c.name.startsWith(prefix))
    if (visible.length === 0) throw new AstraError('NOT_FOUND', `没有以「${prefix}」开头的命令`, { exitCode: 4 })
    return {
      data: {
        version: version(),
        conventions: [
          'stdout 只有一个 JSON：ok=true 看 data（和 warnings），ok=false 看 error.code / error.message / error.hint',
          'error.hint 是下一步建议；retryable=true 表示稍后重试可能成功',
          'stderr 是进度日志，不要当结果解析',
          '含空格的关键词可以不加引号（get / search 会把剩余参数拼起来）',
        ],
        commands: visible.map(describeCommand),
      },
    }
  },
}

const configCmd: Command = {
  name: 'config',
  summary: '查看 / 修改配置',
  usage: 'astra config [get <key> | set <key> <value> | unset <key>]',
  notes: CONFIG_KEYS.map((k) => `${k.key}：${k.description}`),
  maxArgs: 3,
  async run({ positionals }) {
    const [action, key, value] = positionals
    if (!action || action === 'list') return { data: { home: astraHome(), musicDir: musicRoot(), items: listConfig() } }
    if (action === 'get' && key) return { data: { key, value: getConfig(key) } }
    if (action === 'set' && key && value !== undefined) {
      setConfig(key, value)
      return { data: { key, value: CONFIG_KEYS.find((k) => k.key === key)?.secret ? '已设置' : value } }
    }
    if (action === 'unset' && key) {
      unsetConfig(key)
      return { data: { key, value: getConfig(key), reset: true } }
    }
    throw new AstraError('INVALID_INPUT', '用法不对', { exitCode: 2, hint: configCmd.usage })
  },
}

const doctor: Command = {
  name: 'doctor',
  summary: '自检：硬依赖、两个域的音源/登录/目录、可选通知',
  usage: 'astra doctor',
  notes: [
    '按三类列出：required（缺了直接不可用）/ domain（缺了某个能力不可用）/ optional（少了只是不方便）',
    '会真的往目录写一个临时文件来验证可写性 —— 权限位对了但挂载只读的情况也能发现',
  ],
  maxArgs: 0,
  async run() {
    const { checks, summary } = await runDoctor()
    // required 有失败才算整体不通过；domain 失败只影响对应能力
    const ok = summary.failedRequired === 0
    return {
      data: { version: version(), ok, summary, checks },
      warnings: checks.filter((c) => !c.ok && c.hint).map((c) => `${c.name}：${c.hint}`),
    }
  },
}

const notifyTest: Command = {
  name: 'notify test',
  summary: '往配置的飞书 webhook 发一条测试消息',
  usage: 'astra notify test [文字]',
  async run({ positionals }) {
    const sent = await notify(positionals.join(' ') || 'astra 通知测试')
    if (!sent) throw new AstraError('NOTIFY_FAILED', '发送失败或未配置 webhook', { exitCode: 3, hint: '`astra config set notify.feishu_webhook <地址>`' })
    return { data: { sent } }
  },
}

const versionCmd: Command = {
  name: 'version',
  summary: '版本号',
  usage: 'astra version',
  async run() {
    return { data: { version: version(), node: process.versions.node } }
  },
}

const loginCmd: Command = {
  name: 'login',
  summary: '看所有能力域的登录状态（谁登了、谁过期了、怎么登）',
  usage: 'astra login',
  notes: [
    '只读，不修改任何会话。登录分别用 `astra music login start` / `astra bili login start`',
    'state 有三种：logged_in / not_logged_in / stale_file（文件在但读不出来，通常是权限或格式坏了）',
  ],
  maxArgs: 0,
  async run() {
    const sessions = allSessions()
    const warnings: string[] = []
    for (const s of sessions) {
      // 只有"文件坏了"才值得警告：未登录是正常状态，不需要每次都提醒
      if (s.state === 'stale_file') warnings.push(`${s.label}：会话文件有问题（${s.fileIssue}），需要重新登录：${s.howToLogin}`)
    }
    return {
      data: {
        loggedIn: sessions.filter((s) => s.state === 'logged_in').map((s) => s.domain),
        sessions,
      },
      warnings,
    }
  },
}

const commands: Command[] = [help, versionCmd, doctor, configCmd, loginCmd, notifyTest, ...musicCommands, ...biliCommands, ...mediaCommands, ...vrCommands]

/** 最长前缀匹配：`music job cancel x` 先匹配 `music job cancel`，再退到 `music job`。 */
export function route(argv: string[]): { command: Command; rest: string[] } | null {
  const words = argv.filter((a) => !a.startsWith('-'))
  for (let n = Math.min(3, words.length); n > 0; n -= 1) {
    const head = argv.slice(0, n)
    if (head.some((a) => a.startsWith('-'))) continue
    const command = commands.find((c) => c.name === head.join(' '))
    if (command) return { command, rest: argv.slice(n) }
  }
  return null
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const pretty = argv.includes('--pretty')
  const args = argv.filter((a) => a !== '--pretty' && a !== '--json')
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') args.splice(0, args.length, 'help')
  if (args[0] === '--version' || args[0] === '-v') args.splice(0, args.length, 'version')
  // `astra music get --help` → 该命令的说明
  const wantsHelp = args.includes('--help') || args.includes('-h')
  const routed = route(args.filter((a) => a !== '--help' && a !== '-h'))
  if (!routed) {
    const groups = [...new Set(commands.filter((c) => !c.hidden).map((c) => c.name.split(' ')[0]))]
    writeJson(failResult(new AstraError('UNKNOWN_COMMAND', `未知命令：${args.join(' ')}`, { exitCode: 2, hint: `运行 \`astra help\` 查看命令。顶层命令：${groups.join(', ')}` })), pretty)
    return 2
  }
  if (wantsHelp) {
    writeJson(okResult(describeCommand(routed.command)), pretty)
    return 0
  }

  const controller = new AbortController()
  const onSignal = (): void => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const parsed = parseCommandArgs(routed.command, routed.rest)
    const result = await routed.command.run({ ...parsed, signal: controller.signal })
    writeJson(okResult(result.data, result.warnings ?? []), pretty)
    return 0
  } catch (err) {
    const error = controller.signal.aborted ? new AstraError('CANCELLED', '已取消', { exitCode: 130 }) : toAstraError(err)
    if (error.code === 'INTERNAL' && process.env.ASTRA_DEBUG === '1') process.stderr.write(String((err as Error).stack) + '\n')
    writeJson(failResult(error), pretty)
    return error.exitCode
  } finally {
    closeDb()
  }
}

/**
 * 是不是"被当成命令直接跑"。
 *
 * 原来只认固定文件名（main.ts / astra.mjs / astra），一旦产物改名（比如并排放一份
 * astra-bili.mjs 做测试）就会被判成"不是入口"，静默什么都不输出 —— 排查起来很费劲。
 * 改成"文件名以 astra 开头、扩展名是 .mjs/.js/.ts"，改名和加前缀都不会踩到。
 */
const entryName = (process.argv[1] ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
// 认两种：开发态直接跑 `src/main.ts`，以及打包/改名后的 `astra*.mjs`
const isEntry = entryName === 'main.ts' || /^astra[^/]*\.(?:mjs|js|ts)$/.test(entryName) || entryName === 'astra'
if (isEntry) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (err: unknown) => {
      process.stderr.write(String(err) + '\n')
      process.exitCode = 1
    },
  )
}

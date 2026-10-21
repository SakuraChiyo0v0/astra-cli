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
import { musicCommands } from './music/commands.ts'
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
  summary: '自检：数据目录、音乐目录、音源、网络',
  usage: 'astra doctor',
  maxArgs: 0,
  async run() {
    const checks: { name: string; ok: boolean; detail: string }[] = []
    checks.push({ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 24, detail: process.versions.node })
    checks.push({ name: 'home', ok: true, detail: astraHome() })
    checks.push({ name: 'music_dir', ok: true, detail: musicRoot() })
    const sources = listSources()
    checks.push({ name: 'lx_sources', ok: sources.some((s) => s.enabled), detail: sources.length === 0 ? '未导入音源，下载不可用' : sources.map((s) => `${s.id}${s.enabled ? '' : '(停用)'}`).join(', ') })
    try {
      const r = await fetch('https://music.163.com/api/v3/song/detail?c=' + encodeURIComponent('[{"id":1472480890}]'), { headers: { Referer: 'https://music.163.com/' }, signal: AbortSignal.timeout(8000) })
      checks.push({ name: 'netease', ok: r.ok, detail: `HTTP ${r.status}` })
    } catch (err) {
      checks.push({ name: 'netease', ok: false, detail: (err as Error).message })
    }
    checks.push({ name: 'notify', ok: true, detail: getConfig('notify.feishu_webhook') || process.env.ASTRA_FEISHU_WEBHOOK ? '已配置飞书 webhook' : '未配置（后台任务完成不推送）' })
    return { data: { version: version(), ok: checks.every((c) => c.ok), checks } }
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

const commands: Command[] = [help, versionCmd, doctor, configCmd, notifyTest, ...musicCommands]

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

const isEntry = process.argv[1] && /(?:main\.ts|astra\.mjs|astra)$/.test(process.argv[1].replace(/\\/g, '/'))
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

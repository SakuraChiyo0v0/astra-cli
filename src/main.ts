#!/usr/bin/env node
/**
 * astra —— 给 AI 用的个人能力 CLI。
 *
 * 约定：
 * - stdout 只输出一个 JSON：`{ ok, data, warnings? }` 或 `{ ok: false, error: { code, message, hint, retryable } }`
 * - stderr 是进度与诊断（每行一个 JSON），不当结果解析
 * - 退出码：0 成功 / 2 参数错 / 3 需要配置 / 4 没找到 / 5 上游或网络 / 130 取消
 */
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AstraError, toAstraError } from './core/errors.ts'
import { failResult, okResult, writeJson } from './core/output.ts'
import { describeCommand, parseCommandArgs, type Command } from './core/command.ts'
import { renderTable } from './core/output.ts'
import { CONFIG_KEYS, getConfig, listConfig, musicRoot, setConfig, unsetConfig } from './core/config.ts'
import { astraHome } from './core/paths.ts'
import { closeDb } from './core/db.ts'
import { runDoctor } from './core/doctor.ts'
import { allSessions, clearSessions, type Domain } from './core/sessions.ts'
import { musicCommands } from './music/commands.ts'
import { dbCommands } from './core/db/commands.ts'
import { libCommands } from './core/db/lib-commands.ts'
import { biliCommands } from './bili/commands.ts'
import { mediaCommands } from './media/commands.ts'
import { steamCommands } from './steam/commands.ts'
import { vrCommands } from './vr/commands.ts'
import { modelCommands } from './model/commands.ts'
import { pixivCommands } from './pixiv/commands.ts'
import { comicCommands } from './comic/commands.ts'
import { listSources } from './lx/store.ts'
import { notify } from './core/notify.ts'
import { listJobs, statusLabel, getJob, cancelJob, resumeJob } from './core/jobs.ts'
import { backup, listBackups, restore } from './core/backup.ts'
import { listAudit, pruneAudit } from './core/audit.ts'

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
          // 两套 status 是不同层的东西，混用会静默得到空集合（踩过：按 == "downloaded"
          // 过滤任务项，101 项全部漏掉，误判成全部失败）
          // 两套词已经统一（v0.12.5）：任务项的成功也是 downloaded，调用方可以用一套过滤
          'status 分两层，但成功都用 downloaded：单次操作看 data.status'
            + '（downloaded / already_have / ambiguous / job_started）；'
            + '后台任务的每项看 data.items[].status（downloaded / skipped / failed / queued / running）。',
          '  曲库里已有而跳过用 skipped；用 status == "downloaded" 过滤时记得把 skipped 也算成功',
          // 起了后台任务的命令统一返回 data.job.id —— 写脚本时不用逐个 try 字段名（P4#7）
          '会起后台任务的命令统一返回 data.job.id（`data.status: "job_started"`）；'
            + '要等它跑完用 `astra job <data.job.id> --wait <秒>`。同步完成的看 data.status: "downloaded"',
        ],
        // 三个批量入口的分流只写在各自 help 里时，拿合集 URL 去喂 `bili bulk`
        // 要撞一次 BILI_BAD_TARGET 才知道该用 `bili audio`。放在组级说明里省那一轮。
        ...(prefix === 'bili'
          ? {
            routing: [
              '单条：`bili get <BV号|链接>`',
              '一批视频：`bili bulk <合集|收藏夹>`（按视频下 mp4）',
              '把一个 UP / 合集整体转成音乐库：`bili audio <mid|合集>`（下 mp3，带标签）',
            ],
          }
          : {}),
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

/**
 * 跨域的统一任务入口。
 *
 * 为什么要它：音乐和 B 站各有一套 `job` 命令，VRChat 没有任务。用户问"有什么在跑"
 * 得挨个域问一遍。这个命令一次列全，带 domain 标签；子命令也能直接操作任意域的任务。
 */
const jobsCmd: Command = {
  name: 'jobs',
  summary: '所有域的后台任务，一次列全（音乐 / B 站 …）',
  usage: 'astra jobs [--active] [--domain music|bili] [--limit 10]',
  notes: [
    '各域也有自己的 `music jobs` / `bili jobs`，内容一样；这个是不用记域名的入口',
    '任务 id 在所有域里唯一，`astra job <id>` 可以直接查任意域的任务',
  ],
  options: {
    active: { type: 'boolean', description: '只看进行中的' },
    domain: { type: 'string', description: '只看某个域', valueName: 'name' },
    limit: { type: 'string', short: 'n', description: '默认 10', valueName: 'n' },
  },
  maxArgs: 0,
  async run({ values }) {
    const limit = Number(values.limit ?? 10)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AstraError('INVALID_INPUT', '--limit 必须是 1..100 的整数', { exitCode: 2 })
    const domain = typeof values.domain === 'string' ? values.domain : undefined
    const jobs = listJobs(limit, values.active === true, domain)
    return {
      data: {
        total: jobs.length,
        byDomain: jobs.reduce<Record<string, number>>((acc, j) => { acc[j.domain] = (acc[j.domain] ?? 0) + 1; return acc }, {}),
        jobs: jobs.map((j) => ({
          id: j.id, domain: j.domain, kind: j.kind, title: j.title,
          status: j.status, statusLabel: statusLabel(j.status),
          progress: `${j.done + j.skipped}/${j.total}`, failed: j.failed,
          createdAt: j.createdAt,
        })),
      },
      table: {
        headers: ['ID', '域', '状态', '进度', '失败', '标题'],
        rows: jobs.map((j) => [
          j.id, j.domain, statusLabel(j.status), `${j.done + j.skipped}/${j.total}`, j.failed, j.title,
        ]),
      },
    }
  },
}

/** `astra job <id>`：不用先知道它属于哪个域。 */
const jobCmd: Command = {
  name: 'job',
  summary: '看任意域的任务进度 / 取消 / 继续（不用记域名）',
  usage: 'astra job <id> | astra job cancel <id> | astra job resume <id> [--items] [--wait 60]',
  notes: ['任务 id 跨域唯一。加 --items 看每一项，--wait 阻塞等待完成'],
  options: {
    items: { type: 'boolean', description: '列出每一项的状态' },
    failed: { type: 'boolean', description: '只列失败的' },
    wait: { type: 'string', description: '最多等待秒数（≤600）', valueName: 's' },
  },
  minArgs: 1,
  async run({ positionals, values, signal }) {
    const [first, second] = positionals
    if (!first) throw new AstraError('INVALID_INPUT', '需要任务 id', { exitCode: 2, hint: '`astra jobs` 看有哪些' })
    if (first === 'cancel' || first === 'resume') {
      if (!second) throw new AstraError('INVALID_INPUT', `astra job ${first} 需要任务 id`, { exitCode: 2 })
      const j = first === 'cancel' ? cancelJob(second) : resumeJob(second)
      return { data: { ...j, statusLabel: statusLabel(j.status) } }
    }
    const waitSeconds = Number(values.wait ?? 0)
    const deadline = Date.now() + (Number.isFinite(waitSeconds) ? waitSeconds : 0) * 1000
    let snapshot = getJob(first, false)
    while (waitSeconds > 0 && Date.now() < deadline && !signal.aborted && ['queued', 'running'].includes(snapshot.job.status)) {
      await new Promise((r) => setTimeout(r, 2000))
      snapshot = getJob(first, false)
    }
    const full = getJob(first, values.items === true || values.failed === true)
    const items = values.failed === true ? full.items?.filter((i) => i.status === 'failed') : full.items
    return {
      data: {
        ...full.job,
        statusLabel: statusLabel(full.job.status),
        ...(values.items === true || values.failed === true ? { items } : {}),
      },
    }
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
  summary: '看所有能力域的登录状态，或清理坏掉的会话',
  usage: 'astra login | astra login clear [netease|bili|vrchat]',
  notes: [
    '不带参数：只读，列出谁登了、谁过期了、怎么登。三个域都会列',
    'state 有三种：logged_in / not_logged_in / stale_file（文件在但读不出来，通常是权限或格式坏了）',
    '`login clear`：删本地会话文件，不调上游登出。会话文件坏了、正常 logout 都进不去时用它',
    '`login clear` 不带域名就清全部；正常登出请用各域的 `logout` 命令',
  ],
  maxArgs: 2,
  async run({ positionals }) {
    if (positionals[0] === 'clear') {
      const name = positionals[1]
      const known: Domain[] = ['netease', 'bili', 'vrchat']
      if (name !== undefined && !known.includes(name as Domain)) {
        throw new AstraError('INVALID_INPUT', `未知的域「${name}」`, { exitCode: 2, hint: `可选：${known.join(' / ')}` })
      }
      const result = clearSessions(name === undefined ? undefined : [name as Domain])
      return {
        data: { ...result, note: '只删了本地会话文件，没有调上游登出；要正常登出请用各域的 logout' },
        warnings: result.failed.map((f) => `${f.domain} 清理失败：${f.error}`),
      }
    }
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

/**
 * 备份。曲库丢了要重下几千首，会话丢了要重新扫码 —— 这是最该有自动化的一件事。
 *
 * `restore` 是危险操作：会覆盖当前曲库。所以要求显式给备份目录，且它会先把当前库
 * 改名保留（`.replaced-<时间戳>`），不做不可逆的事。
 */
const backupCmd: Command = {
  name: 'backup',
  summary: '备份曲库数据库与会话，或用备份恢复',
  usage: 'astra backup | astra backup list | astra backup restore <备份目录>',
  notes: [
    '只备份 astra.db（曲库与任务历史）和三个会话文件；**不备份**音乐/视频文件本身',
    '数据库用 SQLite 的 VACUUM INTO 生成一致快照，不会因为那一刻有写入而损坏',
    '默认保留最近 7 份；备份目录可用环境变量 ASTRA_BACKUP_DIR 指到别的盘',
    '`restore` 会覆盖当前曲库，但会先把当前库改名保留；有任务在跑时会拒绝',
  ],
  maxArgs: 2,
  async run({ positionals }) {
    const [sub, arg] = positionals
    if (sub === 'list') {
      return { data: { backups: listBackups().map((b) => ({ name: b.name, path: b.dir, bytes: b.bytes, createdAt: b.createdAt })) } }
    }
    if (sub === 'restore') {
      if (!arg) throw new AstraError('INVALID_INPUT', '需要备份目录', { exitCode: 2, hint: '`astra backup list` 看有哪些' })
      const result = restore(arg)
      return {
        data: { ...result, note: '已用备份覆盖曲库；原库已改名保留，确认无误后可手动删除' },
        warnings: result.previousKept ? [`原库保留在 ${result.previousKept}`] : [],
      }
    }
    const result = backup()
    const warnings: string[] = []
    if (!result.hasDatabase) warnings.push('本次没有备份到数据库（还没下载过任何东西时是正常的）')
    if (result.sessionCount === 0) warnings.push('没有可备份的会话文件（可能都还没登录）')
    return { data: result, warnings }
  },
}

/**
 * 审计日志：谁在什么时候改了什么。
 *
 * 只记写操作（红心、退群、删订阅……），读操作不留痕。
 */
const auditCmd: Command = {
  name: 'audit',
  summary: '写操作审计：什么时候改了什么、成功没',
  usage: 'astra audit [--domain music|vr] [--failed] [--since 2026-10-01] [--limit 50] | astra audit prune',
  notes: [
    '只记写操作（红心、退群、收藏、删订阅），读操作不留痕',
    '不记 cookie，也不记完整上游响应；只记动作、对象名字、结果',
    '`audit prune` 只保留最近 1000 条',
  ],
  // 这些选项之前只写在 usage 里没真声明，导致 `--limit` 直接报 Unknown option
  options: {
    domain: { type: 'string', description: '只看某个域：music / bili / vr', valueName: 'name' },
    failed: { type: 'boolean', description: '只看失败的' },
    since: { type: 'string', description: '只看这个时间之后的（ISO 日期，如 2026-10-01）', valueName: 'date' },
    limit: { type: 'string', short: 'n', description: '默认 50，最多 500', valueName: 'n' },
  },
  maxArgs: 1,
  async run({ positionals, values }) {
    if (positionals[0] === 'prune') {
      const removed = pruneAudit()
      const remaining = listAudit({ limit: 500 }).length
      return { data: { removed, remaining } }
    }
    const limit = Number(values.limit ?? 50)
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new AstraError('INVALID_INPUT', '--limit 必须是 1..500 的整数', { exitCode: 2 })
    const records = listAudit({
      limit,
      ...(typeof values.domain === 'string' ? { domain: values.domain } : {}),
      ...(values.failed === true ? { failedOnly: true } : {}),
      ...(typeof values.since === 'string' ? { since: values.since } : {}),
    })
    return {
      data: {
        total: records.length,
        failed: records.filter((r) => !r.ok).length,
        records: records.map((r) => ({ at: r.at, action: r.action, summary: r.summary, ok: r.ok, ...(r.error ? { error: r.error } : {}) })),
      },
    }
  },
}

const commands: Command[] = [

  help, versionCmd, doctor, jobsCmd, jobCmd, configCmd, loginCmd, backupCmd, auditCmd, notifyTest,
  ...musicCommands, ...biliCommands, ...mediaCommands, ...steamCommands, ...vrCommands, ...modelCommands,
  ...dbCommands, ...libCommands,
  ...pixivCommands, ...comicCommands,
]

/** 最长前缀匹配：`music job cancel x` 先匹配 `music job cancel`，再退到 `music job`。 */
/**
 * 把入口剥掉的全局标志，在命令自己声明了同名选项时补回去。
 *
 * `--json` 是个 no-op 的全局标志（输出本来就是 JSON），入口会无条件把它从
 * argv 里过滤掉。代价是**命令永远收不到同名的 `--json`** ——
 * `music lyric` 就踩过：帮助里写了 `--json`、实际传了没有任何效果，
 * 因为它在到达命令之前就没了。
 *
 * 只在两件事同时成立时补回去：用户确实传了、命令自己声明了这个选项。
 * 抽成纯函数是为了能直接测这段判断，不用起进程。
 */
export function restoreCommandFlags(rawArgv: string[], command: Command, rest: string[]): string[] {
  const userPassed = rawArgv.includes('--json')
  const commandDeclares = Boolean(command.options?.json)
  return userPassed && commandDeclares ? [...rest, '--json'] : rest
}

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

/**
 * 这个前缀是不是一个"命令组"（`bili`、`music`、`vr`…）。
 *
 * 用途：`astra bili` / `astra bili --help` 该给子命令清单，
 * 而不是报 UNKNOWN_COMMAND。之前只有 `astra help bili` 能用，
 * 每次新会话都要重新想起这个写法 —— 是使用者真正卡住的地方。
 */
export function commandGroup(arg: string): boolean {
  return commands.some((c) => !c.hidden && c.name.startsWith(`${arg} `))
}

/** 某组下所有子命令名（给提示用）。 */
export function groupCommands(arg: string): string[] {
  return commands.filter((c) => !c.hidden && c.name.startsWith(`${arg} `)).map((c) => c.name)
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const pretty = argv.includes('--pretty')
  const wantTable = argv.includes('--table')
  const args = argv.filter((a) => a !== '--pretty' && a !== '--json' && a !== '--table')
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') args.splice(0, args.length, 'help')
  if (args[0] === '--version' || args[0] === '-v') args.splice(0, args.length, 'version')
  // `astra music get --help` → 该命令的说明
  const wantsHelp = args.includes('--help') || args.includes('-h')
  const bare = args.filter((a) => a !== '--help' && a !== '-h')

  // `astra bili` / `astra bili --help` / `astra bili -h` → 等价于 `astra help bili`。
  // 不给这一步的话，习惯性敲 `--help` 得到的是 UNKNOWN_COMMAND，
  // 而只有 `astra help bili` 能用 —— 那个写法没人猜得到。
  //
  // 注意要**在这一步之后不再走"展示 help 命令自己"的分支**：
  // 重写完 args 就变成 `help bili`，那个分支会把 `help` 命令的说明吐出来，
  // 而不是 bili 的子命令清单。
  const isGroupHelp = bare.length === 1 && commandGroup(bare[0]!)
  if (isGroupHelp) {
    args.splice(0, args.length, 'help', bare[0]!)
  }

  const routed = route(args.filter((a) => a !== '--help' && a !== '-h'))
  if (!routed) {
    // 未知子命令（`astra bili foo`）时，提示该组的子命令，而不是全局顶层清单 ——
    // 顶层清单在 `bili foo` 这个上下文里没有任何帮助
    const group = bare[0] && commandGroup(bare[0]) ? bare[0] : null
    const hint = group
      ? `\`${group}\` 的子命令：${groupCommands(group).map((c) => c.replace(`${group} `, '')).join(', ')}`
      : `运行 \`astra help\` 查看命令。顶层命令：${[...new Set(commands.filter((c) => !c.hidden).map((c) => c.name.split(' ')[0]))].join(', ')}`
    writeJson(failResult(new AstraError('UNKNOWN_COMMAND', `未知命令：${args.join(' ')}`, { exitCode: 2, hint })), pretty)
    return 2
  }
  if (wantsHelp && !isGroupHelp) {
    writeJson(okResult(describeCommand(routed.command)), pretty)
    return 0
  }

  const controller = new AbortController()
  const onSignal = (): void => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const parsed = parseCommandArgs(routed.command, restoreCommandFlags(argv, routed.command, routed.rest))
    const result = await routed.command.run({ ...parsed, signal: controller.signal })
    // `--table`：只影响**显示**，不改返回结构 —— 脚本拿到的 JSON 一模一样。
    // 命令没提供 table 视图时退回 JSON，不让这个开关变得危险。
    if (wantTable) {
      const view = result.table
      if (view && Array.isArray(view.headers) && Array.isArray(view.rows)) {
        process.stdout.write(renderTable(view) + '\n')
        return 0
      }
    }
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
 * 之前靠文件名白名单（main.ts / astra*.mjs / astra），两次踩坑：
 * 产物改名成 astra-bili.mjs、临时测试叫 a.mjs，都被判成"不是入口"而静默不执行 ——
 * 退出码 0、零输出，排查起来极费劲。
 *
 * 改成比对路径：当前模块就是 argv[1]（被 node 当作主模块启动）才执行。
 * 被 import 时 argv[1] 是别的文件，自然不匹配。
 *
 * **必须用 fileURLToPath，不能用 URL.pathname。** pathname 是百分号编码的，
 * 路径里有空格时拿到 `/a%20b/astra.mjs`，和 argv[1] 的 `/a b/astra.mjs` 永远对不上，
 * 于是同一个"静默不执行"的病又回来了（实测，见 tests/entry.test.ts）。
 */
function normalizePath(value: string): string {
  const absolute = path.resolve(value)
  // Node 解析模块 URL 时会跟随符号链接，argv[1] 不会。用软链启动时两边要拉到同一处比对。
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

const entryPath = process.argv[1] ? normalizePath(process.argv[1]) : ''
const selfPath = normalizePath(fileURLToPath(import.meta.url))
// 打包产物里 import.meta.url 指向产物本身；开发态指向 src/main.ts。两者都应能对上 argv[1]。
const isEntry = entryPath !== '' && entryPath === selfPath
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

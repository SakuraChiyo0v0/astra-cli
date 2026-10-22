/**
 * 命令登记：每个命令自带用法说明，`astra help` 直接生成给 AI 看的命令清单。
 */
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { invalidInput } from './errors.ts'

export type OptionSpec = NonNullable<ParseArgsConfig['options']>[string] & { description: string; valueName?: string }

export interface CommandContext {
  positionals: string[]
  values: Record<string, string | boolean | string[] | undefined>
  signal: AbortSignal
}

export interface CommandResult {
  data: unknown
  warnings?: string[]
  /**
   * `--table` 时给人看的表格视图。
   *
   * **不进 `data`**：它只是另一种呈现，不该污染 JSON 的结构 ——
   * 不加 `--table` 时脚本拿到的返回必须和以前一模一样。
   */
  table?: { headers: string[]; rows: (string | number | null)[][] }
}

export interface Command {
  /** 例如 `music get`。 */
  name: string
  summary: string
  usage: string
  /** 给 AI 看的补充说明：何时用、结果怎么理解。 */
  notes?: string[]
  options?: Record<string, OptionSpec>
  minArgs?: number
  maxArgs?: number
  hidden?: boolean
  run: (ctx: CommandContext) => Promise<CommandResult>
}

export function parseCommandArgs(command: Command, argv: string[]): Omit<CommandContext, 'signal'> {
  const options: NonNullable<ParseArgsConfig['options']> = {}
  for (const [name, spec] of Object.entries(command.options ?? {})) {
    const { description: _d, valueName: _v, ...rest } = spec
    options[name] = rest
  }
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true })
  } catch (err) {
    throw invalidInput((err as Error).message, `用法：${command.usage}`)
  }
  const positionals = parsed.positionals
  if (command.minArgs !== undefined && positionals.length < command.minArgs) throw invalidInput('缺少参数', `用法：${command.usage}`)
  if (command.maxArgs !== undefined && positionals.length > command.maxArgs) {
    throw invalidInput(`参数太多：${positionals.slice(command.maxArgs).join(' ')}`, `用法：${command.usage}。含空格的关键词请加引号`)
  }
  return { positionals, values: parsed.values as CommandContext['values'] }
}

export function describeCommand(command: Command): Record<string, unknown> {
  return {
    command: command.name,
    summary: command.summary,
    usage: command.usage,
    options: Object.fromEntries(
      Object.entries(command.options ?? {}).map(([name, spec]) => [
        `--${name}${spec.type === 'string' ? ` <${spec.valueName ?? 'value'}>` : ''}`,
        spec.description,
      ]),
    ),
    ...(command.notes ? { notes: command.notes } : {}),
  }
}

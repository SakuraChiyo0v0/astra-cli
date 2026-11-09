/**
 * 领域清单：每个领域（`src/<名字>/manifest.ts`）导出一份，main.ts 只认这份清单。
 *
 * 为什么要它（0.53.0）：以前 main.ts 逐个 import 19 个领域的 `xxxCommands`，
 * core 里的 config / doctor / sessions 也直接 import 领域代码 —— 删一个领域要改四五处，
 * 而且任何命令都得把所有领域加载一遍。清单是下一步「按领域懒加载」的前提。
 *
 * 约束（`tests/boundaries.test.ts` 守着）：
 * - core 不 import 任何领域；
 * - 领域只 import core 和自己 `dependsOn` 里列出的领域。
 */
import type { Command } from './command.ts'

export interface DomainModule {
  /** 目录名，也是命令首词。 */
  name: string
  /** 允许 import 的其他领域（如 cloud 用 quark 的适配器）。 */
  dependsOn?: string[]
  commands: Command[]
}

export function defineDomain(domain: DomainModule): DomainModule {
  const stray = domain.commands.filter((c) => c.name.split(' ')[0] !== domain.name)
  if (stray.length > 0) {
    throw new Error(`领域 ${domain.name} 里有不以「${domain.name}」开头的命令：${stray.map((c) => c.name).join(', ')}`)
  }
  return domain
}

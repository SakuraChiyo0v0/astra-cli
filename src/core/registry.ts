/**
 * 命令清单的运行时注册表。
 *
 * 为什么不在 `auth doctor` 里直接 import main.ts 的数组：main 会 import 各域命令，
 * 包括 auth 自己，形成环。改成 main 启动时把数组塞进来，需要看清单的命令读注册表。
 */
import type { Command } from './command.ts'

let cached: Command[] = []

export function setCommandRegistry(commands: Command[]): void {
  cached = commands
}

export function getCommandRegistry(): Array<{ name: string; hidden?: boolean }> {
  return cached.map((c) => ({ name: c.name, ...(c.hidden ? { hidden: true } : {}) }))
}

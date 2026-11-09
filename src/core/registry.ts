/**
 * 命令清单的运行时注册表。
 *
 * 为什么不在 `auth doctor` 里直接 import main.ts 的数组：main 会 import 各域命令，
 * 包括 auth 自己，形成环。改成 main 启动时把「怎么拿全量清单」塞进来，需要看清单的命令来要。
 *
 * 0.58.0 起领域是懒加载的：进程里平时只有当前命令那一个领域，要全量时由 main 提供的
 * 加载函数现拉一次。
 */
import type { Command } from './command.ts'

let loader: () => Promise<Command[]> = async () => []

export function setCommandRegistry(load: () => Promise<Command[]>): void {
  loader = load
}

export async function getCommandRegistry(): Promise<Array<{ name: string; hidden?: boolean }>> {
  return (await loader()).map((c) => ({ name: c.name, ...(c.hidden ? { hidden: true } : {}) }))
}

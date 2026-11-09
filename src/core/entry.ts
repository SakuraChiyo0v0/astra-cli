/**
 * 自己的入口文件路径：拉起后台子进程（任务 worker、steam 挂机、调度）时要用。
 *
 * 0.56.0 起打包产物是「入口桩 → releases/<版本>/astra.mjs」。两种入口语义不同：
 * - `pinnedEntry()`：**当前这个版本**的真入口。长时间运行的子进程（任务 worker、挂机）用它 ——
 *   部署换了桩，它们也继续跑在自己那个版本目录上，懒加载拿不到新旧混杂的块。
 * - `launcherEntry()`：用户调用的那个入口（桩）。调度用它 —— 每次触发都该跑最新版本。
 *
 * 开发态（`node src/main.ts`）和老的单文件产物里两者相同，都是 argv[1]。
 */
import { fileURLToPath } from 'node:url'
import { AstraError } from './errors.ts'

let pinned: string | null = null

/** main.ts 启动时登记自己的真实路径（`import.meta.url`）。 */
export function setPinnedEntry(url: string): void {
  pinned = fileURLToPath(url)
}

export function launcherEntry(): string {
  const entry = process.argv[1]
  if (!entry) throw new AstraError('INTERNAL', '无法确定 CLI 入口文件', { exitCode: 1 })
  return entry
}

export function pinnedEntry(): string {
  return pinned ?? launcherEntry()
}

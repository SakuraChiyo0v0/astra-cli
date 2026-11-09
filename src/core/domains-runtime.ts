/**
 * 领域的运行时加载（0.58.0）。
 *
 * `src/domains.ts` 登记 `{ name, load }`；main 启动时把这份表交给这里（core 不 import domains.ts，
 * 否则 core → 全部领域，懒加载就白做了）。
 *
 * - `loadDomain(name)`：按首词只加载那一个领域，连同它 `dependsOn` 的领域（它们的模块顶层可能注册了
 *   任务处理器之类的钩子，被依赖方也要跑到）
 * - `loadAllDomains()`：help / doctor / login / auth doctor 这种要看全量的命令用
 *
 * 加载结果缓存在进程里，同一个领域只 import 一次。
 */
import type { DomainEntry, DomainModule } from './domain.ts'

let entries: DomainEntry[] = []
const loaded = new Map<string, Promise<DomainModule>>()

export function setDomainEntries(list: DomainEntry[]): void {
  entries = list
  loaded.clear()
}

export function domainNames(): string[] {
  return entries.map((e) => e.name)
}

export function hasDomain(name: string): boolean {
  return entries.some((e) => e.name === name)
}

export async function loadDomain(name: string): Promise<DomainModule> {
  const cached = loaded.get(name)
  if (cached) return cached
  const entry = entries.find((e) => e.name === name)
  if (!entry) throw new Error(`没有登记的领域：${name}`)
  const pending = (async () => {
    const mod = await entry.load()
    if (mod.name !== name) throw new Error(`领域登记名「${name}」和清单里的 name「${mod.name}」不一致`)
    for (const dep of mod.dependsOn ?? []) await loadDomain(dep)
    return mod
  })()
  loaded.set(name, pending)
  pending.catch(() => loaded.delete(name))
  return pending
}

/** 按登记顺序加载全部。 */
export async function loadAllDomains(): Promise<DomainModule[]> {
  const out: DomainModule[] = []
  for (const e of entries) out.push(await loadDomain(e.name))
  return out
}

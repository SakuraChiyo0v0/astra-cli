/**
 * 领域登记表：加 / 删一个领域只改这里一行（外加它自己的目录）。
 *
 * 顺序就是 `astra help` 里的顺序。
 *
 * 0.58.0 起是**懒加载**：只写名字和 `load`，跑 `astra music get` 时只 import music。
 * `load` 必须是字面量的 `import('./x/manifest.ts')` —— 打包器靠它切块，写成变量拼接就切不开了。
 */
import type { DomainEntry } from './core/domain.ts'

export const DOMAINS: DomainEntry[] = [
  { name: 'music', load: async () => (await import('./music/manifest.ts')).domain },
  { name: 'bili', load: async () => (await import('./bili/manifest.ts')).domain },
  { name: 'media', load: async () => (await import('./media/manifest.ts')).domain },
  { name: 'steam', load: async () => (await import('./steam/manifest.ts')).domain },
  { name: 'vr', load: async () => (await import('./vr/manifest.ts')).domain },
  { name: 'model', load: async () => (await import('./model/manifest.ts')).domain },
  { name: 'quark', load: async () => (await import('./quark/manifest.ts')).domain },
  { name: 'cloud', load: async () => (await import('./cloud/manifest.ts')).domain },
  { name: 'pixiv', load: async () => (await import('./pixiv/manifest.ts')).domain },
  { name: 'jm', load: async () => (await import('./jm/manifest.ts')).domain },
  { name: 'douyin', load: async () => (await import('./douyin/manifest.ts')).domain },
  { name: 'lol', load: async () => (await import('./lol/manifest.ts')).domain },
  { name: 'heybox', load: async () => (await import('./heybox/manifest.ts')).domain },
  { name: 'llm', load: async () => (await import('./llm/manifest.ts')).domain },
  { name: 'device', load: async () => (await import('./device/manifest.ts')).domain },
  { name: 'x', load: async () => (await import('./x/manifest.ts')).domain },
  { name: 'auth', load: async () => (await import('./auth/manifest.ts')).domain },
  { name: 'schedule', load: async () => (await import('./schedule/manifest.ts')).domain },
  { name: 'novel', load: async () => (await import('./novel/manifest.ts')).domain },
  { name: 'comic', load: async () => (await import('./comic/manifest.ts')).domain },
  { name: 'archive', load: async () => (await import('./archive/manifest.ts')).domain },
  { name: 'mail', load: async () => (await import('./mail/manifest.ts')).domain },
]

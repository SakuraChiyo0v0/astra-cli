/**
 * 领域清单：每个领域（`src/<名字>/manifest.ts`）导出一份，main.ts 只认这份清单。
 *
 * 为什么要它（0.53.0）：以前 main.ts 逐个 import 19 个领域的 `xxxCommands`，
 * core 里的 config / doctor / sessions 也直接 import 领域代码 —— 删一个领域要改四五处，
 * 而且任何命令都得把所有领域加载一遍。
 *
 * 0.58.0 起按首词懒加载：`src/domains.ts` 只登记 `{ name, load }`，跑 `astra music get`
 * 只 import music（和它 dependsOn 的领域）。core 需要领域提供的东西（doctor 检查、登录状态）
 * 通过清单上的钩子拿，core 自己一行领域代码都不 import。
 *
 * 约束（`tests/boundaries.test.ts` 守着）：
 * - core 不 import 任何领域；
 * - 领域只 import core 和自己 `dependsOn` 里列出的领域。
 */
import type { Command } from './command.ts'

/** doctor 的一条检查（和 core/doctor.ts 的 Check 同形；放这里是为了领域不必 import doctor）。 */
export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
  kind: 'required' | 'domain' | 'optional'
  hint?: string
}

/** 领域在 doctor 里能看到的公共信息。 */
export interface DoctorContext {
  add: (check: DoctorCheck) => void
  /** 建目录 + 真写一个文件试试，返回 `{ ok, detail }`。 */
  checkWritable: (dir: string) => { ok: boolean; detail: string }
  ensureExists: (dir: string) => void
  /** 领域登记要做磁盘用量的目录（doctor 最后统一报）。 */
  watchDisk: (name: string, dir: string) => void
}

/** `astra login` 里一个域的登录状态。 */
export interface SessionView {
  domain: string
  label: string
  state: 'logged_in' | 'not_logged_in' | 'stale_file'
  account: string | null
  /** 会话指纹（10 位），用来判断「是不是同一个账号」，不泄露内容。 */
  digest: string | null
  savedAt: string | null
  /** 文件存在但读不出来 —— 通常是权限或格式坏了。 */
  fileIssue: string | null
  /** 没有会话时怎么登录。 */
  howToLogin: string
}

export interface SessionProvider {
  /** `astra login clear <这个名字>` 用的名字（netease / bili / vrchat）。 */
  domain: string
  view: () => SessionView
  /** 只删本地文件，不调上游登出。 */
  clear: () => void
}

/** 领域给的身份：有了它 `lib adopt` 就不走指纹。 */
export interface AdoptIdentity {
  platform: string
  nativeId: string
  title: string
  artists: string | null
  album: string | null
  meta: Record<string, unknown>
  /** 记进 adopted 事件的来源，如 `comic-sidecar`。 */
  via: string
}

/** 返回 null = 不认识，交给下一个识别器。 */
export type AdoptIdentityResolver = (file: { abs: string; base: string; ext: string; kind: string }) => AdoptIdentity | null

export interface DomainModule {
  /** 目录名，也是命令首词。 */
  name: string
  /** 允许 import 的其他领域（如 cloud 用 quark 的适配器）。 */
  dependsOn?: string[]
  commands: Command[]
  /** doctor 里这个领域自己的检查。按清单顺序执行。 */
  doctor?: (ctx: DoctorContext) => Promise<void>
  /** `astra login` 汇总的登录状态。 */
  sessions?: SessionProvider[]
  /**
   * `lib adopt` / `scan --adopt` 认文件身份的钩子（如漫画页读 `.astra-comic.json`）。
   * 返回 null = 不认识，交给下一个。
   */
  adoptIdentity?: AdoptIdentityResolver
}

export function defineDomain(domain: DomainModule): DomainModule {
  const stray = domain.commands.filter((c) => c.name.split(' ')[0] !== domain.name)
  if (stray.length > 0) {
    throw new Error(`领域 ${domain.name} 里有不以「${domain.name}」开头的命令：${stray.map((c) => c.name).join(', ')}`)
  }
  return domain
}

/** `src/domains.ts` 的一项：名字是静态的，模块按需加载。 */
export interface DomainEntry {
  name: string
  load: () => Promise<DomainModule>
}

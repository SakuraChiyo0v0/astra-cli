/**
 * 「对外表面」快照：给 AI 看的命令清单 + 配置键表。
 *
 * 为什么要它：领域懒加载改造（docs/归档/2026-11-09 领域懒加载.md）要动 main.ts、
 * config / doctor / sessions 的组织方式，但**命令名、参数、说明、配置键一个字都不能变**。
 * 这份快照把它们全部序列化，改造前后逐字节比对。
 *
 * 配置键的 validate 是函数，没法直接比；用一组探针值跑一遍，把「接受 / 拒绝」记下来，
 * 搬家时校验器被改坏也能发现。
 */
import { CONFIG_KEYS } from '../../src/core/config.ts'
import { describeCommand } from '../../src/core/command.ts'
import { getCommandRegistry } from '../../src/core/registry.ts'
import { route } from '../../src/main.ts'

/** 覆盖各类校验器的探针：空、绝对/相对路径、数字边界、枚举、URL 形态。 */
const PROBES = [
  '', ' ', '0', '1', '2', '3', '4', '5', '6', '7', '96', '320', '321', 'abc',
  '/abs/path', 'rel/path', 'true', 'false', 'yes',
  '128k', '320k', 'flac', '24bit', 'lossless', '1080p', '1080P', '4K', '116',
  'auto', 'off', 'fetch', 'curl', 'embed', 'lrc', 'both', 'none', 'all', 'first', 'nfo,cover', 'nfo;x',
  'mp3', 'm4a', 'ogg', 'http://mihomo:7890', 'https://x', 'socks5://a:1',
  'https://open.feishu.cn/open-apis/bot/v2/hook/abc', 'https://example.com/hook',
  'a/b.epub', 'a/b.txt', 'Various Artists', 'a:b',
]

export async function surface(): Promise<unknown> {
  const help = await route(['help'])
  if (!help) throw new Error('help 命令不见了')
  const ctrl = new AbortController()
  const result = (await help.command.run({ positionals: [], values: {}, signal: ctrl.signal })) as {
    data: { commands: unknown[]; conventions: unknown[] }
  }
  // hidden 命令不进 help，但也是表面的一部分（_worker 之类会被 spawn 调用）
  const hidden = (await getCommandRegistry()).filter((c) => c.hidden).map((c) => c.name).sort()
  const config = await route(['config'])
  return {
    conventions: result.data.conventions,
    commands: result.data.commands,
    hidden,
    configNotes: config ? describeCommand(config.command) : null,
    configKeys: CONFIG_KEYS.map((k) => ({
      key: k.key,
      description: k.description,
      default: k.default,
      secret: k.secret === true,
      accepts: k.validate ? PROBES.filter((p) => k.validate!(p) === null) : 'any',
    })),
  }
}

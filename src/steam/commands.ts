/**
 * `astra steam ...`：Steam 的库存与愿望单。
 *
 * 只做对"AI 代替我"有实际意义的两类：
 * - **愿望单**：看看想买什么、什么时候打折、多少钱
 * - **库存**：看看某个游戏里有什么东西（CS2 饰品、Steam 卡牌等）
 *
 * 商店查询、评测、成就这些没有做 —— 那些更适合自己去商店页看。
 */
import { AstraError, invalidInput } from '../core/errors.ts'
import type { Command } from '../core/command.ts'
import { appDetails, inventory, playerSummaries, wishlist } from './api.ts'
import { apiKeyDigest, loadSteamCredentials, requireApiKey, requireSteamId, saveSteamCredentials, validateSteamId64 } from './auth.ts'

/** 从 `--user` 或凭据里取 SteamID64。 */
function resolveUser(value: unknown): { steamId64: string; apiKey: string | null } {
  const credentials = loadSteamCredentials()
  if (typeof value === 'string' && value.trim()) {
    const problem = validateSteamId64(value)
    if (problem) throw invalidInput(problem, '给 17 位、以 7656 开头的 SteamID64')
    return { steamId64: value.trim(), apiKey: credentials?.apiKey ?? null }
  }
  return { steamId64: requireSteamId(credentials), apiKey: credentials?.apiKey ?? null }
}

const authShow: Command = {
  name: 'steam auth',
  summary: '看 Steam 凭据状态（key 只显示指纹）',
  usage: 'astra steam auth',
  notes: ['愿望单不需要 key；玩家资料、大部分 ISteamUser 接口需要'],
  maxArgs: 0,
  async run() {
    const credentials = loadSteamCredentials()
    if (!credentials) {
      return { data: { configured: false, hint: '`astra steam auth set-user <SteamID64>` 设置账号；需要 key 的接口再加 `set-key`' } }
    }
    return {
      data: {
        configured: true,
        steamId64: credentials.steamId64,
        hasApiKey: Boolean(credentials.apiKey),
        apiKeyDigest: credentials.apiKey ? apiKeyDigest(credentials.apiKey) : null,
        savedAt: credentials.savedAt,
      },
    }
  },
}

const authSetUser: Command = {
  name: 'steam auth set-user',
  summary: '设置默认 SteamID64',
  usage: 'astra steam auth set-user <7656...>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const problem = validateSteamId64(positionals[0]!)
    if (problem) throw invalidInput(problem, '从 steamcommunity.com/profiles/<id> 的链接里拿')
    const existing = loadSteamCredentials()
    const saved = saveSteamCredentials({ steamId64: positionals[0]!.trim(), apiKey: existing?.apiKey ?? null })
    return { data: { steamId64: saved.steamId64, hasApiKey: Boolean(saved.apiKey) } }
  },
}

const authSetKey: Command = {
  name: 'steam auth set-key',
  summary: '保存 Steam Web API key（存在本机，权限 600，不回显）',
  usage: 'astra steam auth set-key <key>',
  notes: [
    '在 https://steamcommunity.com/dev/apikey 申请，免费',
    '只有需要 key 的接口（玩家资料等）才用得上；愿望单不需要',
  ],
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const key = positionals[0]!.trim()
    if (!/^[0-9A-Fa-f]{32}$/.test(key)) throw invalidInput('Steam Web API key 是 32 位十六进制', '检查是不是复制错了')
    const existing = loadSteamCredentials()
    const saved = saveSteamCredentials({ steamId64: existing?.steamId64 ?? null, apiKey: key })
    return { data: { hasApiKey: true, apiKeyDigest: apiKeyDigest(saved.apiKey!), steamId64: saved.steamId64 } }
  },
}

const authClear: Command = {
  name: 'steam auth clear',
  summary: '清除 Steam 凭据',
  usage: 'astra steam auth clear',
  maxArgs: 0,
  async run() {
    const { clearSteamCredentials } = await import('./auth.ts')
    return { data: { cleared: clearSteamCredentials() } }
  },
}

const me: Command = {
  name: 'steam me',
  summary: '看自己的 Steam 资料（需要 key）',
  usage: 'astra steam me [--user 7656...]',
  notes: ['visibility: 1=私密 2=仅好友 3=公开。不是 3 的话愿望单和库存都读不到'],
  options: { user: { type: 'string', description: 'SteamID64，默认用已设置的', valueName: 'id' } },
  maxArgs: 0,
  async run({ values, signal }) {
    const { steamId64, apiKey } = resolveUser(values.user)
    const key = requireApiKey(loadSteamCredentials() ? { ...loadSteamCredentials()!, apiKey } : null)
    const players = await playerSummaries(key, [steamId64], signal)
    const player = players[0]
    if (!player) throw new AstraError('STEAM_USER_NOT_FOUND', `查不到 ${steamId64}`, { exitCode: 4 })
    return {
      data: {
        ...player,
        visibilityLabel: { 1: '私密', 2: '仅好友', 3: '公开' }[player.visibility ?? 0] ?? '未知',
        createdAtISO: player.createdAt ? new Date(player.createdAt * 1000).toISOString().slice(0, 10) : null,
      },
      warnings: player.visibility !== 3 ? ['账号资料不是公开的，愿望单和库存可能读不到'] : [],
    }
  },
}

const wishlistCmd: Command = {
  name: 'steam wishlist',
  summary: '愿望单：列出想买的游戏、价格和折扣',
  usage: 'astra steam wishlist [--limit 50] [--user 7656...] [--no-details] [--sort discount|price|added]',
  notes: [
    'appid 列表**不需要 key**，只要有公开愿望单',
    '补名字和价格要查商店详情，那个域名必须走代理（`proxy.include` 含 steampowered.com）',
    '--no-details 只列 appid，快但不带名字价格',
    '返回里 total 是愿望单总数，returned 是本次返回的',
  ],
  options: {
    limit: { type: 'string', short: 'n', description: '最多返回几个，默认 50', valueName: 'n' },
    user: { type: 'string', description: 'SteamID64', valueName: 'id' },
    'no-details': { type: 'boolean', description: '只列 appid，不查名字价格' },
    sort: { type: 'string', description: 'discount（折扣优先）/ price（价格降序）/ added（最近加入）', valueName: 'by' },
  },
  maxArgs: 0,
  async run({ values, signal }) {
    const { steamId64, apiKey } = resolveUser(values.user)
    const limit = Math.max(1, Math.min(500, Number(values.limit ?? '50') || 50))
    const result = await wishlist(steamId64, apiKey, signal)

    if (result.entries.length === 0) {
      return {
        data: { steamId64, total: 0, returned: 0, items: [] },
        warnings: ['愿望单是空的，或者账号的「游戏详情」没设为公开（Steam 对私密愿望单也返回空，不报错）'],
      }
    }

    const picked = result.entries.slice(0, limit)
    if (values['no-details'] === true) {
      return {
        data: {
          steamId64,
          total: result.entries.length,
          returned: picked.length,
          items: picked.map((e) => ({ appId: e.appId, dateAdded: e.dateAdded ? new Date(e.dateAdded * 1000).toISOString().slice(0, 10) : null })),
        },
      }
    }

    const details = await appDetails(picked.map((e) => e.appId), 'cn', 'schinese', signal)
    let items = picked.map((entry) => {
      const detail = details.get(entry.appId)
      return {
        appId: entry.appId,
        name: detail?.name ?? null,
        type: detail?.type ?? null,
        price: detail?.priceFormatted ?? (detail?.isFree ? '免费' : null),
        priceCents: detail?.priceCents ?? null,
        discountPercent: detail?.discountPercent ?? null,
        originalPrice: detail?.originalCents !== null && detail?.originalCents !== undefined
          ? `¥${(detail.originalCents / 100).toFixed(2)}`
          : null,
        onSale: (detail?.discountPercent ?? 0) > 0,
        addedAt: entry.dateAdded ? new Date(entry.dateAdded * 1000).toISOString().slice(0, 10) : null,
        storeUrl: `https://store.steampowered.com/app/${entry.appId}/`,
      }
    })

    const sort = typeof values.sort === 'string' ? values.sort : ''
    if (sort === 'discount') items = items.sort((a, b) => (b.discountPercent ?? 0) - (a.discountPercent ?? 0))
    else if (sort === 'price') items = items.sort((a, b) => (b.priceCents ?? -1) - (a.priceCents ?? -1))
    else if (sort === 'added') items = items.sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''))
    else if (sort) throw invalidInput(`--sort ${sort} 不合法`, '可选：discount / price / added')

    const missing = picked.length - items.filter((i) => i.name !== null).length
    const onSale = items.filter((i) => i.onSale).length
    return {
      data: {
        steamId64,
        total: result.entries.length,
        returned: items.length,
        truncated: result.entries.length > items.length,
        onSale,
        items,
      },
      warnings: missing > 0 ? [`${missing} 个条目查不到商店信息（可能已下架或地区不可售）`] : [],
    }
  },
}

const inventoryCmd: Command = {
  name: 'steam inventory',
  summary: '公开库存：看看某个游戏里有什么（CS2 饰品、Steam 卡牌等）',
  usage: 'astra steam inventory [--app 730] [--context 2] [--limit 100] [--user 7656...]',
  notes: [
    '走 steamcommunity.com，这个域名必须走代理',
    '只有公开库存能读；私密库存会明确报错而不是返回空',
    '常见 app：730=CS2，753=Steam 社区物品（卡牌/背景），570=Dota2，440=TF2',
  ],
  options: {
    app: { type: 'string', description: '游戏 appid，默认 730（CS2）', valueName: 'id' },
    context: { type: 'string', description: '库存上下文，默认 2', valueName: 'id' },
    limit: { type: 'string', short: 'n', description: '最多列几个，默认 100', valueName: 'n' },
    user: { type: 'string', description: 'SteamID64', valueName: 'id' },
  },
  maxArgs: 0,
  async run({ values, signal }) {
    const { steamId64 } = resolveUser(values.user)
    const appId = typeof values.app === 'string' && values.app ? values.app : '730'
    const contextId = typeof values.context === 'string' && values.context ? values.context : '2'
    const limit = Math.max(1, Math.min(5000, Number(values.limit ?? '100') || 100))
    if (!/^\d+$/.test(appId)) throw invalidInput('--app 必须是数字 appid')

    const result = await inventory(steamId64, appId, contextId, 5000, 'schinese', signal)
    const items = result.items.slice(0, limit)
    const tradable = result.items.filter((i) => i.tradable === true).length
    const marketable = result.items.filter((i) => i.marketable === true).length
    return {
      data: {
        steamId64,
        appId,
        contextId,
        total: result.total,
        returned: items.length,
        truncated: result.total > items.length,
        tradable,
        marketable,
        items,
      },
    }
  },
}

const doctor: Command = {
  name: 'steam doctor',
  summary: 'Steam 能力自检：网络、代理、凭据',
  usage: 'astra steam doctor',
  maxArgs: 0,
  async run() {
    const checks: { name: string; ok: boolean; detail: string }[] = []
    const credentials = loadSteamCredentials()
    checks.push({
      name: 'credentials',
      ok: credentials !== null,
      detail: credentials
        ? `SteamID64 ${credentials.steamId64 ?? '(未设)'}，key ${credentials.apiKey ? apiKeyDigest(credentials.apiKey) : '(未设)'}`
        : '未配置',
    })

    // 愿望单接口（免 key）—— 有 SteamID 才能测
    if (credentials?.steamId64) {
      try {
        const result = await wishlist(credentials.steamId64, credentials.apiKey)
        checks.push({
          name: 'wishlist_api',
          ok: true,
          detail: result.empty ? '接口可达，但愿望单为空或未公开' : `接口可达，${result.entries.length} 个条目`,
        })
      } catch (err) {
        checks.push({ name: 'wishlist_api', ok: false, detail: (err as Error).message.slice(0, 120) })
      }
    } else {
      checks.push({ name: 'wishlist_api', ok: false, detail: '先设置 SteamID64 才能测' })
    }

    // 商店详情（必须走代理）
    try {
      const details = await appDetails(['620'])
      const ok = details.has('620')
      checks.push({
        name: 'store_api',
        ok,
        detail: ok ? '商店详情可达（经代理）' : '商店详情拿不到数据',
      })
    } catch (err) {
      checks.push({
        name: 'store_api',
        ok: false,
        detail: `${(err as Error).message.slice(0, 100)} —— 检查 proxy.include 是否含 steampowered.com`,
      })
    }

    return { data: { ok: checks.every((c) => c.ok), checks } }
  },
}

export const steamCommands: Command[] = [authShow, authSetUser, authSetKey, authClear, me, wishlistCmd, inventoryCmd, doctor]

/**
 * Steam 接口：愿望单、库存、玩家资料。
 *
 * 域名的网络状况（实测 2026-10-21，NAS）：
 * - `api.steampowered.com`：直连可用（385ms），Steam 时好时坏，配了代理就走代理更稳
 * - `store.steampowered.com`：直连不通，**必须走代理**
 * - `steamcommunity.com`：直连不通，**必须走代理**
 *
 * 所以 `proxy.include` 里应该包含 `steampowered.com,steamcommunity.com`，
 * 而 `proxy.exclude` 放 `bilibili.com,music.163.com`（B 站对代理 IP 更敏感）。
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const API = 'https://api.steampowered.com'

async function getJson<T>(url: string, what: string, signal?: AbortSignal): Promise<T> {
  const options: Parameters<typeof httpRequest>[1] = {
    headers: { 'user-agent': UA, accept: 'application/json' },
    timeoutMs: 20_000,
    retries: 1,
  }
  if (signal) options.signal = signal
  const response = await httpRequest(url, options)
  const text = await response.text()
  if (!response.ok) {
    // Steam 的状态码含义：403=key 无效，400=参数不对，429=限流
    const hints: Record<number, string> = {
      403: 'key 无效或没有权限；重新申请或换一个',
      429: '被限流了。库存接口对共享代理 IP 很敏感，等一会儿再试；频繁请求会更久',
    }
    const hint = hints[response.status] ?? null
    throw new AstraError('STEAM_HTTP', `${what}返回 HTTP ${response.status}`, {
      exitCode: response.status === 403 ? 3 : 5,
      // 429 也算可重试 —— 它确实是"过一会儿就好了"
      retryable: response.status >= 500 || response.status === 429,
      ...(hint ? { hint } : {}),
      details: { status: response.status },
    })
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new AstraError('STEAM_BAD_RESPONSE', `${what}返回的不是 JSON`, { exitCode: 5, details: { preview: text.slice(0, 120) } })
  }
}

// ---------- 玩家资料 ----------

export interface SteamPlayer {
  steamId64: string
  name: string
  profileUrl: string | null
  avatar: string | null
  /** 1=私密 2=仅好友 3=公开。愿望单/库存能不能读取决于这个。 */
  visibility: number | null
  state: number | null
  lastLogoff: number | null
  createdAt: number | null
  countryCode: string | null
}

/** 玩家资料。需要 key。 */
export async function playerSummaries(apiKey: string, steamIds: string[], signal?: AbortSignal): Promise<SteamPlayer[]> {
  const url = `${API}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${steamIds.join(',')}`
  const body = await getJson<{ response?: { players?: { steamid?: string; personaname?: string; profileurl?: string; avatarfull?: string; communityvisibilitystate?: number; personastate?: number; lastlogoff?: number; timecreated?: number; loccountrycode?: string }[] } }>(
    url,
    '玩家资料',
    signal,
  )
  return (body.response?.players ?? []).map((p) => ({
    steamId64: p.steamid ?? '',
    name: p.personaname ?? '',
    profileUrl: p.profileurl ?? null,
    avatar: p.avatarfull ?? null,
    visibility: typeof p.communityvisibilitystate === 'number' ? p.communityvisibilitystate : null,
    state: typeof p.personastate === 'number' ? p.personastate : null,
    lastLogoff: typeof p.lastlogoff === 'number' ? p.lastlogoff : null,
    createdAt: typeof p.timecreated === 'number' ? p.timecreated : null,
    countryCode: p.loccountrycode ?? null,
  }))
}

// ---------- 愿望单 ----------

export interface WishlistEntry {
  appId: string
  /** 优先级（Steam 通常都是 0）。 */
  priority: number | null
  /** 加入愿望单的时间（unix 秒）。 */
  dateAdded: number | null
}

/**
 * 愿望单的 appid 列表。**不需要 key** —— 只要账号的"游戏详情"设为公开。
 *
 * 实测：私密愿望单返回 `{"response":{}}`（不报错也不给数据），
 * 所以拿到空数组时要区分"真的没有愿望单"和"账号不公开"。
 */
export async function wishlist(steamId64: string, apiKey: string | null, signal?: AbortSignal): Promise<{ entries: WishlistEntry[]; empty: boolean }> {
  const params = new URLSearchParams({ input_json: JSON.stringify({ steamid: steamId64 }) })
  if (apiKey) params.set('key', apiKey)
  const body = await getJson<{ response?: { items?: { appid?: number; priority?: number; date_added?: number }[] } }>(
    `${API}/IWishlistService/GetWishlist/v1/?${params}`,
    '愿望单',
    signal,
  )
  const raw = body.response?.items
  if (!raw) return { entries: [], empty: true }
  return {
    entries: raw
      .filter((x) => typeof x.appid === 'number')
      .map((x) => ({
        appId: String(x.appid),
        priority: typeof x.priority === 'number' ? x.priority : null,
        dateAdded: typeof x.date_added === 'number' ? x.date_added : null,
      })),
    empty: raw.length === 0,
  }
}

// ---------- 商店详情（走代理） ----------

export interface AppDetail {
  appId: string
  name: string
  type: string | null
  isFree: boolean
  /** 分（人民币）。`null` 表示没有价格信息（免费 / 未上架 / 地区不可售）。 */
  priceCents: number | null
  priceFormatted: string | null
  /** 打折前的价（分）。 */
  originalCents: number | null
  discountPercent: number | null
  currency: string | null
  headerImage: string | null
  shortDescription: string | null
}

interface RawAppDetails {
  [appId: string]: {
    success?: boolean
    data?: {
      name?: string
      type?: string
      is_free?: boolean
      price_overview?: { final?: number; initial?: number; discount_percent?: number; currency?: string; final_formatted?: string }
      header_image?: string
      short_description?: string
    }
  }
}

/**
 * 批量取商店详情。`store.steampowered.com` **必须走代理**（NAS 上直连超时）。
 *
 * **一次只能查一个 appid**：实测传 `appids=4000,287980` 会返回 400 Bad Request，
 * 所以这里逐个请求、并发 4 条。传多少个都行，内部自己排队，没有"最多 50 个"的限制。
 * 单个 appid 失败（下架、地区不可售）会被跳过，不中断整批 —— 返回的 Map 里没有它而已。
 */
export async function appDetails(appIds: string[], countryCode = 'cn', language = 'schinese', signal?: AbortSignal): Promise<Map<string, AppDetail>> {
  const out = new Map<string, AppDetail>()
  // 并发 4 条，兼顾速度和别把上游打急。
  const CONCURRENCY = 4
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      const appId = appIds[index]
      if (!appId) return
      if (signal?.aborted) return
      const params = new URLSearchParams({ appids: appId, cc: countryCode, l: language })
      try {
        const body = await getJson<RawAppDetails>(`https://store.steampowered.com/api/appdetails?${params}`, '商店详情', signal)
        const entry = body[appId]
        if (!entry?.success || !entry.data) continue
        const data = entry.data
        const price = data.price_overview
        out.set(appId, {
          appId,
          name: data.name ?? appId,
          type: data.type ?? null,
          isFree: data.is_free === true,
          priceCents: typeof price?.final === 'number' ? price.final : null,
          priceFormatted: price?.final_formatted ?? null,
          originalCents: typeof price?.initial === 'number' ? price.initial : null,
          discountPercent: typeof price?.discount_percent === 'number' ? price.discount_percent : null,
          currency: price?.currency ?? null,
          headerImage: data.header_image ?? null,
          shortDescription: data.short_description ?? null,
        })
      } catch {
        // 单个失败不影响其它（下架的 app 很常见）
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, appIds.length) }, worker))
  return out
}

// ---------- 库存 ----------

export interface InventoryItem {
  appId: string
  contextId: string
  assetId: string
  classId: string
  /** 名字（从描述里取，取不到就是 null）。 */
  name: string | null
  type: string | null
  /** 可交易 / 可市场出售。 */
  tradable: boolean | null
  marketable: boolean | null
  iconUrl: string | null
}

export interface InventoryResult {
  appId: string
  contextId: string
  total: number
  returned: number
  more: boolean
  items: InventoryItem[]
}

/**
 * 公开库存。走 `steamcommunity.com`，**必须走代理**。
 *
 * 注意：只有公开库存能读。私密库存会返回 `{success:false, Error:"This account is private"}`，
 * 这不是错误，是账号设置。
 */
export async function inventory(steamId64: string, appId: string, contextId = '2', count = 1000, language = 'schinese', signal?: AbortSignal): Promise<InventoryResult> {
  const url = `https://steamcommunity.com/inventory/${encodeURIComponent(steamId64)}/${encodeURIComponent(appId)}/${encodeURIComponent(contextId)}?l=${language}&count=${count}`
  const body = await getJson<{
    success?: number | boolean
    Error?: string
    total_inventory_count?: number
    assets?: { appid?: string | number; contextid?: string; assetid?: string; classid?: string; amount?: string }[]
    descriptions?: { classid?: string; instanceid?: string; name?: string; type?: string; tradable?: number; marketable?: number; icon_url?: string }[]
    more_items?: number
  }>(url, '库存', signal)

  if (body.success === false || body.success === 0) {
    const reason = body.Error ?? '未知原因'
    const hint = /private/i.test(reason) ? '在 Steam 隐私设置里把「库存」设为公开' : null
    throw new AstraError('STEAM_INVENTORY_UNAVAILABLE', `库存读取失败：${reason}`, {
      exitCode: 4,
      ...(hint ? { hint } : {}),
    })
  }

  // 资产只带 classid，名字在 descriptions 里，按 classid+instanceid 关联
  const descriptions = new Map<string, { name?: string; type?: string; tradable?: number; marketable?: number; icon_url?: string }>()
  for (const d of body.descriptions ?? []) {
    if (d.classid) descriptions.set(d.classid, d)
  }

  const assets = body.assets ?? []
  return {
    appId,
    contextId,
    total: typeof body.total_inventory_count === 'number' ? body.total_inventory_count : assets.length,
    returned: assets.length,
    more: body.more_items === 1,
    items: assets.map((a) => {
      const desc = a.classid ? descriptions.get(a.classid) : undefined
      return {
        appId: String(a.appid ?? appId),
        contextId: a.contextid ?? contextId,
        assetId: String(a.assetid ?? ''),
        classId: String(a.classid ?? ''),
        name: desc?.name ?? null,
        type: desc?.type ?? null,
        tradable: typeof desc?.tradable === 'number' ? desc.tradable === 1 : null,
        marketable: typeof desc?.marketable === 'number' ? desc.marketable === 1 : null,
        iconUrl: desc?.icon_url ? `https://community.cloudflare.steamstatic.com/economy/image/${desc.icon_url}/128fx128f` : null,
      }
    }),
  }
}

// ---------- 拥有的游戏 ----------

export interface OwnedGame {
  appId: number
  name: string
  /** 总时长（分钟），挂时长会算进这个数。 */
  minutes: number
}

/**
 * 库里拥有的全部游戏（含免费游戏）。
 *
 * 需要 Web API key + 账号「游戏详情」公开。挂时长用游戏名解析 AppID 时用它，
 * 这样不用依赖别的服务。
 */
export async function ownedGames(apiKey: string, steamId64: string, signal?: AbortSignal): Promise<OwnedGame[]> {
  const query = new URLSearchParams({ key: apiKey, steamid: steamId64, include_appinfo: '1', include_played_free_games: '1' })
  const url = `${API}/IPlayerService/GetOwnedGames/v1/?${query.toString()}`
  const payload = await getJson<{ response?: { games?: { appid: number; name?: string; playtime_forever?: number }[] } }>(url, '游戏库', signal)
  const games = payload.response?.games ?? []
  if (games.length === 0) {
    throw new AstraError('STEAM_LIBRARY_EMPTY', '游戏库是空的', {
      exitCode: 4,
      hint: '确认账号的「游戏详情」是公开的（Steam 隐私设置），并且 key 属于这个账号',
    })
  }
  return games.map((g) => ({ appId: g.appid, name: g.name ?? `App ${g.appid}`, minutes: g.playtime_forever ?? 0 }))
}

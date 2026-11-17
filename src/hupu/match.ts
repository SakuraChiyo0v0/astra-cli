/**
 * 虎扑比赛与评分（独立域名，匿名可用）。
 *
 * 来源：`bidabrain/hupuX` 的 `doc/api/match-score.md`（2026-09 实测）+ 我自己 2026-11-17 复验。
 * 两个接口都不需要 Cookie / 签名，但**路径里带客户端版本号**，虎扑发版后可能 404——
 * `hupu doctor` 会探一次，红了就是版本号该换了。
 *
 *  - 赛程：match-api.hupu.com/1/8.2.10/…/getScheduleListByTagForH5?businessId=<赛事>
 *  - 评分：games.mobileapi.hupu.com/1/8.0.99/bplcommentapi/bpl/score_tree/…
 */
import { AstraError } from '../core/errors.ts'

const MATCH_ORIGIN = 'https://match-api.hupu.com/1/8.2.10/matchallapi/bff/standard/getScheduleListByTagForH5'
const SCORE_ORIGIN = 'https://games.mobileapi.hupu.com/1/8.0.99/bplcommentapi/bpl/score_tree'
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const TIMEOUT_MS = 20_000

/** 实测有数据的赛事 id（其它写法上游返回空数组，不报错，所以只列确认过的）。 */
export const SPORTS: Array<{ id: string; label: string }> = [
  { id: 'nba', label: 'NBA' },
  { id: 'cba', label: 'CBA' },
  { id: 'wnba', label: 'WNBA' },
  { id: 'cuba', label: 'CUBA' },
  { id: 'epl', label: '英超' },
  { id: 'worldcup', label: '世界杯' },
  { id: 'lpl', label: 'LPL' },
  { id: 'lck', label: 'LCK' },
  { id: 'kog', label: 'KPL' },
  { id: 'pubg', label: 'PUBG' },
  { id: 'lol', label: '英雄联盟' },
  { id: 'tennis', label: '网球' },
]

export interface HupuMatch {
  matchId: string
  status: string
  intro: string
  startAt: string | null
  scoreCountText: string | null
  teams: string[]
  winner: string | null
  topName: string | null
  topScore: number | null
  topItemNo: string | null
}

export interface HupuScoreItem {
  name: string
  avg: number | null
  people: number | null
  comments: number | null
  distribution: Record<string, number> | null
  hotUser: string | null
  hotText: string | null
  hotLight: number | null
  hotScore: number | null
}

export interface HupuScoreBoard {
  title: string
  peopleTotal: number | null
  items: HupuScoreItem[]
}

async function getJson(url: string, referer: string): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'user-agent': MOBILE_UA, referer, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new AstraError('HUPU_NETWORK', `请求虎扑比赛接口失败：${(error as Error).message}`, {
      hint: '虎扑比赛接口在国内可直连；检查出网',
    })
  }
  if (!res.ok) {
    throw new AstraError('HUPU_SCORE_HTTP', `虎扑比赛接口返回 HTTP ${res.status}`, {
      hint: '接口路径带客户端版本号，虎扑发版后可能失效；等 astra 更新版本号',
    })
  }
  return (await res.json()) as Record<string, unknown>
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s ? s : null
}

function tsToLocal(raw: unknown): string | null {
  const ms = numOrNull(raw)
  if (ms === null || ms <= 0) return null
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 赛程：把 dayGameData 摊平成按时间排序的比赛列表。纯函数。 */
export function parseSchedule(payload: Record<string, unknown>): HupuMatch[] {
  const result = (payload.result ?? {}) as Record<string, unknown>
  const days = (result.dayGameData ?? []) as Array<Record<string, unknown>>
  const out: HupuMatch[] = []
  for (const day of days) {
    for (const m of (day.matchData ?? []) as Array<Record<string, unknown>>) {
      const against = (m.againstInfo ?? {}) as Record<string, unknown>
      const members = (against.memberInfos ?? []) as Array<Record<string, unknown>>
      const teams = members
        .map((x) => {
          const name = strOrNull(x.memberName) ?? '?'
          const score = strOrNull(x.memberBaseScore)
          return score && score !== '-' ? `${name} ${score}` : name
        })
        .filter(Boolean)
      const winnerId = strOrNull(against.winnerMemberId)
      const winnerName = winnerId
        ? (strOrNull(members.find((x) => strOrNull(x.memberId) === winnerId)?.memberName) ?? null)
        : null
      const item = (m.scoreItemInfo ?? {}) as Record<string, unknown>
      out.push({
        matchId: strOrNull(m.matchId) ?? '',
        status: strOrNull(m.matchStatus) ?? '',
        intro: strOrNull(m.matchIntroduction) ?? '',
        startAt: tsToLocal(m.matchStartTimeStamp),
        scoreCountText: strOrNull(m.scoreCountText),
        teams,
        winner: winnerName,
        topName: strOrNull(item.name),
        topScore: numOrNull(item.scoreNum),
        topItemNo: strOrNull(item.scoreOutBizNo),
      })
    }
  }
  return out
}

/** 评分树：比赛中每个被评分条目（球员/教练/裁判）。纯函数。 */
export function parseScoreBoard(payload: Record<string, unknown>, fallbackTitle = ''): HupuScoreBoard {
  const data = (payload.data ?? {}) as Record<string, unknown>
  const selfNode = ((data.self ?? {}) as Record<string, unknown>).node as Record<string, unknown> | undefined
  const title = strOrNull(selfNode?.name) ?? fallbackTitle
  const peopleTotal = numOrNull((data.self as Record<string, unknown> | undefined)?.summedScorePersonCount)
  const rows = (((data.pageResult ?? {}) as Record<string, unknown>).data ?? []) as Array<Record<string, unknown>>
  const items: HupuScoreItem[] = []
  for (const row of rows) {
    const node = (row.node ?? {}) as Record<string, unknown>
    const dist = node.scoreDistribution as Record<string, unknown> | undefined
    const hot = (node.hotCommentModels as Array<Record<string, unknown>> | undefined)?.[0]
    items.push({
      name: strOrNull(node.name) ?? '?',
      avg: numOrNull(node.scoreAvg),
      people: numOrNull(node.scorePersonCount),
      comments: numOrNull(node.commentCount),
      distribution: dist
        ? Object.fromEntries(
            Object.entries(dist)
              .map(([k, v]) => [k, numOrNull(v) ?? 0] as const)
              .sort((a, b) => Number(a[0]) - Number(b[0])),
          )
        : null,
      hotUser: strOrNull(hot?.commentUserName),
      hotText: strOrNull(hot?.commentContent),
      hotLight: numOrNull(hot?.lightCount),
      hotScore: numOrNull(hot?.score),
    })
  }
  return { title, peopleTotal, items }
}

/** 某场比赛的评分条目（含比分标题）。 */
export async function fetchScoreBoard(matchNo: string, itemType = 'basketball'): Promise<HupuScoreBoard> {
  const url = `${SCORE_ORIGIN}/getCurAndSubNodeByBizKey?outBizType=${itemType}_match&outBizNo=${encodeURIComponent(matchNo)}&relation=CHILD&page=1&pageSize=100`
  return parseScoreBoard(await getJson(url, 'https://m.hupu.com/'))
}

/** 从球员条的 outBizNo 反查所属比赛（评分树里比赛节点才有全部条目）。 */
export async function parentMatchOf(itemNo: string, itemType = 'basketball'): Promise<string> {
  const url = `${SCORE_ORIGIN}/getSelfByBizKey?outBizType=${itemType}_item&outBizNo=${encodeURIComponent(itemNo)}`
  const payload = await getJson(url, 'https://m.hupu.com/')
  const data = (payload.data ?? {}) as Record<string, unknown>
  const links = (data.linkNodes ?? []) as Array<Record<string, unknown>>
  for (const link of links) {
    if (strOrNull(link.target) !== 'PARENT') continue
    const key = (link.outBizKey ?? {}) as Record<string, unknown>
    const no = strOrNull(key.outBizNo)
    if (no) return no
  }
  throw new AstraError('HUPU_SCORE_NO_PARENT', '这条评分没有所属比赛（可能是单条评分）', {
    hint: '换一场比赛再试',
  })
}

export async function listMatches(sport: string): Promise<HupuMatch[]> {
  const url = `${MATCH_ORIGIN}?businessType=common&datasource=navigation&businessId=${encodeURIComponent(sport)}`
  return parseSchedule(await getJson(url, 'https://bbs.hupu.com/'))
}

/**
 * 赛程 + 锚点。接口一次给整季（过去到未来），锚点指向「今天附近」那一场，
 * 不带着它就会看到几个月后的比赛。
 */
export async function listSchedule(sport: string): Promise<{ anchorId: string | null; matches: HupuMatch[] }> {
  const url = `${MATCH_ORIGIN}?businessType=common&datasource=navigation&businessId=${encodeURIComponent(sport)}`
  const payload = await getJson(url, 'https://bbs.hupu.com/')
  const result = (payload.result ?? {}) as Record<string, unknown>
  return { anchorId: strOrNull(result.anchorMatchId), matches: parseSchedule(payload) }
}

/** 在赛程里按 matchId 找一场，用来把 matchId 翻成评分树的 outBizNo。 */
export async function locateMatch(matchId: string, sport: string): Promise<HupuMatch> {
  const matches = await listMatches(sport)
  const hit = matches.find((m) => m.matchId === matchId)
  if (!hit) {
    throw new AstraError('HUPU_MATCH_NOT_FOUND', `赛程里没有 matchId=${matchId}`, {
      hint: '先跑 `astra hupu match` 看可用的 matchId；评分只对已结束的比赛有数据',
    })
  }
  return hit
}

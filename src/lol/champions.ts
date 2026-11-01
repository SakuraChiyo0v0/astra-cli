/**
 * 英雄 id → 名字。
 *
 * 战绩接口只给 `championId`（数字），直接看库是「235 / 62 / 107」这种没用。
 * 用 Data Dragon 的 `zh_CN/champion.json` 补一份映射表，离线可查、不依赖 LCU。
 *
 * 为什么要落库而不是每次请求：Data Dragon 要出网（走代理），而查战绩是高频操作；
 * 英雄表几个月才变一次，存起来就够了（`astra lol champions --refresh` 手动刷）。
 */
import type { Conn } from '../core/db/adapter.ts'

const VERSIONS_URL = 'https://ddragon.leagueoflegends.com/api/versions.json'
const CHAMPION_URL = (version: string) => `https://ddragon.leagueoflegends.com/cdn/${version}/data/zh_CN/champion.json`

export interface ChampionRow {
  championId: number
  name: string
  title: string | null
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Data Dragon ${res.status}`)
  return (await res.json()) as T
}

/** 拉取当前版本的英雄表（中文）。 */
export async function fetchChampions(): Promise<{ version: string; rows: ChampionRow[] }> {
  const versions = await getJson<string[]>(VERSIONS_URL)
  const version = versions[0]
  if (!version) throw new Error('Data Dragon 没返回版本号')
  const payload = await getJson<{ data: Record<string, { key: string; name: string; title?: string }> }>(CHAMPION_URL(version))
  const rows: ChampionRow[] = Object.values(payload.data ?? {})
    .map((c) => ({ championId: Number(c.key), name: c.name, title: c.title ?? null }))
    .filter((c) => Number.isFinite(c.championId))
    .sort((a, b) => a.championId - b.championId)
  return { version, rows }
}

export async function storeChampions(conn: Conn, table: string, rows: ChampionRow[]): Promise<number> {
  const now = new Date().toISOString()
  await conn.tx(async (tx) => {
    for (const row of rows) {
      await tx.exec(
        `insert into ${table} (champion_id, name, title, updated_at) values (?,?,?,?)
         on conflict (champion_id) do update set name = ?, title = ?, updated_at = ?`,
        [row.championId, row.name, row.title, now, row.name, row.title, now],
      )
    }
  })
  return rows.length
}

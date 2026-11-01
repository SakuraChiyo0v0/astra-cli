/**
 * 战绩落库与查询（`crawl.lol_*`）。
 *
 * 表设计原则（和 douyin 一份思路）：**原始 JSON 只留一份兜底，常用字段拆成列**。
 * 拆列是为了能直接 `order by` / `group by`；原始 JSON 是为了以后想加字段不用重爬
 * ——LCU 只给最近 ~21 局，漏了就真的没了。
 *
 * 建表放在代码里（`ensureSchema`）而不是只靠 ASTRA_HOME 的迁移文件：
 * 换台机器、换个库，`astra lol sync` 第一次跑就能自己把表建出来。
 */
import type { Conn } from '../core/db/adapter.ts'
import { openDatabase, type Database } from '../core/db/index.ts'
import { myParticipant, type LcuGame, type LcuRankedEntry, type LcuSnapshot } from './bridge.ts'

export interface MatchRow {
  gameId: number
  puuid: string
  queueId: number | null
  gameMode: string | null
  gameType: string | null
  gameVersion: string | null
  gameCreation: string | null
  durationSec: number | null
  championId: number | null
  win: boolean
  kills: number
  deaths: number
  assists: number
  champLevel: number
  cs: number
  goldEarned: number
  damageChamp: number
  visionScore: number
  doubleKills: number
  tripleKills: number
  quadraKills: number
  pentaKills: number
  position: string | null
  items: number[]
  raw: string
}

/**
 * 表名。PG 侧统一放 `crawl` schema（跟 douyin 那批数据一致，也是个「外部抓来的东西」的分区）；
 * SQLite 没有 schema 概念，直接裸表名。
 */
export function tableName(dialectName: string, name: string): string {
  return dialectName === 'postgres' ? `crawl.${name}` : name
}

let schemaDialect = 'postgres'

export async function openLolDb(): Promise<Database> {
  const db = await openDatabase()
  schemaDialect = db.dialect.name
  if (db.dialect.name === 'postgres') await db.conn.exec('create schema if not exists crawl')
  await ensureSchema(db.conn, db.dialect.name)
  return db
}

export async function ensureSchema(conn: Conn, dialectName = 'postgres'): Promise<void> {
  const t = (name: string) => tableName(dialectName, name)
  await conn.exec(`create table if not exists ${t('lol_summoner')} (
    puuid text primary key,
    game_name text,
    summoner_level integer,
    updated_at text
  )`)
  await conn.exec(`create table if not exists ${t('lol_match')} (
    game_id bigint primary key,
    puuid text,
    queue_id integer,
    game_mode text,
    game_type text,
    game_version text,
    game_creation text,
    duration_sec integer,
    champion_id integer,
    win boolean,
    kills integer, deaths integer, assists integer,
    champ_level integer,
    cs integer, gold_earned integer, damage_champ integer, vision_score integer,
    double_kills integer, triple_kills integer, quadra_kills integer, penta_kills integer,
    position text,
    items text,
    raw text,
    fetched_at text
  )`)
  await conn.exec(`create table if not exists ${t('lol_rank_snap')} (
    snap_date text not null,
    queue text not null,
    tier text, division text, league_points integer, wins integer, losses integer,
    primary key (snap_date, queue)
  )`)
  await conn.exec(`create table if not exists ${t('lol_champion')} (
    champion_id integer primary key,
    name text not null,
    title text,
    updated_at text
  )`)
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

/** LCU 的一局 → 一行库记录。纯函数，可单测。 */
export function toMatchRow(game: LcuGame, puuid: string): MatchRow | null {
  const gameId = num(game.gameId, 0)
  if (!gameId) return null
  const me = myParticipant(game)
  if (!me) return null
  const stats = (me.stats ?? {}) as Record<string, unknown>
  const created = num(game.gameCreation, 0)
  const items = Array.from({ length: 7 }, (_, i) => num(stats[`item${i}`], 0))
  return {
    gameId,
    puuid,
    queueId: game.queueId === undefined ? null : num(game.queueId),
    gameMode: game.gameMode ?? null,
    gameType: game.gameType ?? null,
    gameVersion: game.gameVersion ?? null,
    gameCreation: created ? new Date(created).toISOString() : null,
    durationSec: game.gameDuration === undefined ? null : num(game.gameDuration),
    championId: me.championId === undefined ? null : num(me.championId),
    win: stats.win === true,
    kills: num(stats.kills),
    deaths: num(stats.deaths),
    assists: num(stats.assists),
    champLevel: num(stats.champLevel),
    cs: num(stats.totalMinionsKilled) + num(stats.neutralMonstersKilled ?? stats.neutralMinionsKilled),
    goldEarned: num(stats.goldEarned),
    damageChamp: num(stats.totalDamageDealtToChampions),
    visionScore: num(stats.visionScore),
    doubleKills: num(stats.doubleKills),
    tripleKills: num(stats.tripleKills),
    quadraKills: num(stats.quadraKills),
    pentaKills: num(stats.pentaKills),
    position: me.timeline?.lane ?? me.timeline?.role ?? null,
    items,
    raw: JSON.stringify(game),
  }
}

/** 把一次快照写进库。返回实际写入的局数与段位条数。 */
export async function storeSnapshot(conn: Conn, snapshot: LcuSnapshot): Promise<{ games: number; ranks: number; puuid: string }> {
  const t = (n: string) => tableName(schemaDialect, n)
  const puuid = snapshot.summoner?.puuid ?? ''
  const name = snapshot.summoner?.gameName ?? snapshot.summoner?.displayName ?? ''
  const level = num(snapshot.summoner?.summonerLevel, 0)
  const now = new Date().toISOString()

  const rows = snapshot.games
    .map((g) => toMatchRow(g, puuid))
    .filter((r): r is MatchRow => r !== null)

  const ranks = Object.entries(snapshot.ranked?.queueMap ?? {})
    .filter(([, entry]: [string, LcuRankedEntry]) => Boolean(entry?.tier))

  await conn.tx(async (tx) => {
    await tx.exec(
      `insert into ${t('lol_summoner')} (puuid, game_name, summoner_level, updated_at) values (?, ?, ?, ?)
       on conflict (puuid) do update set game_name = ?, summoner_level = ?, updated_at = ?`,
      [puuid, name, level, now, name, level, now],
    )
    for (const row of rows) {
      await tx.exec(
        `insert into ${t('lol_match')} (game_id, puuid, queue_id, game_mode, game_type, game_version, game_creation,
           duration_sec, champion_id, win, kills, deaths, assists, champ_level, cs, gold_earned, damage_champ,
           vision_score, double_kills, triple_kills, quadra_kills, penta_kills, position, items, raw, fetched_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         on conflict (game_id) do update set win = ?, kills = ?, deaths = ?, assists = ?, champ_level = ?,
           cs = ?, gold_earned = ?, damage_champ = ?, vision_score = ?, items = ?, raw = ?, fetched_at = ?`,
        [row.gameId, row.puuid, row.queueId, row.gameMode, row.gameType, row.gameVersion, row.gameCreation,
          row.durationSec, row.championId, row.win, row.kills, row.deaths, row.assists, row.champLevel, row.cs,
          row.goldEarned, row.damageChamp, row.visionScore, row.doubleKills, row.tripleKills, row.quadraKills,
          row.pentaKills, row.position, JSON.stringify(row.items), row.raw, now,
          row.win, row.kills, row.deaths, row.assists, row.champLevel, row.cs, row.goldEarned, row.damageChamp,
          row.visionScore, JSON.stringify(row.items), row.raw, now],
      )
    }
    const today = new Date().toISOString().slice(0, 10)
    for (const [queue, entry] of ranks) {
      await tx.exec(
        `insert into ${t('lol_rank_snap')} (snap_date, queue, tier, division, league_points, wins, losses)
         values (?,?,?,?,?,?,?)
         on conflict (snap_date, queue) do update set tier = ?, division = ?, league_points = ?, wins = ?, losses = ?`,
        [today, queue, entry.tier ?? null, entry.division ?? null, num(entry.leaguePoints), num(entry.wins), num(entry.losses),
          entry.tier ?? null, entry.division ?? null, num(entry.leaguePoints), num(entry.wins), num(entry.losses)],
      )
    }
  })

  return { games: rows.length, ranks: ranks.length, puuid }
}

/** 最近对局（带英雄中文名，没同步过英雄表就显示 id）。 */
export async function recentMatches(conn: Conn, options: { limit: number; champion?: string; queue?: number; onlyWin?: boolean; onlyLoss?: boolean }) {
  const t = (n: string) => tableName(schemaDialect, n)
  const where: string[] = []
  const params: unknown[] = []
  if (options.champion) {
    where.push('c.name like ?')
    params.push(`%${options.champion}%`)
  }
  if (options.queue !== undefined) {
    where.push('m.queue_id = ?')
    params.push(options.queue)
  }
  if (options.onlyWin) where.push('m.win = ?')
  if (options.onlyWin) params.push(true)
  if (options.onlyLoss) where.push('m.win = ?')
  if (options.onlyLoss) params.push(false)
  params.push(options.limit)
  const sql = `select m.game_id, m.game_creation, m.queue_id, m.champion_id, coalesce(c.name, cast(m.champion_id as text)) as champion,
      m.win, m.kills, m.deaths, m.assists, m.champ_level, m.cs, m.gold_earned, m.damage_champ, m.vision_score,
      m.duration_sec, m.position, m.items
    from ${t('lol_match')} m left join ${t('lol_champion')} c on c.champion_id = m.champion_id
    ${where.length ? `where ${where.join(' and ')}` : ''}
    order by m.game_creation desc limit ?`
  return conn.query<Record<string, unknown>>(sql, params)
}

export interface StatBucket {
  games: number
  wins: number
  winRate: number
  avgKills: number
  avgDeaths: number
  avgAssists: number
  avgCs: number
  avgDamage: number
  avgDurationMin: number
}

/** 汇总统计（整体 / 按英雄 / 按队列都由它算，避免三份重复 SQL）。 */
export async function stats(conn: Conn, options: { days?: number; groupBy?: 'champion' | 'queue' } = {}) {
  const t = (n: string) => tableName(schemaDialect, n)
  const where: string[] = []
  const params: unknown[] = []
  if (options.days && options.days > 0) {
    const since = new Date(Date.now() - options.days * 86_400_000).toISOString()
    where.push('m.game_creation >= ?')
    params.push(since)
  }
  const group = options.groupBy === 'champion'
    ? `coalesce(c.name, cast(m.champion_id as text))`
    : options.groupBy === 'queue'
      ? `cast(m.queue_id as text)`
      : `'all'`
  const join = options.groupBy === 'champion' ? `left join ${t('lol_champion')} c on c.champion_id = m.champion_id` : ''
  const rows = await conn.query<Record<string, unknown>>(
    `select ${group} as bucket,
        count(*) as games,
        sum(case when m.win then 1 else 0 end) as wins,
        avg(m.kills) as k, avg(m.deaths) as d, avg(m.assists) as a,
        avg(m.cs) as cs, avg(m.damage_champ) as dmg, avg(m.duration_sec) as dur
      from ${t('lol_match')} m ${join}
      ${where.length ? `where ${where.join(' and ')}` : ''}
      group by ${group} order by games desc`,
    params,
  )
  return rows.map((r) => ({
    bucket: String(r.bucket),
    games: num(r.games),
    wins: num(r.wins),
    winRate: num(r.games) ? Math.round((num(r.wins) / num(r.games)) * 100) : 0,
    avgKills: round1(r.k), avgDeaths: round1(r.d), avgAssists: round1(r.a),
    avgCs: Math.round(num(r.cs)), avgDamage: Math.round(num(r.dmg)),
    avgDurationMin: round1(num(r.dur) / 60),
  }))
}

function round1(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0
}

export async function latestRanks(conn: Conn) {
  const t = (n: string) => tableName(schemaDialect, n)
  return conn.query<Record<string, unknown>>(
    `select queue, tier, division, league_points, wins, losses, snap_date
       from ${t('lol_rank_snap')} order by snap_date desc, queue`,
  )
}

/** 英雄 id → 中文名。表空时返回空 Map（调用方回落到 id）。 */
export async function championNameMap(conn: Conn, dialectName: string): Promise<Map<number, string>> {
  const rows = await conn.query<{ champion_id: number; name: string }>(
    `select champion_id, name from ${tableName(dialectName, 'lol_champion')}`,
  )
  return new Map(rows.map((r) => [Number(r.champion_id), String(r.name)]))
}

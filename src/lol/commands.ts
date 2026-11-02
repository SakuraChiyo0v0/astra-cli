/**
 * `astra lol ...` — 英雄联盟战绩（数据源：PC 上客户端的 LCU）。
 *
 * 国服没有公开战绩 API，所以这里的每个写入命令都要 PC 在线 + 客户端开着；
 * 读命令（history / stats / rank）只查库，PC 关着也能用。
 *
 * 典型用法：
 *   astra lol sync                 # 抓最近 20 局入库（客户端要开着）
 *   astra lol history --limit 10   # 看最近 10 局
 *   astra lol stats --by champion  # 英雄池胜率
 */
import { getConfig } from '../core/config.ts'
import type { Command, CommandResult } from '../core/command.ts'
import { AstraError, invalidInput } from '../core/errors.ts'
import { okResult } from '../core/output.ts'
import { fetchLcuSnapshot, fetchPlayerRank, fetchPlayerSnapshot, pcHost, myParticipant } from './bridge.ts'
import { championNameMap, latestRanks, openLolDb, recentMatches, stats, storeSnapshot, tableName } from './db.ts'
import { fetchChampions, storeChampions } from './champions.ts'

const ASTRA = '/opt/astra/bin/astra'

function limitOf(value: unknown, fallback: number, max = 200): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > max) throw invalidInput(`--limit 只能是 1..${max} 的整数`)
  return n
}

function kda(k: number, d: number, a: number): string {
  return d === 0 ? `${k}/${d}/${a} (∞)` : `${k}/${d}/${a} (${((k + a) / d).toFixed(2)})`
}

/**
 * 时间字段统一成 `YYYY-MM-DD HH:mm`。
 * PG 的 timestamptz 列会被驱动还原成 Date 对象，SQLite 则是字符串 —— 两种都要认，
 * 只判 string 会让 PG 下的日期全变 null（踩过一次）。
 */
function fmtDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 16).replace('T', ' ')
  if (typeof value === 'string' && value.length >= 16) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 16).replace('T', ' ')
  }
  return null
}

function minutes(sec: number | null | undefined): number {
  return sec ? Math.round(sec / 60) : 0
}

export const lolCommands: Command[] = [
  {
    name: 'lol sync',
    summary: '从 PC 客户端（LCU）拉最近约 20 局战绩并入库',
    usage: 'astra lol sync [--pc <host>]',
    notes: [
      '国服没有公开战绩接口，只能借 PC 上开着的客户端；LCU 只监听 127.0.0.1，所以走 ssh。',
      'LCU 的 `begIndex/endIndex` 无效，一次固定给最近约 21 局 —— 想要长历史就定时同步，慢慢累积。',
      '客户端没开时报 LOL_CLIENT_NOT_RUNNING（退出码 3），不是数据丢了。',
    ],
    options: {
      pc: { type: 'string', description: 'PC 的 ssh 主机名（默认取配置 lol.pc，或 "pc"）', valueName: 'host' },
    },
    run: async (ctx): Promise<CommandResult> => {
      const host = typeof ctx.values.pc === 'string' ? ctx.values.pc : pcHost()
      const snapshot = await fetchLcuSnapshot({ host, ...(ctx.signal ? { signal: ctx.signal } : {}) })
      const db = await openLolDb()
      try {
        const stored = await storeSnapshot(db.conn, snapshot)
        const championTable = tableName(db.dialect.name, 'lol_champion')
        const championCount = await db.conn.query<{ c: number }>(`select count(*) as c from ${championTable}`)
        const warnings: string[] = []
        if (Number(championCount[0]?.c ?? 0) === 0) {
          warnings.push('英雄名表是空的，战绩里只能看到数字 id；跑一次 `astra lol champions --refresh`')
        }
        return okResult(
          {
            summoner: snapshot.summoner.gameName ?? snapshot.summoner.displayName ?? null,
            puuid: stored.puuid,
            games: stored.games,
            ranks: stored.ranks,
            source: 'lcu',
            host,
          },
          warnings,
        )
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'lol history',
    summary: '查已入库的最近对局',
    usage: 'astra lol history [--limit 20] [--champion <英雄>] [--queue <id>] [--win|--loss]',
    notes: [
      '数据来自 `lol sync`，不是实时；PC 关着也能查。',
      '--queue 用 LCU 的 queueId：420 单双排、440 灵活排、400 匹配、2400 极地大乱斗（国服 ARAM，map 12，带强化符文）。',
    ],
    options: {
      limit: { type: 'string', description: '返回条数（默认 20，最多 200）', valueName: 'n' },
      champion: { type: 'string', description: '按英雄中文名模糊过滤', valueName: 'name' },
      queue: { type: 'string', description: '按 queueId 过滤', valueName: 'id' },
      win: { type: 'boolean', description: '只看赢的' },
      loss: { type: 'boolean', description: '只看输的' },
    },
    run: async (ctx): Promise<CommandResult> => {
      if (ctx.values.win === true && ctx.values.loss === true) throw invalidInput('--win 和 --loss 不能同时给')
      const limit = limitOf(ctx.values.limit, 20)
      const queue = ctx.values.queue === undefined ? undefined : Number(ctx.values.queue)
      if (queue !== undefined && !Number.isInteger(queue)) throw invalidInput('--queue 要是数字')
      const db = await openLolDb()
      try {
        const rows = await recentMatches(db.conn, {
          limit,
          ...(typeof ctx.values.champion === 'string' ? { champion: ctx.values.champion } : {}),
          ...(queue === undefined ? {} : { queue }),
          ...(ctx.values.win === true ? { onlyWin: true } : {}),
          ...(ctx.values.loss === true ? { onlyLoss: true } : {}),
        })
        const data = {
            count: rows.length,
            matches: rows.map((r) => ({
              gameId: Number(r.game_id),
              date: fmtDate(r.game_creation),
              queueId: Number(r.queue_id ?? 0),
              champion: String(r.champion ?? ''),
              win: r.win === true || r.win === 1 || r.win === '1' || r.win === 'true',
              kda: `${Number(r.kills ?? 0)}/${Number(r.deaths ?? 0)}/${Number(r.assists ?? 0)}`,
              cs: Number(r.cs ?? 0),
              damage: Number(r.damage_champ ?? 0),
              minutes: minutes(Number(r.duration_sec ?? 0)),
            })),
          }
        const tableRows = rows.map((r) => [
          fmtDate(r.game_creation) ?? '-',
          String(r.champion ?? ''),
          (r.win === true || r.win === 1 || r.win === '1' || r.win === 'true') ? '胜' : '负',
          `${Number(r.kills ?? 0)}/${Number(r.deaths ?? 0)}/${Number(r.assists ?? 0)}`,
          Number(r.cs ?? 0),
          Number(r.damage_champ ?? 0),
          minutes(Number(r.duration_sec ?? 0)),
        ])
        return {
          ...okResult(data, []),
          table: { headers: ['时间', '英雄', '结果', 'KDA', '补刀', '伤害', '分钟'], rows: tableRows },
        }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'lol stats',
    summary: '战绩统计（总胜率 / 英雄池 / 队列分布）',
    usage: 'astra lol stats [--days 30] [--by champion|queue]',
    notes: ['按英雄或队列分组；不给 --by 就是整体一行。'],
    options: {
      days: { type: 'string', description: '只统计最近 N 天', valueName: 'n' },
      by: { type: 'string', description: 'champion 或 queue', valueName: 'field' },
    },
    run: async (ctx): Promise<CommandResult> => {
      const by = ctx.values.by
      if (by !== undefined && by !== 'champion' && by !== 'queue') throw invalidInput('--by 只能是 champion 或 queue')
      const days = ctx.values.days === undefined ? 30 : Number(ctx.values.days)
      if (!Number.isFinite(days) || days < 0) throw invalidInput('--days 要给非负整数')
      const db = await openLolDb()
      try {
        const rows = await stats(db.conn, {
          ...(days > 0 ? { days } : {}),
          ...(by === 'champion' || by === 'queue' ? { groupBy: by } : {}),
        })
        const total = rows.reduce((acc, r) => ({
          games: acc.games + r.games,
          wins: acc.wins + r.wins,
        }), { games: 0, wins: 0 })
        const data = {
            days: days > 0 ? days : 'all',
            overall: {
              games: total.games,
              wins: total.wins,
              winRate: total.games ? Math.round((total.wins / total.games) * 100) : 0,
            },
            buckets: rows,
          }
        return {
          ...okResult(data, []),
          table: {
            headers: ['分组', '场次', '胜', '胜率%', 'K/D/A', '补刀', '伤害', '分钟'],
            rows: rows.map((r) => [r.bucket, r.games, r.wins, r.winRate,
              `${r.avgKills}/${r.avgDeaths}/${r.avgAssists}`, r.avgCs, r.avgDamage, r.avgDurationMin]),
          },
        }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'lol rank',
    summary: '看自己的段位快照；给「名字#TAG」则实时查任意召唤师的当前段位',
    usage: 'astra lol rank [名字#TAG] [--pc <host>]',
    notes: [
      '不带参数：读库里自己的段位快照（每天一条，`lol sync` 时写入）。',
      '带「名字#TAG」：实时打 LCU `/lol-ranked/v1/ranked-stats/{puuid}`，对任意 puuid 都有效（实测 2700 个全 200），需要客户端开着。',
      '实时查到的段位**不入库** —— 别人的段位混进自己的快照会污染曲线。',
      '一次只能查一个玩家，没有批量接口。',
    ],
    options: {
      pc: { type: 'string', description: 'PC 的 ssh 主机名', valueName: 'host' },
    },
    minArgs: 0,
    maxArgs: 1,
    run: async (ctx): Promise<CommandResult> => {
      const who = ctx.positionals[0]
      if (who) {
        const live = await fetchPlayerRank(who, {
          ...(typeof ctx.values.pc === 'string' ? { host: ctx.values.pc } : {}),
        })
        const fmt = (e: { tier?: string; division?: string; leaguePoints?: number; wins?: number; losses?: number } | null) => {
          if (!e?.tier) return null
          const div = e.division && e.division !== 'NA' ? ` ${e.division}` : ''
          return { tier: `${e.tier}${div}`, lp: Number(e.leaguePoints ?? 0), wins: Number(e.wins ?? 0), losses: Number(e.losses ?? 0) }
        }
        const solo = fmt(live.solo)
        const flex = fmt(live.flex)
        const rows: (string | number)[][] = []
        if (solo) rows.push(['单双', solo.tier, solo.lp, solo.wins, solo.losses])
        if (flex) rows.push(['灵活', flex.tier, flex.lp, flex.wins, flex.losses])
        if (rows.length === 0) rows.push(['单双', '未定级', 0, 0, 0])
        return {
          ...okResult({ player: live.name, puuid: live.puuid, solo, flex, source: 'lcu' }, []),
          table: {
            headers: ['队列', '段位', 'LP', '胜', '负'],
            rows,
          },
        }
      }
      const db = await openLolDb()
      try {
        const rows = await latestRanks(db.conn)
        const ranks = rows.map((r) => ({
          queue: String(r.queue),
          tier: r.tier ? `${String(r.tier)} ${String(r.division ?? '')}`.trim() : null,
          lp: Number(r.league_points ?? 0),
          wins: Number(r.wins ?? 0),
          losses: Number(r.losses ?? 0),
          date: fmtDate(r.snap_date) ?? '',
        }))
        return {
          ...okResult({ count: ranks.length, ranks }, []),
          table: {
            headers: ['队列', '段位', 'LP', '胜', '负', '日期'],
            rows: ranks.map((r) => [r.queue, r.tier ?? '-', r.lp, r.wins, r.losses, r.date]),
          },
        }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'lol player',
    summary: '查任意召唤师（名字#TAG）的最近对局',
    usage: 'astra lol player <名字#TAG> [--limit 20] [--pc <host>] [--table]',
    notes: [
      '必须写成「名字#TAG」：只给名字 LCU 会回 422 INVALID_EMPTY_REQUEST（实测）。',
      '对方隐藏战绩时返回 hidden=true、games=[]，**不是没打过**，别当成 0 场。',
      '这是实时读，不入库 —— 别人的战绩混进自己的统计会污染胜率。',
      '需要 PC 客户端在跑（同 `lol sync`）。',
    ],
    options: {
      limit: { type: 'string', description: '取多少局，默认 20（LCU 最多约 21）', valueName: 'n' },
      pc: { type: 'string', description: 'PC 的 ssh 主机名', valueName: 'host' },
    },
    minArgs: 1,
    maxArgs: 1,
    run: async (ctx): Promise<CommandResult> => {
      const who = ctx.positionals[0] ?? ''
      const limit = limitOf(ctx.values.limit, 20, 50)
      const snapshot = await fetchPlayerSnapshot(who, limit, {
        ...(typeof ctx.values.pc === 'string' ? { host: ctx.values.pc } : {}),
      })
      const db = await openLolDb()
      try {
        const champions = await championNameMap(db.conn, db.dialect.name)
        const matches = snapshot.games.map((summary) => {
          const info = summary.json ?? {}
          const parts = (info.participants ?? []) as Record<string, unknown>[]
          const me = parts.find((p) => p.puuid === snapshot.puuid) ?? parts[0] ?? {}
          const statsObj = (me.challenges ?? {}) as Record<string, unknown>
          return {
            gameId: Number(info.gameId ?? 0),
            date: fmtDate(info.gameCreation ? new Date(Number(info.gameCreation)) : null),
            queueId: Number(info.queueId ?? 0),
            champion: champions.get(Number(me.championId ?? 0)) ?? String(me.championId ?? ''),
            win: me.win === true,
            kda: `${Number(me.kills ?? 0)}/${Number(me.deaths ?? 0)}/${Number(me.assists ?? 0)}`,
            cs: Number(me.totalMinionsKilled ?? 0) + Number(me.neutralMinionsKilled ?? 0),
            damage: Number(me.totalDamageDealtToChampions ?? 0),
            minutes: minutes(Number(info.gameDuration ?? 0)),
            position: String(me.teamPosition ?? statsObj.teamPosition ?? ''),
          }
        }).sort((a, b) => Number(b.gameId) - Number(a.gameId)).slice(0, limit)
        const wins = matches.filter((m) => m.win).length
        const data = {
          // LCU 的 summoner 对象里没有 gameTag，显示名直接用用户传进来的「名字#TAG」
          name: who,
          puuid: snapshot.puuid || null,
          region: snapshot.region,
          source: 'sgp',
          hidden: false,
          games: matches.length,
          wins,
          winRate: matches.length ? Math.round((wins / matches.length) * 100) : 0,
          matches,
        }
        return {
          ...okResult(data, snapshot.missing > 0 ? [`有 ${snapshot.missing} 局取不到（上游 404，通常是老对局文件已归档）`] : []),
          table: {
            headers: ['时间', '英雄', '结果', 'KDA', '补刀', '伤害', '分钟'],
            rows: matches.map((m) => [m.date ?? '-', m.champion, m.win ? '胜' : '负', m.kda, m.cs, m.damage, m.minutes]),
          },
        }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'lol champions',
    summary: '同步英雄 id→中文名（Data Dragon）',
    usage: 'astra lol champions [--refresh]',
    notes: ['不联网也能看战绩；表空了才需要跑这个。'],
    options: {
      refresh: { type: 'boolean', description: '强制重新拉取（默认表非空就跳过）' },
    },
    run: async (ctx): Promise<CommandResult> => {
      const db = await openLolDb()
      try {
        const table = tableName(db.dialect.name, 'lol_champion')
        const existing = await db.conn.query<{ c: number }>(`select count(*) as c from ${table}`)
        const count = Number(existing[0]?.c ?? 0)
        if (count > 0 && ctx.values.refresh !== true) {
          return okResult({ champions: count, refreshed: false, version: null }, ['英雄表已存在，--refresh 才重新拉'])
        }
        const { version, rows } = await fetchChampions()
        const written = await storeChampions(db.conn, table, rows)
        return okResult({ champions: written, refreshed: true, version }, [])
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'lol doctor',
    summary: '自检：PC 可达 / 客户端在跑 / 库里有数据',
    usage: 'astra lol doctor',
    notes: ['排查「sync 没反应」先跑这个：能分清是 PC 不通、客户端没开，还是库空。'],
    run: async (): Promise<CommandResult> => {
      const host = pcHost()
      const checks: { name: string; ok: boolean; detail: string }[] = []
      checks.push({ name: 'pc 配置', ok: true, detail: `${host}（lol.pc=${getConfig('lol.pc') || '未设置，用默认 pc'}）` })

      let clientOk = false
      try {
        const snapshot = await fetchLcuSnapshot({ host })
        clientOk = true
        checks.push({ name: 'LCU', ok: true, detail: `${snapshot.summoner.gameName ?? '?'} · ${snapshot.games.length} 局` })
      } catch (err) {
        const code = err instanceof AstraError ? err.code : 'UNKNOWN'
        checks.push({ name: 'LCU', ok: false, detail: `${code}` })
      }

      const db = await openLolDb()
      try {
        const t = (n: string) => tableName(db.dialect.name, n)
        const games = await db.conn.query<{ c: number }>(`select count(*) as c from ${t('lol_match')}`)
        const champs = await db.conn.query<{ c: number }>(`select count(*) as c from ${t('lol_champion')}`)
        checks.push({ name: '数据库', ok: true, detail: `${db.dialect.label} · ${Number(games[0]?.c ?? 0)} 局 · ${Number(champs[0]?.c ?? 0)} 英雄` })
      } finally {
        await db.conn.close()
      }

      return okResult({ host, clientRunning: clientOk, checks, astra: ASTRA }, [])
    },
  },
]

/**
 * 英雄联盟域：LCU 原始 JSON → 库记录的转换、participant 选取、表名分区。
 * 不打真客户端（那要 PC 在线），只测纯函数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchPlayerSnapshot, myParticipant, type LcuGame } from '../src/lol/bridge.ts'
import { toMatchRow, tableName } from '../src/lol/db.ts'
import { commandGroup, groupCommands } from '../src/main.ts'

const PUUID = '87c61928-a300-5f37-98a4-acd69f25b2ca'

function game(overrides: Partial<LcuGame> = {}, stats: Record<string, number | boolean> = {}): LcuGame {
  return {
    gameId: 7_691_654_649_154_572_543,
    queueId: 420,
    gameMode: 'CLASSIC',
    gameType: 'MATCHED_GAME',
    gameVersion: '15.21.1.1',
    gameCreation: 1_763_000_000_000,
    gameDuration: 1_872,
    participants: [
      {
        championId: 235,
        timeline: { lane: 'MIDDLE', role: 'SOLO' },
        stats: {
          win: true, kills: 11, deaths: 2, assists: 9, champLevel: 16,
          totalMinionsKilled: 210, neutralMonstersKilled: 12,
          goldEarned: 13_500, totalDamageDealtToChampions: 27_800, visionScore: 24,
          doubleKills: 2, tripleKills: 0, quadraKills: 0, pentaKills: 0,
          item0: 3157, item1: 4645, item2: 3089, item3: 0, item4: 0, item5: 0, item6: 3340,
          ...stats,
        },
      },
    ],
    participantIdentities: [{ participantId: 1 }],
    ...overrides,
  }
}

test('lol 是命令组，且命令齐全', () => {
  assert.equal(commandGroup('lol'), true)
  const names = groupCommands('lol')
  for (const expected of ['lol sync', 'lol history', 'lol stats', 'lol rank', 'lol champions', 'lol doctor']) {
    assert.ok(names.includes(expected), `缺 ${expected}`)
  }
})

test('toMatchRow：常规对局字段映射正确', () => {
  const row = toMatchRow(game(), PUUID)
  assert.ok(row)
  assert.equal(row.gameId, 7_691_654_649_154_572_543)
  assert.equal(row.championId, 235)
  assert.equal(row.win, true)
  assert.equal(row.kills, 11)
  // 补刀 = minions + neutral
  assert.equal(row.cs, 222)
  assert.equal(row.damageChamp, 27_800)
  assert.equal(row.position, 'MIDDLE')
  assert.equal(row.durationSec, 1872)
  assert.deepEqual(row.items, [3157, 4645, 3089, 0, 0, 0, 3340])
  assert.equal(row.gameCreation, new Date(1_763_000_000_000).toISOString())
})

test('toMatchRow：没有 gameId 或没有 participants 的脏数据被丢掉', () => {
  assert.equal(toMatchRow(game({ gameId: 0 }), PUUID), null)
  assert.equal(toMatchRow(game({ participants: [] }), PUUID), null)
})

test('toMatchRow：缺 stats 的字段落 0，不写 null 到 not-null 列', () => {
  const row = toMatchRow(game({ participants: [{ championId: 235, stats: { kills: 3 } }] }), PUUID)
  assert.ok(row)
  assert.equal(row.kills, 3)
  assert.equal(row.deaths, 0)
  assert.equal(row.assists, 0)
  assert.equal(row.visionScore, 0)
  assert.equal(row.cs, 0)
  assert.equal(row.win, false)
  assert.deepEqual(row.items, [0, 0, 0, 0, 0, 0, 0])
})

test('toMatchRow：时长缺省时不炸', () => {
  const row = toMatchRow(game({ gameDuration: undefined }), PUUID)
  assert.ok(row)
  assert.equal(row.durationSec, null)
})

test('myParticipant：按 participantIdentities 匹配自己那一条', () => {
  const g = game({
    participants: [
      { championId: 1, stats: { kills: 0 } },
      { championId: 2, stats: { kills: 5 } },
    ],
    participantIdentities: [{ participantId: 2 }],
  })
  assert.equal(myParticipant(g)?.championId, 2)
})

test('myParticipant：身份缺失时回落第一条', () => {
  const g = game({ participants: [{ championId: 9, stats: {} }], participantIdentities: undefined })
  assert.equal(myParticipant(g)?.championId, 9)
})

test('tableName：PG 走 crawl schema，其它方言裸表名', () => {
  assert.equal(tableName('postgres', 'lol_match'), 'crawl.lol_match')
  assert.equal(tableName('sqlite', 'lol_match'), 'lol_match')
  assert.equal(tableName('mysql', 'lol_match'), 'lol_match')
})

test('lol player：名字里没有 #TAG 直接报错，不去碰 PC', async () => {
  await assert.rejects(
    () => fetchPlayerSnapshot('只有名字', 5),
    (err: Error & { code?: string }) => err.code === 'LOL_BAD_NAME',
  )
})

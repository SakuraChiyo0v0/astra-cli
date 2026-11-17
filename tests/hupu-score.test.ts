/**
 * 虎扑比赛/评分解析单测：只喂构造的响应，不走网络。
 * 字段名来自 hupuX 的 doc/api/match-score.md + 2026-11-17 实测抓包。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSchedule, parseScoreBoard, summarizeRounds, type RoundScore } from '../src/hupu/match.ts'

const SCHEDULE = {
  result: {
    anchorMatchId: '1537808050113478656',
    dayGameData: [
      {
        dayTime: '2026-11-16',
        dateBlock: '11月16日 周日',
        matchData: [
          {
            matchId: '1537808033030078464',
            matchStatus: 'COMPLETED',
            matchIntroduction: 'NBA常规赛',
            matchStartTimeStamp: '1763300000000',
            scoreCountText: '17.7万人评分',
            againstInfo: {
              memberInfos: [
                { memberName: '骑士', memberBaseScore: '112', memberId: '11' },
                { memberName: '雷霆', memberBaseScore: '117', memberId: '22' },
              ],
              winnerMemberId: '22',
            },
            scoreItemInfo: {
              name: '谢伊-吉尔杰斯-亚历山大',
              scoreNum: 9.7,
              scoreOutBizType: 'basketball_item',
              scoreOutBizNo: '238397',
            },
          },
        ],
      },
    ],
  },
}

test('parseSchedule：摊平赛程，比分/胜者/最高分都对', () => {
  const list = parseSchedule(SCHEDULE as unknown as Record<string, unknown>)
  assert.equal(list.length, 1)
  const m = list[0]!
  assert.equal(m.matchId, '1537808033030078464')
  assert.deepEqual(m.teams, ['骑士 112', '雷霆 117'])
  assert.equal(m.winner, '雷霆')
  assert.equal(m.scoreCountText, '17.7万人评分')
  assert.equal(m.topName, '谢伊-吉尔杰斯-亚历山大')
  assert.equal(m.topScore, 9.7)
  assert.equal(m.topItemNo, '238397')
  assert.equal(m.topItemType, 'basketball_item')
  assert.ok(m.startAt && m.startAt.length === 16, `startAt 应是 YYYY-MM-DD HH:mm，实际 ${m.startAt}`)
})

test('parseSchedule：空数据不抛错', () => {
  assert.deepEqual(parseSchedule({ result: { dayGameData: [] } }), [])
  assert.deepEqual(parseSchedule({}), [])
})

const BOARD = {
  data: {
    self: { node: { name: '骑士 112-117 雷霆' }, summedScorePersonCount: 123 },
    pageResult: {
      data: [
        {
          node: {
            name: '谢伊-吉尔杰斯-亚历山大',
            scoreAvg: 9.7,
            scorePersonCount: 68341,
            commentCount: 7942,
            scoreDistribution: { 10: 65496, 2: 1829, 8: 589 },
            hotCommentModels: [
              { commentUserName: '虎扑JR0433804420', commentContent: '合格的领袖', lightCount: 6417, score: 10 },
            ],
          },
        },
        { node: { name: '詹姆斯-哈登', scoreAvg: null, scorePersonCount: null } },
      ],
    },
  },
}

test('parseScoreBoard：标题/总人数/条目/热评/分布', () => {
  const board = parseScoreBoard(BOARD as unknown as Record<string, unknown>)
  assert.equal(board.title, '骑士 112-117 雷霆')
  assert.equal(board.peopleTotal, 123)
  assert.equal(board.items.length, 2)
  const a = board.items[0]!
  assert.equal(a.name, '谢伊-吉尔杰斯-亚历山大')
  assert.equal(a.avg, 9.7)
  assert.equal(a.people, 68341)
  assert.equal(a.comments, 7942)
  assert.equal(a.hotUser, '虎扑JR0433804420')
  assert.equal(a.hotText, '合格的领袖')
  assert.equal(a.hotLight, 6417)
  // 分布按分值升序
  assert.deepEqual(Object.keys(a.distribution ?? {}), ['2', '8', '10'])
  // 缺失字段保持 null，不编 0
  assert.equal(board.items[1]!.avg, null)
  assert.equal(board.items[1]!.people, null)
  assert.equal(board.items[1]!.hotText, null)
})

test('parseScoreBoard：没有 self 时用兜底标题', () => {
  const board = parseScoreBoard({ data: { pageResult: { data: [] } } }, '兜底')
  assert.equal(board.title, '兜底')
  assert.equal(board.peopleTotal, null)
  assert.deepEqual(board.items, [])
})

test('summarizeRounds：按人数加权 + 简单平均，两个口径都给', () => {
  const rounds: RoundScore[] = [
    { round: '第4局', avg: 10.0, people: 241256, comments: 17114, hotText: null, hotLight: null },
    { round: '第3局', avg: 10.0, people: 103800, comments: 5729, hotText: null, hotLight: null },
    { round: '第2局', avg: 9.9, people: 79102, comments: 2547, hotText: null, hotLight: null },
    { round: '第1局', avg: 8.2, people: 32071, comments: 3110, hotText: null, hotLight: null },
  ]
  const s = summarizeRounds(rounds)
  assert.equal(s.rounds, 4)
  assert.equal(s.totalPeople, 456229)
  // 人数加权（实测 Bin 决赛四局）
  assert.equal(s.weightedAvg, 9.86)
  // 每局等权，能看出「第一局被喷惨了」
  assert.equal(s.simpleAvg, 9.53)
})

test('summarizeRounds：空输入给 null，不编 0', () => {
  const s = summarizeRounds([])
  assert.equal(s.weightedAvg, null)
  assert.equal(s.simpleAvg, null)
  assert.equal(s.totalPeople, 0)
})

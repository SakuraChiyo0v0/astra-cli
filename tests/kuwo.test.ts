/**
 * 酷我同曲匹配。样本取自 2026-10-21 实测的酷我搜索结果（字段已裁剪）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bareKuwoTitle, matchKuwo, type KuwoHit } from '../src/music/kuwo.ts'
import type { Track } from '../src/music/netease.ts'

const track = (over: Partial<Track>): Track => ({
  id: '1', title: '', artists: [], album: null, albumId: null, durationMs: null, coverUrl: null,
  aliases: [], translations: [], trackNo: null, discNo: null, publishTime: null, popularity: null, fee: null, ...over,
})

const idolHits: KuwoHit[] = [
  { rid: '268650423', title: 'アイドル-《【我推的孩子】》TV动画片头曲|第1话片尾曲', artists: ['YOASOBI'], album: 'アイドル', durationSec: 213 },
  { rid: '304289188', title: 'アイドル (230922 MCD)', artists: ['YOASOBI'], album: null, durationSec: 471 },
  { rid: '331124170', title: 'アイドル (Live)', artists: ['YOASOBI'], album: '第74回 NHK 紅白歌合戦', durationSec: 70 },
]

const bedHits: KuwoHit[] = [
  // 实测 Live 版是 220 秒；这里改成 226 秒，专门验证"时长碰巧接近时靠版本标记拦住"
  { rid: '80456315', title: '床边故事 (Live)', artists: ['周杰伦'], album: '周杰伦地表最强世界巡回演唱会', durationSec: 226 },
  { rid: '7119717', title: '床边故事', artists: ['周杰伦'], album: '周杰伦的床边故事', durationSec: 225 },
]

test('去掉酷我歌名附注', () => {
  assert.equal(bareKuwoTitle('アイドル-《【我推的孩子】》TV动画片头曲|第1话片尾曲'), 'アイドル')
  assert.equal(bareKuwoTitle('床边故事 (Live)'), '床边故事')
})

test('同名同歌手同时长 → 匹配；Live / 时长不符 → 跳过', () => {
  const idol = track({ title: 'アイドル', artists: ['YOASOBI'], durationMs: 213233 })
  assert.equal(matchKuwo(idol, idolHits)?.rid, '268650423')
  // Live 排在前面、时长只差 1 秒，仍要跳过它选录音室版
  const bed = track({ title: '床边故事', artists: ['周杰伦'], durationMs: 225000 })
  assert.equal(matchKuwo(bed, bedHits)?.rid, '7119717')
})

test('歌手对不上不匹配（不拿翻唱冒充）', () => {
  const t = track({ title: '床边故事', artists: ['某翻唱'], durationMs: 225000 })
  assert.equal(matchKuwo(t, bedHits), null)
})

test('时长差太多不匹配（剪辑版 / 加长版）', () => {
  const t = track({ title: 'アイドル', artists: ['YOASOBI'], durationMs: 90_000 })
  assert.equal(matchKuwo(t, idolHits), null)
})

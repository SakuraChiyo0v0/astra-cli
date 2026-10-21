/**
 * 跨 id 去重指纹。
 *
 * 起因：曲库原来只按 platform + native_id 去重。同一首歌换个 id 出现
 * （重发版、不同专辑、单曲与精选）会被当成新歌再下一遍并覆盖同名文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trackFingerprint } from '../src/music/library.ts'

test('同一首歌的常见变化都归到同一指纹', () => {
  const base = trackFingerprint('アイドル', ['YOASOBI'], 213_233)
  // 时长差一两秒（不同来源的常态）
  assert.equal(trackFingerprint('アイドル', ['YOASOBI'], 212_500), base)
  assert.equal(trackFingerprint('アイドル', ['YOASOBI'], 213_900), base)
  // 大小写、全半角、空格
  assert.equal(trackFingerprint('ＩＤＯＬ'.toLowerCase(), ['YOASOBI'], 213_233), trackFingerprint('idol', ['YOASOBI'], 213_233))
  // 括号附注（"原唱:xxx"、"TV size"）不影响
  assert.equal(trackFingerprint('アイドル (TV Size)', ['YOASOBI'], 213_233), base)
  // 多歌手顺序不影响
  assert.equal(trackFingerprint('歌', ['A', 'B'], 200_000), trackFingerprint('歌', ['B', 'A'], 200_000))
})

test('不是同一首歌的不会被合并', () => {
  const base = trackFingerprint('晴天', ['周杰伦'], 269_000)
  assert.notEqual(trackFingerprint('晴天', ['RyaVocal'], 271_000), base, '翻唱歌手不同')
  assert.notEqual(trackFingerprint('晴天', ['周杰伦'], 112_000), base, '时长差太多（片段）')
  assert.notEqual(trackFingerprint('江南', ['周杰伦'], 269_000), base, '歌名不同')
})

test('5 秒分桶：差一两秒落在同一桶，跨桶则视为不同', () => {
  const bucket = (sec: number): string => trackFingerprint('歌', ['A'], sec * 1000)
  // 同一桶内（248.4s 与 249.9s 都属于 245–250 这一桶）
  assert.equal(bucket(248.4), bucket(249.9))
  // 跨桶（244.9 与 250.1 分属两桶）—— 这是有意接受的代价：宁可偶尔漏判，也不要把不同版本合并
  assert.notEqual(bucket(244.9), bucket(250.1))
})

test('指纹算法变更后旧值必须重算（记录这个坑）', () => {
  // 老实现是"取整到秒"，同一首歌得到 |248；新实现是 5 秒分桶，得到 |49。
  // 两者不可能相等 —— 所以升级时必须 `backfillFingerprints(true)` 全量重写，
  // 只补 null 会让旧记录永远匹配不上。
  assert.equal(trackFingerprint('群青', ['YOASOBI'], 248_444), '群青|yoasobi|49')
  assert.notEqual(trackFingerprint('群青', ['YOASOBI'], 248_444), '群青|yoasobi|248')
})

test('时长缺失时仍能按标题+歌手匹配', () => {
  assert.equal(trackFingerprint('歌', ['A'], null), trackFingerprint('歌', ['A'], 0))
  // 但缺失不会和"有确定时长"的混在一起 —— 这是有意的保守
  assert.notEqual(trackFingerprint('歌', ['A'], null), trackFingerprint('歌', ['A'], 200_000))
})

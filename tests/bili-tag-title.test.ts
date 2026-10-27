/**
 * TIT2 的取值规则：撞名时才带上文件名里的版本标记。
 *
 * 事故背景：库里 19 组 / 39 个文件「不同 bvid、同名 TIT2」——
 * `清姬.mp3`(BV1959VBZEJB) 和 `清姬（DJ）.mp3`(BV1Vk9jBTEzU) 在播放器里
 * 显示成两条一模一样的记录，看着像重复下载。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tagTitleFor } from '../src/bili/download.ts'
import type { VideoInfo } from '../src/bili/api.ts'

function info(title: string): VideoInfo {
  return {
    bvid: 'BV1Vk9jBTEzU',
    aid: 1,
    title,
    desc: '',
    owner: { mid: 1, name: '东洋雪莲' },
    duration: 200,
    pic: null,
    pubdate: 1711670400,
    pages: [{ page: 1, part: '清姬', cid: 1, duration: 200 }],
  }
}

test('文件名就是歌名：TIT2 用歌名', () => {
  const i = info('清姬/AI東 雪蓮')
  assert.equal(tagTitleFor(i, { page: 1, part: '清姬' }, '/m/东洋雪莲/清姬.mp3'), '清姬')
})

test('文件名带短版本标记：TIT2 跟着文件名走', () => {
  const i = info('清姬（DJ版）/AI東 雪蓮')
  assert.equal(
    tagTitleFor(i, { page: 1, part: '清姬' }, '/m/东洋雪莲/清姬（DJ）.mp3'),
    '清姬（DJ）',
  )
})

test('日语填词版也带得出来', () => {
  const i = info('苦茶子（日语填词）/AI東 雪蓮')
  assert.equal(
    tagTitleFor(i, { page: 1, part: '苦茶子' }, '/m/东洋雪莲/苦茶子（日语填词）.mp3'),
    '苦茶子（日语填词）',
  )
})

test('用户手工削过的短名（不以歌名开头）：保持歌名', () => {
  const i = info('伯虎说（“明月万年无前身，照见古今独醒人”《伯虎说》/AI東 雪蓮')
  assert.equal(tagTitleFor(i, { page: 1, part: '伯虎说' }, '/m/东洋雪莲/伯虎说.mp3'), '伯虎说')
})

test('修饰超过 14 字：宁可撞名也不写一长串', () => {
  const long = '七月七日晴（“七月七日晴，忽然下起了大雪”《七月七日晴》）'
  const i = info(`${long}/AI東 雪蓮`)
  assert.equal(tagTitleFor(i, { page: 1, part: '七月七日晴' }, `/m/东洋雪莲/${long}.mp3`), '七月七日晴')
})

test('文件名与歌名毫无关系：保持歌名', () => {
  const i = info('难却（“待上浓妆好戏开场”《难却》/AI東 雪蓮')
  assert.equal(tagTitleFor(i, { page: 1, part: '难却' }, '/m/东洋雪莲/难却.mp3'), '难却')
})

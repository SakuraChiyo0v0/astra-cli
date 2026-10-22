/**
 * 同名消歧（P0#2e）。
 *
 * 真实事故：给 o叔 的 322 个作品批量下音频，`{title}` 抽出来的歌名大量重复
 * （水星记 ×4、原神 ×6…），**319 首只落地 280 首，丢了 39 首**，`failed: 0`。
 * 后面的文件直接覆盖了前面的，调用方毫无察觉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTargetPath, type Occupancy } from '../src/bili/download.ts'

const free = (): Occupancy => ({ state: 'free' })
const taken = (bvid: string | null = null): Occupancy => ({ state: 'taken', bvid })
const same = (bvid: string): Occupancy => ({ state: 'same', bvid })

const BV = { bvid: 'BV1GEn26uEDT' }

test('目标空着：直接用，不改名', () => {
  const r = resolveTargetPath('/m/绿色DJ.mp3', BV, { part: '绿色' }, free)
  assert.deepEqual(r, { target: '/m/绿色DJ.mp3', renamedFrom: null, reason: null })
})

test('同一个 bvid 重下：覆盖自己，不算冲突', () => {
  const probe = (p: string): Occupancy => (p === '/m/绿色DJ.mp3' ? same('BV1GEn26uEDT') : free())
  const r = resolveTargetPath('/m/绿色DJ.mp3', BV, { part: '绿色' }, probe)
  assert.equal(r.renamedFrom, null, '重复下载是预期行为，不该改名')
  assert.equal(r.target, '/m/绿色DJ.mp3')
})

test('别的视频占了名字：用分 P 名消歧（优先级 1）', () => {
  const probe = (p: string): Occupancy => (p === '/m/绿色DJ.mp3' ? taken('BV1DIFFERENT') : free())
  const r = resolveTargetPath('/m/绿色DJ.mp3', BV, { part: '纯享版' }, probe)
  assert.equal(r.target, '/m/绿色DJ（纯享版）.mp3')
  assert.equal(r.reason, 'part')
  assert.equal(r.renamedFrom, '/m/绿色DJ.mp3', '要如实报告原名，调用方才知道发生了什么')
})

test('分 P 名也被占：退回 bvid（优先级 2）', () => {
  const probe = (p: string): Occupancy =>
    p === '/m/绿色DJ.mp3' || p === '/m/绿色DJ（纯享版）.mp3' ? taken('BV1DIFFERENT') : free()
  const r = resolveTargetPath('/m/绿色DJ.mp3', BV, { part: '纯享版' }, probe)
  assert.equal(r.target, '/m/绿色DJ（BV1GEn26uEDT）.mp3')
  assert.equal(r.reason, 'bvid')
})

test('分 P 名为空时跳过第一优先级，直接 bvid', () => {
  const probe = (p: string): Occupancy => (p === '/m/绿色DJ.mp3' ? taken() : free())
  const r = resolveTargetPath('/m/绿色DJ.mp3', BV, { part: '' }, probe)
  assert.equal(r.target, '/m/绿色DJ（BV1GEn26uEDT）.mp3')
  assert.equal(r.reason, 'bvid')
})

test('bvid 也被占：用序号（优先级 3）', () => {
  const probe = (p: string): Occupancy =>
    ['/m/绿色DJ.mp3', '/m/绿色DJ（BV1GEn26uEDT）.mp3'].includes(p) ? taken('x') : free()
  const r = resolveTargetPath('/m/绿色DJ.mp3', BV, { part: '' }, probe)
  assert.equal(r.target, '/m/绿色DJ（2）.mp3')
  assert.equal(r.reason, 'seq')
})

test('扩展名保留在最后，不会被塞进括号前面', () => {
  const probe = (p: string): Occupancy => (p.endsWith('绿色DJ.mp3') ? taken() : free())
  const r = resolveTargetPath('/m/绿色DJ.mp3', BV, { part: '纯享版' }, probe)
  assert.match(r.target, /\.mp3$/, '必须是 .mp3 结尾')
  assert.equal(r.target, '/m/绿色DJ（纯享版）.mp3')
})

test('路径里有多个点也能正确切出扩展名', () => {
  const probe = (p: string): Occupancy => (p === '/m/a.b.c.mp3' ? taken() : free())
  const r = resolveTargetPath('/m/a.b.c.mp3', BV, { part: 'P2' }, probe)
  assert.equal(r.target, '/m/a.b.c（P2）.mp3')
})

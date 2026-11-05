import assert from 'node:assert/strict'
import test from 'node:test'
import { bitrateForTarget, heightLadder } from '../src/media/shrink.ts'
import { emptyStore, pickDevice, mapPath, resolveDevice } from '../src/device/store.ts'
import type { Device } from '../src/device/types.ts'

function dev(over: Partial<Device>): Device {
  return { name: 'x', kind: 'local', caps: ['ffmpeg'], addedAt: 'now', ...over }
}

test('bitrateForTarget 按时长算码率，留 8% 余量并扣音轨', () => {
  // 106 秒、目标 28MB → 约 2065 kbps 预算，扣 96k 音轨
  const kbps = bitrateForTarget(28, 106)
  assert.ok(kbps > 1700 && kbps < 2100, `got ${kbps}`)
  // 时长为 0 时不炸，给最小值
  assert.equal(bitrateForTarget(28, 0), 1500)
  // 长视频码率被压低
  assert.ok(bitrateForTarget(28, 3600) < 200)
})

test('heightLadder 从源高度往下退，不超过 1080，也不低于 240', () => {
  assert.deepEqual(heightLadder(2160), [1080, 720, 480])
  assert.deepEqual(heightLadder(720), [720, 480])
  assert.deepEqual(heightLadder(null), [1080, 720, 480])
  assert.deepEqual(heightLadder(1080, 720), [720, 480])
})

test('pickDevice 先筛能力，再筛在线/忙，最后按倍率排序', () => {
  const store = emptyStore()
  store.devices = {
    nas: dev({ name: 'nas', speed: 1.4 }),
    pc: dev({ name: 'pc', kind: 'ssh', host: 'pc', speed: 6.2 }),
    gpu: dev({ name: 'gpu', caps: ['ffmpeg', 'gpu'], speed: 9 }),
  }
  assert.equal(pickDevice(store, { requires: ['ffmpeg'] })?.name, 'gpu')
  assert.equal(pickDevice(store, { requires: ['ffmpeg'], busy: { gpu: true, pc: true } })?.name, 'nas')
  assert.equal(pickDevice(store, { requires: ['ffmpeg'], online: { gpu: false, pc: false } })?.name, 'nas')
  assert.equal(pickDevice(store, { requires: ['nvenc'] }), null)
})

test('mapPath 按前缀把 NAS 路径翻成设备路径', () => {
  const d = dev({ name: 'pc', kind: 'ssh', pathMap: [{ from: '/host-root/volume1/', to: 'Z:\\' }] })
  assert.equal(mapPath(d, '/host-root/volume1/视频/a.mp4'), 'Z:\\视频/a.mp4')
  assert.equal(mapPath(d, '/tmp/x.mp4'), '/tmp/x.mp4')
})

test('resolveDevice 拒绝 auto，未知设备报错', () => {
  const store = emptyStore()
  assert.throws(() => resolveDevice(store, 'auto'), /auto/)
  assert.throws(() => resolveDevice(store, 'nope'), /没有这个设备/)
})

/**
 * "取最优"的排序规则。用实测出现过的真实组合当样本：
 * - アイドル 官方 96kHz/24bit 3230kbps
 * - 光年之外 官方 44.1kHz/16bit 887kbps
 * - 起风了 官方 44.1kHz/16bit 2832kbps ← 码率比上面高，但规格更低
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { better } from '../src/music/resolve.ts'
import type { Probe } from '../src/music/audio.ts'

const flac = (sampleRate: number, bits: number, bps: number): Probe => ({
  format: 'flac',
  bytes: Math.round((bps * 200) / 8),
  bps,
  quality: bits > 16 || sampleRate > 48000 ? '24bit' : 'flac',
  flac: { sampleRate, channels: 2, bitsPerSample: bits, totalSamples: sampleRate * 200 },
  embedded: null,
  problem: null,
})

const mp3 = (bps: number): Probe => ({
  format: 'mp3',
  bytes: Math.round((bps * 200) / 8),
  bps,
  quality: bps >= 250_000 ? '320k' : '128k',
  flac: null,
  embedded: null,
  problem: null,
})

test('带宽更高的一律优先', () => {
  assert.equal(better(mp3(320_000), mp3(128_000)), true)
  assert.equal(better(mp3(128_000), mp3(320_000)), false)
})

test('无损压过任何有损', () => {
  assert.equal(better(flac(44100, 16, 887_000), mp3(320_000)), true)
  assert.equal(better(mp3(320_000), flac(44100, 16, 887_000)), false)
})

test('同为 24bit 档位时比采样率：96k 压过 48k，哪怕后者码率更高', () => {
  const hires = flac(96_000, 24, 3_230_000)
  const pcm48 = flac(48_000, 24, 4_000_000)
  assert.equal(better(hires, pcm48), true)
  assert.equal(better(pcm48, hires), false)
})

test('同为标准无损档位时比采样率：48k/16 压过 44.1k/16', () => {
  assert.equal(better(flac(48_000, 16, 800_000), flac(44_100, 16, 1_200_000)), true)
})

test('采样率相同才比位深：同为 24bit 档位、同为 48k 时，24bit 压过 16bit', () => {
  // 两个都得是 24bit 档位（flac() 里位深 >16 就是 24bit），否则会被档位那条先拦下、测不到位深规则
  const deep = flac(48_000, 24, 1_000_000)
  const shallow: Probe = { ...flac(48_000, 24, 1_500_000), flac: { sampleRate: 48_000, channels: 2, bitsPerSample: 16, totalSamples: 48_000 * 200 } }
  assert.equal(better(deep, shallow), true)
  assert.equal(better(shallow, deep), false)
})

test('规格相同才比码率', () => {
  assert.equal(better(flac(44_100, 16, 1_000_000), flac(44_100, 16, 900_000)), true)
  assert.equal(better(flac(44_100, 16, 900_000), flac(44_100, 16, 1_000_000)), false)
})

test('同档位、同码率、同规格时格式兜底优先 flac', () => {
  const a: Probe = { ...mp3(320_000), format: 'flac' }
  assert.equal(better(a, mp3(320_000)), true)
})

test('没有对比对象时永远是它', () => {
  assert.equal(better(mp3(128_000), undefined), true)
})

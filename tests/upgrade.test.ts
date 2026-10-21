/**
 * 音质升级的判定规则。
 *
 * 核心区别：**低规格 ≠ 能升级**。
 * 实测一份曲库里 12 首"低于 24bit"，逐首问官方后发现没有一首真能升 ——
 * 它们本来就是 16bit 母带。所以判定必须基于"现在能拿到什么"，不是"库里是什么"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Quality } from '../src/music/audio.ts'
import { isUpgrade as realIsUpgrade } from '../src/music/upgrade.ts'

/** 把测试里的简写映射到产品函数，确保测的是真代码。 */
const isUpgrade = (
  current: { quality: Quality; sampleRate: number | null; bits: number | null; bps: number | null },
  available: { quality: Quality; sampleRate: number | null; bits: number | null; bps: number | null },
): boolean =>
  realIsUpgrade(
    { quality: current.quality, sampleRate: current.sampleRate, bitsPerSample: current.bits, bps: current.bps },
    { quality: available.quality, sampleRate: available.sampleRate, bitsPerSample: available.bits, bps: available.bps },
  )

test('档位更高就算能升', () => {
  assert.equal(
    isUpgrade({ quality: '128k', sampleRate: 44100, bits: 16, bps: 128_000 }, { quality: '24bit', sampleRate: 96000, bits: 24, bps: 3_230_000 }),
    true,
  )
  assert.equal(
    isUpgrade({ quality: '320k', sampleRate: null, bits: null, bps: 320_000 }, { quality: 'flac', sampleRate: 44100, bits: 16, bps: 880_000 }),
    true,
  )
})

test('同档位但规格更好也算', () => {
  // 44.1k/16 → 96k/24，都是 flac 档的 24bit 判定之外的情况
  assert.equal(
    isUpgrade({ quality: 'flac', sampleRate: 44100, bits: 16, bps: 800_000 }, { quality: 'flac', sampleRate: 48000, bits: 16, bps: 800_000 }),
    true,
  )
  assert.equal(
    isUpgrade({ quality: 'flac', sampleRate: 44100, bits: 16, bps: 800_000 }, { quality: 'flac', sampleRate: 44100, bits: 24, bps: 800_000 }),
    true,
  )
})

test('同档位同规格：码率要明显更高（>10%）才算', () => {
  const base = { quality: 'flac' as Quality, sampleRate: 44100, bits: 16 }
  assert.equal(isUpgrade({ ...base, bps: 800_000 }, { ...base, bps: 900_000 }), true, '高 12% 算')
  assert.equal(isUpgrade({ ...base, bps: 800_000 }, { ...base, bps: 820_000 }), false, '高 2.5% 不算（编码抖动）')
})

test('什么都没变就不算 —— 这正是"低规格但升不了"的常见情况', () => {
  // 库里是 44.1k/16 的 flac，官方也只能给 44.1k/16
  assert.equal(
    isUpgrade({ quality: 'flac', sampleRate: 44100, bits: 16, bps: 887_000 }, { quality: 'flac', sampleRate: 44100, bits: 16, bps: 887_000 }),
    false,
  )
})

test('官方给得更差时不算（不会把好文件换成差的）', () => {
  assert.equal(
    isUpgrade({ quality: '24bit', sampleRate: 96000, bits: 24, bps: 3_200_000 }, { quality: 'flac', sampleRate: 44100, bits: 16, bps: 880_000 }),
    false,
  )
})

test('缺失字段时保守判断：不因为"不知道"就认定能升', () => {
  assert.equal(isUpgrade({ quality: 'flac', sampleRate: null, bits: null, bps: null }, { quality: 'flac', sampleRate: null, bits: null, bps: null }), false)
})

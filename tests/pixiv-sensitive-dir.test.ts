/**
 * 敏感作品的落盘分流。
 *
 * 口径必须和「能不能发到普通群」一致（xRestrict>0 或 sl>=4），
 * 否则会出现「存在公开目录、但只敢发到限制群」这种自相矛盾的状态。
 * 这里不碰网络，只测判定逻辑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'astra-sens-'))
process.env.ASTRA_HOME = home

const { sensitiveDirFor } = await import('../src/pixiv/commands.ts')
const { setConfig } = await import('../src/core/config.ts')

const NORMAL = '/lib/pixiv'
const SENS = '/private/pixiv'

test('没配 sensitive-dir 时不分流', () => {
  assert.equal(sensitiveDirFor({ xRestrict: 1, sl: 6 }, NORMAL), NORMAL)
  assert.equal(sensitiveDirFor({ xRestrict: 0, sl: 2 }, NORMAL), NORMAL)
})

test('配了之后：R-18 与 sl>=4 都进敏感目录', () => {
  setConfig('pixiv.sensitive-dir', SENS)
  assert.equal(sensitiveDirFor({ xRestrict: 1, sl: 6 }, NORMAL), SENS)
  assert.equal(sensitiveDirFor({ xRestrict: 0, sl: 6 }, NORMAL), SENS, '作者没勾 R-18 但 pixiv 判敏感')
  assert.equal(sensitiveDirFor({ xRestrict: 0, sl: 4 }, NORMAL), SENS)
})

test('一般的（sl=2）仍进常规目录', () => {
  setConfig('pixiv.sensitive-dir', SENS)
  assert.equal(sensitiveDirFor({ xRestrict: 0, sl: 2 }, NORMAL), NORMAL)
})

test('--out 显式指定时优先，不再分流', () => {
  setConfig('pixiv.sensitive-dir', SENS)
  assert.equal(sensitiveDirFor({ xRestrict: 1, sl: 6 }, '/tmp/whatever', true), '/tmp/whatever')
})

test('清理', () => {
  rmSync(home, { recursive: true, force: true })
})

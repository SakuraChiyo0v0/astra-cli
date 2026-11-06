/**
 * scope 匹配：通配只能命中下一段，不能顺着层级无限放行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchScope, scopeOf } from '../src/core/auth.ts'

test('命令名 → scope', () => {
  assert.equal(scopeOf('bili get'), 'bili.get')
  assert.equal(scopeOf('x media'), 'x.media')
  assert.equal(scopeOf('music job cancel'), 'music.job.cancel')
})

test('精确与全通', () => {
  assert.equal(matchScope('bili.get', 'bili.get'), true)
  assert.equal(matchScope('bili.get', 'bili.search'), false)
  assert.equal(matchScope('*', 'anything.at.all'), true)
})

test('bili.* 只匹配下一段，不命中更深层', () => {
  assert.equal(matchScope('bili.*', 'bili.get'), true)
  assert.equal(matchScope('bili.*', 'bili.job.cancel'), false, '深层命令不能被 bili.* 放行')
  assert.equal(matchScope('bili.*', 'biliother.get'), false, '前缀必须整段匹配')
  assert.equal(matchScope('bili.*', 'x.get'), false)
})

test('多段模式的通配同样只到下一段', () => {
  assert.equal(matchScope('music.job.*', 'music.job.cancel'), true)
  assert.equal(matchScope('music.job.*', 'music.job.cancel.force'), false)
})

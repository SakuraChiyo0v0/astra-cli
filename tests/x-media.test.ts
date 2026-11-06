/**
 * media 目标解析：账号 / @账号 / 推文链接 / 裸 id / 搜索链接。
 *
 * 踩过的坑：裸推文 id 被当成账号名，拼出 `x.com/2118…/media`，
 * gallery-dl 回 "Requested user could not be found"——看着像登录问题，其实是参数解析。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTarget, safeName } from '../src/x/media.ts'

test('账号 → 该号媒体页', () => {
  assert.deepEqual(resolveTarget('ArknightsStaff'), {
    url: 'https://x.com/ArknightsStaff/media',
    dirName: 'ArknightsStaff',
  })
  assert.deepEqual(resolveTarget('@ArknightsStaff'), {
    url: 'https://x.com/ArknightsStaff/media',
    dirName: 'ArknightsStaff',
  })
})

test('推文链接与裸 id 都指到同一条，目录用 tweet_<id>', () => {
  const id = '2118552452572348566'
  assert.deepEqual(resolveTarget(`https://x.com/monad1412565/status/${id}`), {
    url: `https://x.com/monad1412565/status/${id}`,
    dirName: `tweet_${id}`,
  })
  assert.deepEqual(resolveTarget(id), {
    url: `https://x.com/i/status/${id}`,
    dirName: `tweet_${id}`,
  })
})

test('搜索链接落 search 目录', () => {
  const url = 'https://x.com/search?q=abc&f=media'
  assert.deepEqual(resolveTarget(url), { url, dirName: 'search' })
})

test('目录名安全化：只留 ASCII 可见字符', () => {
  assert.equal(safeName('a b/c*d'), 'a_b_c_d')
  assert.equal(safeName('绝区零'), 'x')
})

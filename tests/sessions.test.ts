/**
 * 统一登录视图与清理。
 *
 * 重点是"坏会话"的识别：文件在但读不出来（空文件、权限过宽、格式坏了）要能报出来，
 * 因为这是"明明登录过却一直提示未登录"的常见原因。
 */
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, chmodSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let sessions: typeof import('../src/core/sessions.ts')

before(async () => {
  process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-sess-'))
  process.env.ASTRA_MUSIC_DIR = path.join(process.env.ASTRA_HOME!, 'music')
  sessions = await import('../src/core/sessions.ts')
})

beforeEach(() => {
  // 每个用例从干净状态开始
  for (const f of ['netease-session.json', 'bili-session.json', 'vr-session.json']) {
    const p = path.join(process.env.ASTRA_HOME!, f)
    if (existsSync(p)) rmSync(p, { force: true })
  }
})

const home = (f: string) => path.join(process.env.ASTRA_HOME!, f)

test('三个域都会出现在统一视图里', () => {
  const list = sessions.allSessions()
  assert.deepEqual(list.map((s) => s.domain), ['netease', 'bili', 'vrchat'])
  assert.ok(list.every((s) => s.state === 'not_logged_in'))
  assert.ok(list.every((s) => s.howToLogin.length > 0), '每个域都要告诉用户怎么登录')
})

test('空文件被识别成 stale_file，而不是"未登录"', () => {
  writeFileSync(home('bili-session.json'), '')
  const view = sessions.biliSessionView()
  assert.equal(view.state, 'stale_file')
  assert.match(view.fileIssue ?? '', /空的/)
})

test('权限过宽被识别出来', { skip: process.platform === 'win32' ? 'Windows 没有 POSIX 权限位' : false }, () => {
  writeFileSync(home('netease-session.json'), '{}')
  chmodSync(home('netease-session.json'), 0o644)
  const view = sessions.neteaseSessionView()
  assert.equal(view.state, 'stale_file')
  assert.match(view.fileIssue ?? '', /权限过于宽松/)
})

test('VRChat 有会话文件时能读出账号', () => {
  writeFileSync(home('vr-session.json'), JSON.stringify({ cookie: 'auth=abc', userId: 'usr_1', displayName: 'Ame', savedAt: '2026-01-01' }))
  const view = sessions.vrSessionView()
  assert.equal(view.state, 'logged_in')
  assert.equal(view.account, 'Ame')
  assert.match(view.digest ?? '', /^[0-9a-f]{10}$/, '指纹是 10 位，不泄露内容')
})

test('清理指定域只删那一个', () => {
  writeFileSync(home('netease-session.json'), JSON.stringify({ cookie: 'MUSIC_U=x', userId: '1', nickname: 'n', savedAt: '' }))
  writeFileSync(home('vr-session.json'), JSON.stringify({ cookie: 'auth=abc', userId: 'u', displayName: 'd', savedAt: '' }))
  const result = sessions.clearSessions(['netease'])
  assert.deepEqual(result.cleared, ['netease'])
  assert.equal(existsSync(home('netease-session.json')), false)
  assert.equal(existsSync(home('vr-session.json')), true, '没点名的域不能被删')
})

test('清理全部三个域', () => {
  for (const f of ['netease-session.json', 'bili-session.json', 'vr-session.json']) writeFileSync(home(f), '{}')
  const result = sessions.clearSessions()
  assert.deepEqual(result.cleared.sort(), ['bili', 'netease', 'vrchat'])
  for (const f of ['netease-session.json', 'bili-session.json', 'vr-session.json']) {
    assert.equal(existsSync(home(f)), false, `${f} 应该被删掉`)
  }
})

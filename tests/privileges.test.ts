/**
 * root 启动时降权：只在 POSIX + root + ASTRA_HOME 属主不是 root 时切，顺序是 groups → gid → uid。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dropRootPrivileges } from '../src/core/privileges.ts'

function fakeProc(opts: { uid: number; platform?: string; env?: Record<string, string>; failSetuid?: boolean }) {
  const calls: string[] = []
  let uid = opts.uid
  return {
    calls,
    proc: {
      platform: opts.platform ?? 'linux',
      env: opts.env ?? {},
      getuid: () => uid,
      setgroups: (g: number[]) => { calls.push(`groups:${g.join(',')}`) },
      setgid: (id: number) => { calls.push(`gid:${id}`) },
      setuid: (id: number) => {
        if (opts.failSetuid) throw new Error('EPERM')
        calls.push(`uid:${id}`)
        uid = id
      },
    },
  }
}

const owner = (uid: number, gid: number) => () => ({ uid, gid })

test('root + 属主是普通用户：切过去，先组后 uid', () => {
  const { proc, calls } = fakeProc({ uid: 0 })
  const r = dropRootPrivileges('/h', proc, owner(1000, 10))
  assert.deepEqual(r, { dropped: true, uid: 1000, gid: 10 })
  assert.deepEqual(calls, ['groups:10', 'gid:10', 'uid:1000'])
})

test('不是 root：什么都不做', () => {
  const { proc, calls } = fakeProc({ uid: 1000 })
  assert.equal(dropRootPrivileges('/h', proc, owner(1000, 10)).reason, 'not-root')
  assert.deepEqual(calls, [])
})

test('ASTRA_HOME 属主就是 root：不切（本机 root 部署）', () => {
  const { proc, calls } = fakeProc({ uid: 0 })
  assert.equal(dropRootPrivileges('/h', proc, owner(0, 0)).reason, 'home-owned-by-root')
  assert.deepEqual(calls, [])
})

test('ASTRA_KEEP_ROOT=1：保留 root', () => {
  const { proc, calls } = fakeProc({ uid: 0, env: { ASTRA_KEEP_ROOT: '1' } })
  assert.equal(dropRootPrivileges('/h', proc, owner(1000, 10)).reason, 'keep-root')
  assert.deepEqual(calls, [])
})

test('Windows：不切', () => {
  const { proc } = fakeProc({ uid: 0, platform: 'win32' })
  assert.equal(dropRootPrivileges('/h', proc, owner(1000, 10)).reason, 'not-posix')
})

test('ASTRA_HOME 读不到 / setuid 失败：不抛错，照原样继续', () => {
  const { proc } = fakeProc({ uid: 0 })
  assert.equal(dropRootPrivileges('/h', proc, () => { throw new Error('ENOENT') }).reason, 'home-missing')
  const failing = fakeProc({ uid: 0, failSetuid: true })
  assert.equal(dropRootPrivileges('/h', failing.proc, owner(1000, 10)).reason, 'setuid-failed')
})

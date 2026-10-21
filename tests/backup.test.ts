/**
 * 曲库备份与恢复。
 *
 * 重点是 restore 的危险性：它会覆盖当前曲库。所以验四件事：
 * - 有任务在跑时拒绝恢复
 * - 恢复前把当前库改名保留（不做不可逆的事）
 * - 备份里没数据库时明确报错，而不是悄悄"恢复成功"
 * - 保留份数上限生效
 */
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let backupMod: typeof import('../src/core/backup.ts')
let dbMod: typeof import('../src/core/db.ts')
let jobsMod: typeof import('../src/core/jobs.ts')

before(async () => {
  process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-bkm-'))
  process.env.ASTRA_MUSIC_DIR = path.join(process.env.ASTRA_HOME!, 'music')
  backupMod = await import('../src/core/backup.ts')
  dbMod = await import('../src/core/db.ts')
  jobsMod = await import('../src/core/jobs.ts')
})

beforeEach(() => {
  // 每个用例前清掉备份目录，避免互相干扰
  const dir = path.join(process.env.ASTRA_HOME!, 'backups')
  if (existsSync(dir)) {
    for (const n of readdirSync(dir)) rmSync(path.join(dir, n), { recursive: true, force: true })
  }
})

test('没下载过东西时只有会话，明确标 hasDatabase=false', () => {
  writeFileSync(path.join(process.env.ASTRA_HOME!, 'netease-session.json'), JSON.stringify({ cookie: 'MUSIC_U=x', userId: '1', nickname: 'n', savedAt: '' }))
  const r = backupMod.backup()
  assert.equal(r.hasDatabase, false)
  assert.equal(r.sessionCount, 1)
  assert.ok(r.files.some((f) => f.name === 'netease-session.json'))
})

test('备份会话文件权限是 600（里面有 cookie）', { skip: process.platform === 'win32' ? 'Windows 没有 POSIX 权限位' : false }, () => {
  writeFileSync(path.join(process.env.ASTRA_HOME!, 'bili-session.json'), JSON.stringify({ cookie: 'SESSDATA=x', uid: '1', nickname: null, vip: false, savedAt: '' }))
  const r = backupMod.backup()
  const mode = statSync(path.join(r.dir, 'bili-session.json')).mode & 0o777
  assert.equal(mode, 0o600)
})

test('有数据库时用 VACUUM INTO 备份（快照一致）', () => {
  // 触发建表
  dbMod.db()
  jobsMod.createJob({ domain: 'music', kind: 'x', title: '备份测试', items: [{ id: 'a', title: 't' }] })
  const r = backupMod.backup()
  // astra.db 由 db() 懒创建；这里有写入就一定有
  assert.equal(r.hasDatabase, true)
  assert.ok(r.files.some((f) => f.name === 'astra.db'))
})

test('保留份数上限生效', () => {
  for (let i = 0; i < 4; i += 1) backupMod.backup(undefined, { keep: 2 })
  const list = backupMod.listBackups()
  assert.ok(list.length <= 2, `实际 ${list.length} 份`)
})

test('恢复：有任务在跑时拒绝，不动数据', () => {
  jobsMod.createJob({ domain: 'music', kind: 'x', title: '跑着的', items: [{ id: 'b', title: 't' }] })
  const r = backupMod.backup()
  // 伪造一个 running 状态
  dbMod.db().prepare("update jobs set status = 'running', pid = ? where title = '跑着的'").run(process.pid)
  assert.throws(() => backupMod.restore(r.dir), /还有 1 个任务在跑/)
})

test('恢复：备份里没有数据库时明确报错', () => {
  const emptyDir = mkdtempSync(path.join(tmpdir(), 'astra-empty-'))
  assert.throws(() => backupMod.restore(emptyDir), /备份里没有 astra.db/)
})

test('恢复：先把当前库改名保留，再做覆盖', () => {
  dbMod.db().prepare("update jobs set status = 'done'").run()
  const r = backupMod.backup()
  const result = backupMod.restore(r.dir)
  assert.ok(result.previousKept !== null, '原库必须被保留，不能不可逆覆盖')
  assert.ok(existsSync(result.previousKept!), '保留的文件要真的存在')
  assert.equal(result.restored, path.join(process.env.ASTRA_HOME!, 'astra.db'))
})

/**
 * 并发迁移：两个进程同时在一个**全新**的 ASTRA_HOME 上启动时，迁移必须都成功。
 *
 * 回归的 bug（实测于 NAS）：
 *   `music get album:… & bili get BV… &` 同时起，第二个进程直接
 *   `INTERNAL: duplicate column name: channels`。
 *   原因是版本号在事务外读，两边都读到 0，第二个拿到写锁后照样执行同一条
 *   `alter table tracks add column channels`。
 *
 * 修法：整个迁移序列放进一个 `begin immediate`，拿到写锁后**重读**版本号。
 * 这个用例只验证"并发不炸 + 版本号最终一致"，不碰业务表。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const dbModule = path.join(here, '..', 'src', 'core', 'db.ts')

/** 起一个子进程：在给定 home 上打开 db（触发迁移），完成后退出。 */
function migrateOnce(home: string, script: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script, home], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

test('两个进程同时在新库上迁移：都不报错，版本号只前进一次', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'astra-migrate-race-'))
  const script = path.join(home, 'migrate.mjs')
  writeFileSync(
    script,
    [
      `process.env.ASTRA_HOME = process.argv[2]`,
      `process.env.ASTRA_MUSIC_DIR = process.argv[2] + '/music'`,
      `const { db } = await import(${JSON.stringify(dbModule)})`,
      `db()`,
      `process.exit(0)`,
    ].join('\n'),
  )
  try {
    // 同时起 4 个：撞上的概率足够高，且能顺带验证不是"刚好错开"
    const results = await Promise.all([0, 1, 2, 3].map(() => migrateOnce(home, script)))
    for (const r of results) {
      assert.equal(r.code, 0, `子进程应正常退出，stderr: ${r.stderr}`)
      assert.doesNotMatch(r.stderr, /duplicate column|database is locked/i)
    }

    // 版本号必须是"迁移条数"，而不是被某个进程写成更小的值
    const { db } = await import('../src/core/db.ts')
    const version = (db().prepare('pragma user_version').get() as { user_version: number }).user_version
    const migrations = await import('../src/core/db.ts').then((m) => (m as unknown as { MIGRATIONS?: unknown[] }).MIGRATIONS)
    if (Array.isArray(migrations)) assert.equal(version, migrations.length)
    else assert.ok(version > 0, 'user_version 应已推进')

    // 表结构确实建好了（不是"事务回滚了但没报错"）
    const tables = db().prepare("select name from sqlite_master where type='table'").all() as { name: string }[]
    const names = tables.map((t) => t.name)
    for (const t of ['tracks', 'jobs', 'job_items', 'subscriptions', 'audit_log']) {
      assert.ok(names.includes(t), `缺表 ${t}`)
    }
    const cols = (db().prepare('pragma table_info(tracks)').all() as { name: string }[]).map((c) => c.name)
    assert.ok(cols.includes('album_type'), 'tracks 应已加上 album_type（最后一次迁移）')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

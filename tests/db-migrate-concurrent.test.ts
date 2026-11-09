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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const stateModule = path.join(here, '..', 'src', 'core', 'state.ts')

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
      // 必须用 file URL：Windows 上裸的 C:\… 路径会被当成 URL scheme
      `const { state, closeState } = await import(${JSON.stringify(pathToFileURL(stateModule).href)})`,
      `await state()`,
      `await closeState()`,
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
    const { SQLITE_LADDER } = await import('../src/core/db/state-schema.ts')
    const check = new DatabaseSync(path.join(home, 'astra.db'), { readOnly: true })
    const version = (check.prepare('pragma user_version').get() as { user_version: number }).user_version
    assert.equal(version, SQLITE_LADDER.length)

    // 表结构确实建好了（不是"事务回滚了但没报错"）
    const tables = check.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]
    const names = tables.map((t) => t.name)
    for (const t of ['tracks', 'jobs', 'job_items', 'subscriptions', 'audit_log']) {
      assert.ok(names.includes(t), `缺表 ${t}`)
    }
    const cols = (check.prepare('pragma table_info(tracks)').all() as { name: string }[]).map((c) => c.name)
    assert.ok(cols.includes('album_type'), 'tracks 应已加上 album_type')
    const subCols = (check.prepare('pragma table_info(subscriptions)').all() as { name: string }[]).map((c) => c.name)
    assert.ok(subCols.includes('options'), 'subscriptions 应已加上 options（阶梯最后一级）')
    check.close()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

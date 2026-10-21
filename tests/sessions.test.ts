/**
 * 登录状态的统一视图。
 *
 * 重点验"文件坏了"这条路 —— 会话 JSON 存在但读不出来时，
 * 用户看到的不该是"未登录"（那会让他去重新扫码，而问题其实是权限）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * 每个用例换一个 ASTRA_HOME，避免污染真实状态。
 *
 * 必须是 async 版本并 await 回调 —— 之前写成同步 fn，
 * finally 在 await 完成前就把目录删了，测试全绿得莫名其妙。
 */
async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), 'astra-sess-'))
  const prev = process.env.ASTRA_HOME
  process.env.ASTRA_HOME = home
  try {
    await fn(home)
  } finally {
    if (prev === undefined) delete process.env.ASTRA_HOME
    else process.env.ASTRA_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

test('没有会话文件：not_logged_in，并给出登录方式', async () => {
  await withHome(async () => {
    const { allSessions } = await import('../src/core/sessions.ts')
    const sessions = allSessions()
    for (const s of sessions) {
      assert.equal(s.state, 'not_logged_in')
      assert.ok(s.howToLogin.length > 0, `${s.domain} 应当给出登录方式`)
      assert.equal(s.fileIssue, null)
    }
  })
})

test('空文件：报 stale_file 而不是 not_logged_in', async () => {
  await withHome(async (home) => {
    writeFileSync(path.join(home, 'bili-session.json'), '')
    const { biliSessionView } = await import('../src/core/sessions.ts')
    const view = biliSessionView()
    assert.equal(view.state, 'stale_file', '文件坏了要说文件坏了，不能只说未登录')
    assert.match(view.fileIssue ?? '', /空/)
  })
})

test('权限过宽：一并报出来', async () => {
  await withHome(async (home) => {
    const file = path.join(home, 'bili-session.json')
    writeFileSync(file, '{}')
    chmodSync(file, 0o644)
    const { biliSessionView } = await import('../src/core/sessions.ts')
    const view = biliSessionView()
    // Windows 上 chmod 基本无效，只在类 Unix 上断言权限提示
    if (process.platform !== 'win32') {
      assert.equal(view.state, 'stale_file')
      assert.match(view.fileIssue ?? '', /权限/)
    } else {
      assert.equal(view.state, 'stale_file', '至少要判成坏文件')
    }
  })
})

test('两个域都会出现在汇总里', async () => {
  await withHome(async () => {
    const { allSessions } = await import('../src/core/sessions.ts')
    const domains = allSessions().map((s) => s.domain).sort()
    assert.deepEqual(domains, ['bili', 'netease'])
  })
})

test('读不出来的文件（非法 JSON）也能给出说明而不是抛异常', async () => {
  await withHome(async (home) => {
    writeFileSync(path.join(home, 'netease-session.json'), 'not json at all')
    const { neteaseSessionView } = await import('../src/core/sessions.ts')
    const view = neteaseSessionView() // 不应抛
    assert.equal(view.state, 'stale_file')
  })
})

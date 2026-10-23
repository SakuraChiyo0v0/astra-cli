/**
 * 挂时长这一块的纯逻辑测试：游戏名解析、状态文件、后台进程生死判断、命令参数校验。
 *
 * 不碰网络：Steam 登录/连接 CM 的行为只能真机验，这里只测「不联网也一定会错」的地方。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const home = mkdtempSync(path.join(tmpdir(), 'astra-steam-test-'))
process.env.ASTRA_HOME = home

const { pickGames } = await import('../src/steam/games.ts')
const { clearState, initState, pidAlive, readState, writeState } = await import('../src/steam/runtime.ts')
const { steamCommands } = await import('../src/steam/commands.ts')
const { parseCommandArgs } = await import('../src/core/command.ts')

const owned = [
  { appId: 438100, name: 'VRChat', minutes: 62444 },
  { appId: 620, name: 'Portal 2', minutes: 120 },
  { appId: 730, name: 'Counter-Strike 2', minutes: 0 },
  { appId: 2358720, name: 'Black Myth: Wukong', minutes: 30 },
]

test('pickGames: 完全同名优先，忽略大小写', () => {
  assert.deepEqual(pickGames(owned, ['vrchat']).map((g) => g.appId), [438100])
  assert.deepEqual(pickGames(owned, ['PORTAL 2']).map((g) => g.appId), [620])
})

test('pickGames: 纯数字当 AppID', () => {
  assert.deepEqual(pickGames(owned, ['730']).map((g) => g.name), ['Counter-Strike 2'])
})

test('pickGames: 包含匹配，多个词按顺序累加并去重', () => {
  assert.deepEqual(pickGames(owned, ['wukong', 'VRChat', '438100']).map((g) => g.appId), [2358720, 438100])
})

test('pickGames: 匹配到多个要报错并列出候选，不能猜', () => {
  const ambiguous = [...owned, { appId: 1, name: 'Portal 2 Soundtrack', minutes: 0 }]
  assert.throws(
    () => pickGames(ambiguous, ['portal']),
    (err: Error & { code?: string }) => err.code === 'STEAM_GAME_AMBIGUOUS' && /Portal 2、Portal 2 Soundtrack/.test(err.message),
  )
})

test('pickGames: 找不到 / 空输入都要报错', () => {
  assert.throws(() => pickGames(owned, ['不存在的游戏']), /没找到名字包含/)
  assert.throws(() => pickGames(owned, ['123456789']), /库里没有 AppID/)
  assert.throws(() => pickGames(owned, []), /没有要挂的游戏/)
})

test('状态文件：写入合并、更新 updatedAt、权限 600', () => {
  clearState('idle')
  assert.equal(readState('idle'), null)

  initState('idle', {
    pid: 0,
    appIDs: [438100],
    games: ['VRChat'],
    status: 'starting',
    connectedAt: null,
    startedAt: new Date().toISOString(),
    reconnects: 0,
    error: null,
    proxy: null,
  })
  const started = readState('idle')!
  assert.equal(started.status, 'starting')

  writeState('idle', { pid: 4242, status: 'online', connectedAt: '2026-10-23T00:00:00.000Z' })
  const online = readState('idle')!
  assert.equal(online.status, 'online')
  assert.equal(online.pid, 4242)
  // 合并写不能丢字段
  assert.deepEqual(online.appIDs, [438100])
  assert.equal(online.games[0], 'VRChat')
  // 600：只有属主能读写
  assert.equal(statSync(path.join(home, 'steam-idle.json')).mode & 0o777, 0o600)

  clearState('idle')
  assert.equal(readState('idle'), null)
})

test('pidAlive: 自己活着，明显不存在的 pid 死', () => {
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(0), false)
  assert.equal(pidAlive(-1), false)
  assert.equal(pidAlive(999_999), false)
})

test('命令登记：挂时长/登录命令都在，worker 是隐藏的', () => {
  const names = steamCommands.map((c) => c.name)
  for (const name of ['steam login', 'steam login status', 'steam login cancel', 'steam idle start', 'steam idle status', 'steam idle stop', 'steam library']) {
    assert.ok(names.includes(name), `缺少命令 ${name}`)
  }
  const hidden = steamCommands.filter((c) => c.hidden).map((c) => c.name)
  assert.deepEqual(hidden.sort(), ['steam _idle-worker', 'steam _login-worker'])
})

test('命令参数：idle start 至少要一个游戏，未知选项要报错', () => {
  const start = steamCommands.find((c) => c.name === 'steam idle start')!
  assert.throws(() => parseCommandArgs(start, []), /缺少参数/)
  assert.throws(() => parseCommandArgs(start, ['VRChat', '--nope']), /Unknown option/)
  const parsed = parseCommandArgs(start, ['VRChat', 'Portal 2'])
  assert.deepEqual(parsed.positionals, ['VRChat', 'Portal 2'])
})

test('密码登录：--password-stdin 必须带 --user，且在读密码之前就报错', async () => {
  const login = steamCommands.find((c) => c.name === 'steam login')!
  assert.ok(login.options?.['password-stdin'], '要有 --password-stdin 选项')
  assert.ok(login.options?.user, '要有 --user 选项')
  const controller = new AbortController()
  await assert.rejects(
    () => login.run({ positionals: [], values: { 'password-stdin': true }, signal: controller.signal }),
    (err: Error & { code?: string }) => err.code === 'INVALID_INPUT' && /--user/.test(err.message),
  )
})

test.after(() => rmSync(home, { recursive: true, force: true }))

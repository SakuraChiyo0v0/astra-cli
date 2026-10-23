/**
 * `astra steam login` 与 `astra steam idle`：扫码登录 + 挂时长。
 *
 * 为什么是「起分离进程 + 状态文件」而不是一条命令跑到底：
 * Steam 的「正在玩」是**客户端会话状态**，进程一退就掉线。所以挂时长必须是常驻
 * 进程；命令本身立刻返回，之后靠 `steam idle status` 查状态、`steam idle stop` 收掉。
 *
 * 登录同理：二维码要等人扫，命令不能干等两分钟，于是 worker 拿着二维码在后台等，
 * 父进程把二维码 PNG 的路径返回给调用方（Hermes 直接发图给用户扫）。
 */
import { AstraError, invalidInput } from '../core/errors.ts'
import type { Command } from '../core/command.ts'
import { ownedGames } from './api.ts'
import { loadSteamCredentials, refreshTokenDigest, requireApiKey, requireRefreshToken, requireSteamId, saveSteamCredentials } from './auth.ts'
import { pickGames } from './games.ts'
import {
  clearState,
  initState,
  logPath,
  pidAlive,
  readState,
  spawnDetached,
  terminate,
  waitForState,
  writeState,
  type IdleState,
  type LoginState,
} from './runtime.ts'
import { homePath } from '../core/paths.ts'
import { rmSync, writeFileSync } from 'node:fs'

/**
 * 「用户主动关掉」的标记文件。
 *
 * 探活定时任务会看到它就不再自动补挂 —— 否则用户 `steam down` 之后十分钟又被拉起来，
 * 会以为见了鬼。`steam up` / `idle start` 会把这个标记删掉。
 */
function offMarker(): string {
  return homePath('steam-idle.off')
}

function setOffMarker(on: boolean): void {
  const file = offMarker()
  if (on) {
    try {
      writeFileSync(file, new Date().toISOString() + '\n', 'utf8')
    } catch {
      // 写不了就算了，不影响主流程
    }
  } else {
    try {
      rmSync(file, { force: true })
    } catch {
      // 同上
    }
  }
}

/** 单账号同时「在玩」的上限，Steam 自己限制 32。 */
const MAX_IDLE_GAMES = 32

function seconds(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}


// ---------- 终端输入（密码/验证码） ----------

/**
 * 从终端读一行，**不回显**（用于密码）。
 *
 * 只走 stdin，绝不进 argv：argv 会出现在 `ps` 和 shell 历史里。
 * 不是 TTY（管道喂进来）时退回普通读一行。
 */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    const { createInterface } = await import('node:readline')
    const rl = createInterface({ input: stdin })
    const line = await new Promise<string>((resolve) => rl.once('line', resolve))
    rl.close()
    return line.trim()
  }
  process.stderr.write(prompt)
  return await new Promise<string>((resolve) => {
    stdin.resume()
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    let buffer = ''
    const finish = (value: string): void => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      process.stderr.write('\n')
      resolve(value)
    }
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(buffer)
        if (ch === '\u0003') { // Ctrl-C
          finish('')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') { buffer = buffer.slice(0, -1); continue }
        buffer += ch
      }
    }
    stdin.on('data', onData)
  })
}

/** 读一行普通文本（验证码），会回显。 */
async function readPlain(prompt: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(prompt)
    return answer.trim()
  } finally {
    rl.close()
  }
}

// ---------- 登录 ----------


/**
 * 账号密码登录（`--password-stdin`）。
 *
 * 为什么单独一条前台路径：密码必须由**人**在终端敲，不能经过 argv、不能经过 AI。
 * 只有 refreshToken 落盘，密码用完就丢，不写任何文件。
 */
async function passwordLogin(values: Record<string, unknown>, signal: AbortSignal): Promise<{ data: unknown; warnings?: string[] }> {
  const accountName = typeof values.user === 'string' ? values.user.trim() : ''
  if (!accountName) throw invalidInput('--password-stdin 需要同时给 --user <账号名>', 'astra steam login --user mincal0 --password-stdin')

  const { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } = await import('steam-session')
  const { proxyConfig } = await import('../core/proxy.ts')

  const password = await readSecret('Steam 密码（不回显，不存盘）: ')
  if (!password) throw invalidInput('没读到密码', '重新运行，粘贴密码后回车')

  const proxy = proxyConfig()
  const session = new LoginSession(EAuthTokenPlatformType.SteamClient, proxy?.url ? { httpProxy: proxy.url } : {})
  session.loginTimeout = 180_000

  session.on('remoteInteraction', () => {
    process.stderr.write('手机上弹出了确认提示，请在 Steam App 里点「批准」\n')
  })

  const authenticated = new Promise<void>((resolve, reject) => {
    session.on('authenticated', () => resolve())
    session.on('timeout', () => reject(new AstraError('STEAM_LOGIN_TIMEOUT', '登录超时（3 分钟）', { exitCode: 5, retryable: true })))
    session.on('error', (err: Error) => reject(new AstraError('STEAM_LOGIN_FAILED', err.message, { exitCode: 5 })))
  })
  const abort = (): void => { void session.cancelLoginAttempt() }
  signal.addEventListener('abort', abort, { once: true })

  try {
    const started = await session.startWithCredentials({ accountName, password })
    if (started.actionRequired) {
      const actions = started.validActions ?? []
      const codeGuard = actions.find((a) => a.type === EAuthSessionGuardType.EmailCode || a.type === EAuthSessionGuardType.DeviceCode)
      if (codeGuard) {
        const where = codeGuard.detail ? `（${codeGuard.detail}）` : ''
        const code = await readPlain(`Steam Guard 验证码${where}: `)
        await session.submitSteamGuardCode(code)
      } else {
        process.stderr.write('这次登录需要在手机 Steam App 或邮箱里点确认，点完会自动继续\n')
      }
    }
    await authenticated
  } finally {
    signal.removeEventListener('abort', abort)
  }

  const existing = loadSteamCredentials()
  const steamId64 = session.steamID?.getSteamID64() ?? existing?.steamId64 ?? null
  saveSteamCredentials({
    steamId64,
    apiKey: existing?.apiKey ?? null,
    refreshToken: session.refreshToken,
    accountName: session.accountName ?? accountName,
  })

  return {
    data: {
      status: 'done',
      accountName: session.accountName ?? accountName,
      steamId64,
      hasRefreshToken: true,
      refreshTokenDigest: refreshTokenDigest(session.refreshToken),
    },
    warnings: steamId64 ? [] : ['没拿到 SteamID64，用游戏名挂时长前先 `astra steam auth set-user <id>`'],
  }
}

const loginWorker: Command = {
  name: 'steam _login-worker',
  summary: '内部：拿二维码等人扫，成功后落 refreshToken',
  usage: 'astra steam _login-worker',
  hidden: true,
  maxArgs: 0,
  async run() {
    const { LoginSession, EAuthTokenPlatformType } = await import('steam-session')
    const { writeQrPng } = await import('../core/qr.ts')
    const { proxyConfig } = await import('../core/proxy.ts')

    initState('login', {
      pid: process.pid,
      status: 'starting',
      qrPng: null,
      qrContent: null,
      accountName: null,
      error: null,
      expiresAt: null,
      startedAt: new Date().toISOString(),
    })

    const proxy = proxyConfig()
    const session = new LoginSession(EAuthTokenPlatformType.SteamClient, proxy?.url ? { httpProxy: proxy.url } : {})
    // 二维码有效期：默认 10 分钟，够慢慢扫；可用 --timeout 调整（父进程通过环境变量传进来）
    const loginTimeoutMs = Number(process.env.ASTRA_STEAM_LOGIN_TIMEOUT ?? '') || 600_000
    session.loginTimeout = loginTimeoutMs

    const done = new Promise<void>((resolve) => {
      session.on('authenticated', () => {
        try {
          const existing = loadSteamCredentials()
          saveSteamCredentials({
            steamId64: session.steamID?.getSteamID64() ?? existing?.steamId64 ?? null,
            apiKey: existing?.apiKey ?? null,
            refreshToken: session.refreshToken,
            accountName: session.accountName ?? null,
          })
          writeState('login', { status: 'done', accountName: session.accountName ?? null, qrContent: null })
        } catch (err) {
          writeState('login', { status: 'failed', error: (err as Error).message })
        }
        resolve()
      })
      session.on('timeout', () => {
        writeState('login', { status: 'failed', error: '二维码过期了，重新 astra steam login' })
        resolve()
      })
      session.on('error', (err: Error) => {
        writeState('login', { status: 'failed', error: err.message })
        resolve()
      })
    })

    const start = await session.startWithQR()
    if (!start.qrChallengeUrl) {
      writeState('login', { status: 'failed', error: 'Steam 没返回二维码内容' })
      return { data: { status: 'failed' } }
    }
    const png = writeQrPng(start.qrChallengeUrl, homePath('steam-qr.png'))
    writeState('login', {
      status: 'waiting_scan',
      qrPng: png.path,
      qrContent: png.content,
      expiresAt: new Date(Date.now() + loginTimeoutMs).toISOString(),
    })

    // 等扫码结果；进程退出时 Steam 会话自然失效
    await done
    return { data: { status: readState('login')?.status ?? 'failed' } }
  },
}

const login: Command = {
  name: 'steam login',
  summary: '扫码登录 Steam（拿到 refreshToken，之后挂时长不用再登）',
  usage: 'astra steam login [账号名] [--wait 20] [--timeout 600] [--force]',
  notes: [
    '`astra steam login <账号名>`：直接走账号密码登录，密码从终端读（不回显、不进 argv、不落盘）',
    '`astra steam login`：不给账号名就走扫码，返回 qrPng + qrContent',
    '只存 refreshToken 到 <ASTRA_HOME>/steam-credentials.json（600），不存密码',
    '扫码有效期默认 10 分钟（--timeout 可调）；--force 打断上一次没扫的登录重来',
  ],
  options: {
    wait: { type: 'string', description: '等二维码生成最多几秒，默认 20', valueName: 's' },
    timeout: { type: 'string', description: '二维码有效期（秒），默认 600', valueName: 's' },
    force: { type: 'boolean', description: '打断上一次还没扫的登录' },
    user: { type: 'string', description: '账号名（配合 --password-stdin）', valueName: 'name' },
    'password-stdin': { type: 'boolean', description: '从终端读密码（不回显、不进 argv），需要 --user' },
  },
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    // 给了账号名（位置参数或 --user）就走密码登录，否则走扫码
    const account = (positionals[0] ?? (typeof values.user === 'string' ? values.user : '')).trim()
    if (account || values['password-stdin'] === true) {
      return await passwordLogin({ ...values, user: account }, signal)
    }

    const waitMs = seconds(values.wait, 20, 3, 60) * 1000
    const existing = readState('login')

    if (existing && pidAlive(existing.pid) && existing.status === 'waiting_scan' && values.force !== true) {
      return {
        data: {
          status: 'waiting_scan',
          reused: true,
          qrPng: existing.qrPng,
          qrContent: existing.qrContent,
          next: '扫码后跑 astra steam login status',
        },
        warnings: ['上一次登录还在等扫码，直接沿用；要重来加 --force'],
      }
    }
    if (existing && pidAlive(existing.pid)) await terminate(existing.pid)
    clearState('login')

    const loginTimeoutMs = seconds(values.timeout, 600, 30, 1800) * 1000
    const pid = spawnDetached(['steam', '_login-worker'], 'steam-login', {
      ASTRA_STEAM_LOGIN_TIMEOUT: String(loginTimeoutMs),
    })
    const state = await waitForState<LoginState>('login', (s) => Boolean(s?.qrContent) || s?.status === 'failed', waitMs)

    if (!state || state.status === 'failed' || !state.qrContent) {
      throw new AstraError('STEAM_LOGIN_FAILED', state?.error ?? '二维码没生成出来', {
        exitCode: 5,
        hint: `看日志：${logPath('steam-login')}`,
        retryable: true,
      })
    }

    return {
      data: {
        status: 'waiting_scan',
        pid,
        qrPng: state.qrPng,
        qrContent: state.qrContent,
        accountName: null,
        expiresAt: state.expiresAt,
        expiresInSeconds: state.expiresAt ? Math.max(0, Math.round((Date.parse(state.expiresAt) - Date.now()) / 1000)) : null,
        next: '扫码后跑 astra steam login status',
      },
    }
  },
}

const loginStatus: Command = {
  name: 'steam login status',
  summary: '看扫码登录的结果（done / waiting_scan / failed）',
  usage: 'astra steam login status',
  notes: ['status=done 表示 refreshToken 已落盘，可以挂时长了'],
  maxArgs: 0,
  async run() {
    const state = readState('login')
    const saved = loadSteamCredentials()
    // 有 refreshToken 就是登录着的 —— 哪怕上一次扫码记录是 cancelled/failed（比如后来用密码登录的）
    if (saved?.refreshToken && (!state || state.status === 'cancelled' || state.status === 'failed')) {
      return {
        data: {
          status: 'done',
          accountName: saved.accountName ?? null,
          hasRefreshToken: true,
          refreshTokenDigest: refreshTokenDigest(saved.refreshToken),
          steamId64: saved.steamId64 ?? null,
        },
      }
    }
    if (!state) return { data: { status: 'not_started', hint: '`astra steam login <账号>` 登录' } }

    if (state.status === 'waiting_scan' && !pidAlive(state.pid)) {
      writeState('login', { status: 'failed', error: '登录进程已退出（二维码过期或被取消）' })
    }
    const current = readState('login')!

    if (current.status === 'done') {
      const credentials = loadSteamCredentials()
      return {
        data: {
          status: 'done',
          accountName: current.accountName ?? credentials?.accountName ?? null,
          hasRefreshToken: Boolean(credentials?.refreshToken),
          refreshTokenDigest: credentials?.refreshToken ? refreshTokenDigest(credentials.refreshToken) : null,
          steamId64: credentials?.steamId64 ?? null,
        },
        warnings: credentials?.steamId64 ? [] : ['还没有默认 SteamID64；用游戏名挂时长前先 `astra steam auth set-user <id>`'],
      }
    }

    if (current.status === 'failed') {
      return {
        data: { status: 'failed', error: current.error },
        warnings: ['重新 `astra steam login` 生成新二维码'],
      }
    }

    return {
      data: {
        status: current.status,
        pid: current.pid,
        qrPng: current.qrPng,
        qrContent: current.qrContent,
        expiresAt: current.expiresAt,
        expiresInSeconds: current.expiresAt ? Math.max(0, Math.round((Date.parse(current.expiresAt) - Date.now()) / 1000)) : null,
        waitingSeconds: Math.round((Date.now() - Date.parse(current.startedAt)) / 1000),
      },
    }
  },
}

const loginCancel: Command = {
  name: 'steam login cancel',
  summary: '取消正在等的扫码登录',
  usage: 'astra steam login cancel',
  maxArgs: 0,
  async run() {
    const state = readState('login')
    if (!state) return { data: { cancelled: false, reason: '没有进行中的登录' } }
    const killed = await terminate(state.pid)
    writeState('login', { status: 'cancelled', qrContent: null })
    return { data: { cancelled: true, pidKilled: killed } }
  },
}

// ---------- 挂时长 ----------

const idleWorker: Command = {
  name: 'steam _idle-worker',
  summary: '内部：常驻保持 Steam 在线并在玩指定游戏',
  usage: 'astra steam _idle-worker',
  hidden: true,
  maxArgs: 0,
  async run() {
    const state = readState('idle')
    if (!state || state.appIDs.length === 0) throw new AstraError('STEAM_IDLE_NO_STATE', '没有挂时长任务', { exitCode: 4 })

    const token = requireRefreshToken(loadSteamCredentials())
    const { default: SteamUser } = await import('steam-user')

    const client = new SteamUser({
      autoRelogin: true,
      ...(state.proxy ? { httpProxy: state.proxy } : {}),
    })

    let reconnects = state.reconnects
    writeState('idle', { pid: process.pid, status: 'starting' })

    client.on('loggedOn', () => {
      client.setPersona(SteamUser.EPersonaState.Online)
      client.gamesPlayed(state.appIDs)
      writeState('idle', { status: 'online', connectedAt: new Date().toISOString(), error: null })
    })

    client.on('error', (err) => {
      writeState('idle', { status: 'failed', error: err.message })
      process.exit(1)
    })

    client.on('disconnected', (_eresult, message) => {
      reconnects += 1
      writeState('idle', { status: 'starting', reconnects, error: message ?? '连接断开，正在重连' })
    })

    // 心跳：让 status 能看出「进程活着但在重连」和「进程早就没了」
    const heartbeat = setInterval(() => writeState('idle', {}), 30_000)

    let stopping = false
    const shutdown = () => {
      if (stopping) return
      stopping = true
      clearInterval(heartbeat)
      try {
        client.gamesPlayed([])
        client.logOff()
      } catch {
        // 已经断了
      }
      writeState('idle', { status: 'stopped', connectedAt: null })
      setTimeout(() => process.exit(0), 300)
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)

    client.logOn({ refreshToken: token })

    // 一直挂着，直到收到信号
    await new Promise<void>(() => {})
    return { data: { status: 'stopped' } }
  },
}

const idleStart: Command = {
  name: 'steam idle start',
  summary: '挂时长：常驻在线并在玩指定游戏（按名字或 AppID）',
  usage: 'astra steam idle start <游戏...> [--wait 30] [--proxy http://mihomo:7890] [--force]',
  notes: [
    '游戏名要能在你的库里对上（用 `astra steam library` 看名字）；纯数字当 AppID 直接挂',
    '命令会等「真的上线」再返回（默认最多 30 秒），超时会返回 status=starting，用 `steam idle status` 跟',
    '进程常驻；同一账号在别处登录会把这边踢下线（ASF 也会），所以两边不能同时用',
    '单账号最多同时挂 32 个游戏（Steam 限制）',
  ],
  options: {
    wait: { type: 'string', description: '等上线最多几秒，默认 30', valueName: 's' },
    proxy: { type: 'string', description: '走 HTTP 代理，如 http://mihomo:7890；默认直连 CM', valueName: 'url' },
    force: { type: 'boolean', description: '已经在挂就重启它' },
  },
  minArgs: 1,
  async run({ positionals, values, signal }) {
    const credentials = loadSteamCredentials()
    requireRefreshToken(credentials)

    const existing = readState('idle')
    if (existing && pidAlive(existing.pid) && existing.status !== 'stopped' && values.force !== true) {
      throw new AstraError('STEAM_IDLE_RUNNING', `已经在挂 ${existing.games.join('、') || existing.appIDs.join(',')}`, {
        exitCode: 2,
        hint: '先 `astra steam idle stop`，或加 --force 重启',
      })
    }
    if (existing && pidAlive(existing.pid)) await terminate(existing.pid)

    let picked: { appId: number; name: string }[]
    if (positionals.every((token) => /^\d+$/.test(token))) {
      picked = positionals.map((token) => ({ appId: Number(token), name: `App ${token}` }))
    } else {
      const apiKey = requireApiKey(credentials)
      const steamId64 = requireSteamId(credentials)
      const owned = await ownedGames(apiKey, steamId64, signal)
      picked = pickGames(owned, positionals).map((game) => ({ appId: game.appId, name: game.name }))
    }

    if (picked.length > MAX_IDLE_GAMES) {
      throw invalidInput(`一次最多挂 ${MAX_IDLE_GAMES} 个游戏（Steam 限制），现在给了 ${picked.length} 个`)
    }

    const appIDs = picked.map((game) => game.appId)
    setOffMarker(false)
    initState('idle', {
      pid: 0,
      appIDs,
      games: picked.map((game) => game.name),
      status: 'starting',
      connectedAt: null,
      startedAt: new Date().toISOString(),
      reconnects: 0,
      error: null,
      proxy: typeof values.proxy === 'string' && values.proxy ? values.proxy : null,
    })

    const pid = spawnDetached(['steam', '_idle-worker'], 'steam-idle')
    writeState('idle', { pid })

    const waitMs = seconds(values.wait, 30, 3, 180) * 1000
    const state = await waitForState<IdleState>('idle', (s) => s?.status === 'online' || s?.status === 'failed', waitMs)

    if (state?.status === 'failed') {
      throw new AstraError('STEAM_IDLE_FAILED', state.error ?? '登录失败', {
        exitCode: 5,
        hint: `看日志：${logPath('steam-idle')}`,
      })
    }

    return {
      data: {
        status: state?.status ?? 'starting',
        pid,
        games: picked.map((game) => game.name),
        appIDs,
        connectedAt: state?.connectedAt ?? null,
        log: logPath('steam-idle'),
      },
      warnings: state?.status === 'online' ? [] : ['还没连上 Steam，用 `astra steam idle status` 跟一下'],
    }
  },
}

const idleStatus: Command = {
  name: 'steam idle status',
  summary: '现在在挂什么、连着没、重连了几次',
  usage: 'astra steam idle status',
  maxArgs: 0,
  async run() {
    const state = readState('idle')
    if (!state) return { data: { status: 'not_running', hint: '`astra steam idle start <游戏>` 开始挂' } }

    const alive = pidAlive(state.pid)
    const status = state.status === 'online' && !alive ? 'interrupted' : state.status
    const warnings: string[] = []
    if (status === 'interrupted') warnings.push('常驻进程已经不在了（被 OOM / 重启杀掉），重新 `astra steam idle start`')
    if (status === 'starting' && !alive) warnings.push('进程不在了但状态还是 starting，重新 start 一次')

    return {
      data: {
        status,
        pid: state.pid,
        alive,
        games: state.games,
        appIDs: state.appIDs,
        connectedAt: state.connectedAt,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        reconnects: state.reconnects,
        error: state.error,
        proxy: state.proxy,
        log: logPath('steam-idle'),
      },
      warnings,
    }
  },
}

const idleStop: Command = {
  name: 'steam idle stop',
  summary: '停止挂时长（关掉常驻进程，退出「正在玩」）',
  usage: 'astra steam idle stop',
  maxArgs: 0,
  async run() {
    const state = readState('idle')
    if (!state) return { data: { stopped: false, reason: '本来就没在挂' } }
    const wasAlive = pidAlive(state.pid)
    const killed = await terminate(state.pid)
    writeState('idle', { status: 'stopped', connectedAt: null })
    setOffMarker(true)
    return { data: { stopped: true, wasAlive, pid: state.pid, exitClean: killed, games: state.games } }
  },
}


/** `astra steam up <游戏...>` = `idle start`，少打两个字。 */
const up: Command = {
  name: 'steam up',
  summary: '挂时长（`steam idle start` 的简写）',
  usage: 'astra steam up <游戏...> [--wait 30] [--proxy url] [--force]',
  notes: ['等价于 `astra steam idle start`；还没登录就先 `astra steam login <账号>`'],
  options: idleStart.options,
  minArgs: 1,
  async run(ctx) {
    return await idleStart.run(ctx)
  },
}

/** `astra steam down` = `idle stop`。 */
const down: Command = {
  name: 'steam down',
  summary: '停止挂时长（`steam idle stop` 的简写）',
  usage: 'astra steam down',
  notes: ['会写一个 steam-idle.off 标记，探活任务就不会自动补挂了；下次 `steam up` 自动清掉'],
  maxArgs: 0,
  async run(ctx) {
    return await idleStop.run(ctx)
  },
}

/** `astra steam status`：登录态 + 挂时长状态，一次看全。 */
const status: Command = {
  name: 'steam status',
  summary: '登录态和挂时长状态，一次看全',
  usage: 'astra steam status',
  maxArgs: 0,
  async run(ctx) {
    const loginResult = await loginStatus.run(ctx)
    const idleResult = await idleStatus.run(ctx)
    return {
      data: { login: loginResult.data, idle: idleResult.data },
      warnings: [...(loginResult.warnings ?? []), ...(idleResult.warnings ?? [])],
    }
  },
}

export const steamIdleCommands: Command[] = [
  login,
  loginStatus,
  loginCancel,
  idleStart,
  idleStatus,
  idleStop,
  loginWorker,
  idleWorker,
  up,
  down,
  status,
]

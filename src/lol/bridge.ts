/**
 * 从 PC 的 LCU 取数据。
 *
 * 国服（WeGame/腾讯）没有公开战绩 API，唯一干净的源是客户端本地 LCU：
 * 它只监听 127.0.0.1，所以只能「ssh 到 PC 上跑脚本 → 把 JSON 拿回来」。
 *
 * 依赖：PC 上开着 OpenSSH（`ssh <host>` 免密），LoL 客户端在运行。
 * PC 侧不需要安装任何东西——脚本每次现传。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getConfig } from '../core/config.ts'
import { AstraError } from '../core/errors.ts'
import { progress } from '../core/output.ts'
import { LCU_DUMP_PS1, LCU_RANK_PS1, LCU_SGP_PLAYER_PS1 } from './ps1.ts'

export interface LcuSnapshot {
  summoner: LcuSummoner
  ranked: { queueMap?: Record<string, LcuRankedEntry> }
  games: LcuGame[]
}

export interface LcuSummoner {
  puuid?: string
  gameName?: string
  displayName?: string
  summonerLevel?: number
  summonerId?: number | string
}

export interface LcuRankedEntry {
  queueType?: string
  tier?: string
  division?: string
  leaguePoints?: number
  wins?: number
  losses?: number
}

export interface LcuGame {
  gameId?: number
  queueId?: number
  gameMode?: string
  gameType?: string
  gameVersion?: string
  gameCreation?: number
  gameDuration?: number
  participants?: LcuParticipant[]
  participantIdentities?: { participantId?: number }[]
}

export interface LcuParticipant {
  championId?: number
  timeline?: { lane?: string; role?: string }
  stats?: Record<string, number | boolean | undefined>
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new AstraError('LOL_PC_TIMEOUT', `${command} 超时（${Math.round(timeoutMs / 1000)}s）`, {
        exitCode: 5,
        retryable: true,
        hint: 'PC 可能睡眠/关机了，或者 ssh 卡住；先 `astra lol doctor`',
      }))
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new AstraError('LOL_PC_UNREACHABLE', `无法执行 ${command}：${err.message}`, {
        exitCode: 5,
        hint: '确认容器里能用 `ssh <pc>` 免密登录（见 skill home-lan-access）',
      }))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 0, stdout, stderr })
    })
  })
}

export function pcHost(): string {
  const configured = getConfig('lol.pc')?.trim()
  return configured || 'pc'
}

export function remoteDumpDir(): string {
  return (getConfig('lol.pc-dump-dir') || 'C:/LocalSpace/lol-dump').replace(/\\/g, '/')
}

/** 把远端脚本路径和目录路径拼出来（远端用正斜杠，scp 只认这个）。 */
function remotePaths() {
  const dir = remoteDumpDir().replace(/\/+$/, '')
  return { dir, script: `${dir}/lcu_dump.ps1` }
}

/** scp 一份最新脚本到 PC（幂等，覆盖写）。 */
async function pushScript(host: string, scriptPath: string, localPath: string, timeoutMs: number): Promise<void> {
  const r = await run('scp', ['-q', localPath, `${host}:${scriptPath}`], timeoutMs)
  if (r.code !== 0) {
    throw new AstraError('LOL_PC_SCP_FAILED', '把采集脚本送到 PC 失败', {
      exitCode: 5,
      hint: '确认 PC 上 ssh 可达、目标目录可写（默认 C:/LocalSpace/lol-dump 会自动建）',
      details: { stderr: r.stderr.slice(0, 300) },
    })
  }
}

/**
 * 抓一次快照：ssh 到 PC 跑脚本 → scp 三个 JSON 回来 → 解析。
 *
 * 客户端没开会明确报 `LOL_CLIENT_NOT_RUNNING`，而不是给一个空列表——
 * 「今天没打」和「客户端没开」是两件事，混起来会让人以为数据丢了。
 */
export async function fetchLcuSnapshot(options: { host?: string; signal?: AbortSignal } = {}): Promise<LcuSnapshot> {
  const host = options.host ?? pcHost()
  const { dir, script } = remotePaths()
  const work = await mkdtemp(path.join(tmpdir(), 'astra-lol-'))
  try {
    const localPs1 = path.join(work, 'lcu_dump.ps1')
    await writeFile(localPs1, LCU_DUMP_PS1, 'utf8')
    progress('lol.push', { host, script })
    await pushScript(host, script, localPs1, 120_000)

    progress('lol.dump', { host })
    const dump = await run('ssh', [host, `powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:ASTRA_LOL_DUMP_DIR='${dir}'; & '${dir}/lcu_dump.ps1'"`], 180_000)
    const out = `${dump.stdout}\n${dump.stderr}`
    if (out.includes('NO_CLIENT')) {
      throw new AstraError('LOL_CLIENT_NOT_RUNNING', 'PC 上没检测到英雄联盟客户端', {
        exitCode: 3,
        hint: '先把 LoL 客户端打开（WeGame 启动国服客户端），再 `astra lol sync`',
      })
    }
    if (out.includes('NO_CREDENTIALS')) {
      throw new AstraError('LOL_CLIENT_NOT_READY', '客户端在跑但拿不到 LCU 端口/令牌', {
        exitCode: 3,
        retryable: true,
        hint: '客户端可能还在启动；等它进到大厅再试',
      })
    }
    if (dump.code !== 0 && !out.includes('FETCH')) {
      throw new AstraError('LOL_DUMP_FAILED', 'PC 上采集脚本执行失败', {
        exitCode: 5,
        details: { stdout: dump.stdout.slice(0, 400), stderr: dump.stderr.slice(0, 400) },
      })
    }

    const files: Record<string, string> = {}
    for (const name of ['summoner.json', 'ranked.json', 'matches.json']) {
      const local = path.join(work, name)
      const r = await run('scp', ['-q', `${host}:${dir}/${name}`, local], 120_000)
      if (r.code !== 0) {
        throw new AstraError('LOL_SCP_FAILED', `取回 ${name} 失败`, {
          exitCode: 5,
          details: { stderr: r.stderr.slice(0, 300) },
        })
      }
      files[name] = await readFile(local, 'utf8')
    }

    const summoner = parseJson<LcuSummoner>(files['summoner.json']!, 'summoner.json')
    const ranked = parseJson<LcuSnapshot['ranked']>(files['ranked.json']!, 'ranked.json')
    const matches = parseJson<{ games?: { games?: LcuGame[] } }>(files['matches.json']!, 'matches.json')
    return { summoner, ranked, games: matches.games?.games ?? [] }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new AstraError('LOL_BAD_JSON', `${label} 不是合法 JSON`, {
      exitCode: 5,
      details: { preview: text.slice(0, 200) },
    })
  }
}

/** 从一局里挑出「我」那一条 participant（LCU 一般只返回自己这一侧）。 */
export function myParticipant(game: LcuGame): LcuParticipant | null {
  const parts = game.participants ?? []
  if (parts.length === 0) return null
  const identities = game.participantIdentities ?? []
  if (identities.length === 1 && identities[0]?.participantId !== undefined) {
    const match = parts.find((p, i) => (i + 1) === identities[0]!.participantId)
    if (match) return match
  }
  return parts[0] ?? null
}

/**
 * 查任意召唤师（`名字#TAG`）的最近对局。
 *
 * 走 **SGP**（Riot 的战绩服务），不是 LCU 的 match-history —— 后者对「隐藏战绩」的账号
 * 只返回 gameCount 不给 games（实测：好友隐藏后 LCU 0 局、SGP 5 局）。
 * Akari 的「查隐藏战绩」也是这条路。
 *
 * 参数走 UTF-8 JSON 文件而不是命令行：中文昵称过 ssh → PowerShell 会按 ANSI 解码。
 */
export interface SgpGameSummary {
  metadata?: { match_id?: string; timestamp?: number; participants?: string[] }
  json?: {
    gameId?: number
    gameCreation?: number
    gameDuration?: number
    queueId?: number
    gameMode?: string
    gameVersion?: string
    participants?: Record<string, unknown>[]
    teams?: { teamId?: number; win?: boolean }[]
  }
}

export async function fetchPlayerSnapshot(name: string, count: number, options: { host?: string } = {}): Promise<{
  puuid: string
  region: string
  games: SgpGameSummary[]
  missing: number
}> {
  if (!name.includes('#')) {
    throw new AstraError('LOL_BAD_NAME', '查询别人要写成「名字#TAG」', {
      exitCode: 2,
      hint: '例如 `astra lol player 某个名字#1234`；只给名字 LCU 会回 422 INVALID_EMPTY_REQUEST（实测）',
    })
  }
  const host = options.host ?? pcHost()
  const { dir } = remotePaths()
  const script = `${dir}/lcu_sgp_player.ps1`
  const work = await mkdtemp(path.join(tmpdir(), 'astra-lol-player-'))
  try {
    const localPs1 = path.join(work, 'lcu_sgp_player.ps1')
    await writeFile(localPs1, LCU_SGP_PLAYER_PS1, 'utf8')
    await pushScript(host, script, localPs1, 120_000)

    const reqFile = path.join(work, 'player_req.json')
    await writeFile(reqFile, JSON.stringify({ name, count }), 'utf8')
    await pushScript(host, `${dir}/player_req.json`, reqFile, 120_000)

    const dump = await run('ssh', [host, `powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:ASTRA_LOL_DUMP_DIR='${dir}'; & '${script}'"`], 240_000)
    const out = `${dump.stdout}\n${dump.stderr}`
    if (out.includes('NO_CLIENT')) {
      throw new AstraError('LOL_CLIENT_NOT_RUNNING', 'PC 上没检测到英雄联盟客户端', {
        exitCode: 3,
        hint: '先把 LoL 客户端打开，再查别人',
      })
    }
    if (out.includes('LOOKUP_FAIL')) {
      const detail = out.split('LOOKUP_FAIL')[1]?.slice(0, 200) ?? ''
      throw new AstraError('LOL_SUMMONER_NOT_FOUND', `找不到召唤师：${name}`, {
        exitCode: 4,
        hint: '确认「名字#TAG」写对；国服 TAG 是昵称后面那个 4-5 位数字',
        details: { upstream: detail.trim() },
      })
    }
    if (out.includes('SGP_LIST_FAIL') || out.includes('NO_ACCESS_TOKEN')) {
      throw new AstraError('LOL_SGP_FAILED', 'SGP 战绩服务没给出列表', {
        exitCode: 5,
        retryable: true,
        hint: '通常是大区取错了（region 从 /riotclient/region-locale 读）；重开客户端再试',
        details: { stdout: dump.stdout.slice(0, 300) },
      })
    }
    if (!out.includes('SGP_DONE')) {
      throw new AstraError('LOL_SGP_FAILED', 'SGP 取数没跑完', {
        exitCode: 5,
        details: { stdout: dump.stdout.slice(0, 400), stderr: dump.stderr.slice(0, 300) },
      })
    }

    const local = path.join(work, 'player_sgp.json')
    const r = await run('scp', ['-q', `${host}:${dir}/player_sgp.json`, local], 120_000)
    if (r.code !== 0) throw new AstraError('LOL_SCP_FAILED', '取回 player_sgp.json 失败', { exitCode: 5 })
    const payload = parseJson<{ puuid?: string; region?: string; games?: SgpGameSummary[] }>(await readFile(local, 'utf8'), 'player_sgp.json')
    const missingMatch = out.match(/missing=(\d+)/)
    return {
      puuid: payload.puuid ?? '',
      region: payload.region ?? '',
      games: payload.games ?? [],
      missing: missingMatch ? Number(missingMatch[1]) : 0,
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}


/** 任意召唤师的当前段位（实时，不入库）。`who` 可以是「名字#TAG」，也可以直接给 puuid。 */
export async function fetchPlayerRank(
  who: string,
  options: { host?: string } = {},
): Promise<{
  puuid: string
  name: string
  solo: LcuRankedEntry | null
  flex: LcuRankedEntry | null
  highest: LcuRankedEntry | null
}> {
  const isPuuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(who)
  if (!isPuuid && !who.includes('#')) {
    throw new AstraError('LOL_BAD_NAME', '查询要写成「名字#TAG」，或者直接给 puuid', {
      exitCode: 2,
      hint: '例如 `astra lol rank Aurora#58597`',
    })
  }
  const host = options.host ?? pcHost()
  const { dir } = remotePaths()
  const script = `${dir}/lcu_rank.ps1`
  const work = await mkdtemp(path.join(tmpdir(), 'astra-lol-rank-'))
  try {
    const localPs1 = path.join(work, 'lcu_rank.ps1')
    await writeFile(localPs1, LCU_RANK_PS1, 'utf8')
    await pushScript(host, script, localPs1, 120_000)

    const reqFile = path.join(work, 'rank_req.json')
    await writeFile(reqFile, JSON.stringify(isPuuid ? { puuid: who } : { name: who }), 'utf8')
    await pushScript(host, `${dir}/rank_req.json`, reqFile, 120_000)

    const dump = await run('ssh', [host, `powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:ASTRA_LOL_DUMP_DIR='${dir}'; & '${script}'"`], 180_000)
    const out = `${dump.stdout}\n${dump.stderr}`
    if (out.includes('NO_CLIENT')) {
      throw new AstraError('LOL_CLIENT_NOT_RUNNING', 'PC 上没检测到英雄联盟客户端', {
        exitCode: 3,
        hint: '先把 LoL 客户端打开（或跑 `sh /opt/data/scripts/lol_launch.sh`）',
      })
    }
    if (out.includes('LOOKUP_FAIL')) {
      const detail = out.split('LOOKUP_FAIL')[1]?.slice(0, 200) ?? ''
      throw new AstraError('LOL_SUMMONER_NOT_FOUND', `找不到召唤师：${who}`, {
        exitCode: 4,
        hint: '确认「名字#TAG」写对；国服 TAG 是昵称后面那个 4-5 位数字',
        details: { upstream: detail.trim() },
      })
    }
    if (out.includes('RANK_FAIL') || !out.includes('RANK_DONE')) {
      throw new AstraError('LOL_RANK_FAILED', 'LCU 没给出段位数据', {
        exitCode: 5,
        retryable: true,
        details: { stdout: dump.stdout.slice(0, 300) },
      })
    }

    const local = path.join(work, 'rank_lookup.json')
    const r = await run('scp', ['-q', `${host}:${dir}/rank_lookup.json`, local], 120_000)
    if (r.code !== 0) throw new AstraError('LOL_SCP_FAILED', '取回 rank_lookup.json 失败', { exitCode: 5 })
    const payload = parseJson<{
      puuid?: string
      name?: string
      solo?: LcuRankedEntry | null
      flex?: LcuRankedEntry | null
      highest?: LcuRankedEntry | null
    }>(await readFile(local, 'utf8'), 'rank_lookup.json')
    return {
      puuid: payload.puuid ?? '',
      name: payload.name ?? who,
      solo: payload.solo ?? null,
      flex: payload.flex ?? null,
      highest: payload.highest ?? null,
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

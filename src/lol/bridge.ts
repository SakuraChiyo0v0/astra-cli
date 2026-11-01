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
import { LCU_DUMP_PS1 } from './ps1.ts'

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

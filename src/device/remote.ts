/** 远端执行的小工具：ssh 探活 / 命令拼接（POSIX 与 Windows 的引号规则不同）。 */
import { spawn } from 'node:child_process'
import type { Device } from './types.ts'

export interface RunResult {
  code: number
  out: string
  err: string
  ms: number
}

export function sshTarget(device: Device): string {
  return device.user ? `${device.user}@${device.host}` : String(device.host)
}

export function sshBase(device: Device, timeoutConnect = 8): string[] {
  return ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${timeoutConnect}`, sshTarget(device)]
}

/** 一条命令的 argv → 远端 shell 能吃的字符串。 */
export function remoteLine(device: Device, argv: string[]): string {
  const args = [...argv]
  if (device.ffmpegPath && (args[0] === 'ffmpeg' || args[0] === 'ffprobe')) args[0] = device.ffmpegPath
  if (device.os === 'windows') {
    return args.map((a) => `"${a.replace(/"/g, '""')}"`).join(' ')
  }
  return args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
}

export function run(argv: string[], timeoutMs = 900_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (b) => { out += String(b) })
    child.stderr.on('data', (b) => { err += String(b) })
    const finish = (code: number) => {
      clearTimeout(timer)
      resolve({ code, out, err, ms: Date.now() - started })
    }
    child.on('close', (code) => finish(code ?? -1))
    child.on('error', (exc) => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: String(exc), ms: Date.now() - started })
    })
  })
}

export async function sshOnline(device: Device, timeoutConnect = 5): Promise<boolean> {
  if (device.kind === 'local') return true
  const probe = device.probe || 'true'
  const r = await run(['ssh', ...sshBase(device, timeoutConnect), probe], 15_000)
  if (r.code !== 0 && process.env.ASTRA_DEBUG_SSH) {
    process.stderr.write(`[ssh ${device.name}] code=${r.code} err=${(r.err || r.out).slice(0, 300)}\n`)
  }
  return r.code === 0
}

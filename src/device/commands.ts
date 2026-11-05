/**
 * `astra device`：登记设备、探活、跑基准。
 *
 *   device add <名字> --kind local|ssh [--host --user --caps --tmp --probe --map]
 *   device list / device remove <名字> / device check [名字]
 *
 * `device check` 会真跑 6 秒 720p 的 x264 编码，把「实时倍率」写回配置，
 * 后续 `--device auto` 就按这个倍率排序。
 */
import { spawn } from 'node:child_process'
import type { Command } from '../core/command.ts'
import { invalidInput } from '../core/errors.ts'
import { addDevice, loadStore, removeDevice, saveStore } from './store.ts'
import { remoteLine, run, sshBase, sshOnline } from './remote.ts'
import type { Device } from './types.ts'

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function capsOf(raw: string): string[] {
  return raw
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
}

const add: Command = {
  name: 'device add',
  summary: '登记一台设备（本机或 ssh 可达的机器）',
  usage:
    'astra device add <名字> --kind local|ssh [--host <host>] [--user <u>] [--caps ffmpeg,gpu] [--tmp <目录>] [--probe <命令>] [--map <NAS前缀>=<设备前缀>] [--note 说明]',
  notes: [
    'kind=ssh 时 --host 必填；密码不走这里，用系统 ssh 密钥。',
    '--caps 决定谁能接哪类任务（转码要 ffmpeg）。',
    '--map 用于把 NAS 路径翻成设备路径，例如 --map /host-root/volume1/=Z:\\',
  ],
  options: {
    kind: { type: 'string', description: 'local / ssh', valueName: 'kind' },
    host: { type: 'string', description: 'ssh 目标（别名或地址）', valueName: 'host' },
    user: { type: 'string', description: 'ssh 用户', valueName: 'u' },
    caps: { type: 'string', description: '能力标签，逗号分隔，默认 ffmpeg', valueName: 'a,b' },
    tmp: { type: 'string', description: '设备上的临时目录', valueName: 'dir' },
    os: { type: 'string', description: 'linux / windows（决定引号规则）', valueName: 'os' },
    ffmpeg: { type: 'string', description: 'ffmpeg 可执行文件路径', valueName: 'path' },
    probe: { type: 'string', description: '自定义探活命令（ssh 上执行）', valueName: 'cmd' },
    busy: { type: 'string', description: '忙判定命令，输出含 BUSY 表示在忙', valueName: 'cmd' },
    map: { type: 'string', description: '路径映射 from=to，可重复', valueName: 'from=to' },
    note: { type: 'string', description: '备注', valueName: 'text' },
    force: { type: 'boolean', description: '覆盖同名设备' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    const name = (positionals[0] ?? '').trim()
    if (!/^[\w.-]{1,32}$/.test(name)) throw invalidInput('设备名只能是字母数字 _ . -，最长 32')
    const kind = (str(values.kind) || 'local').toLowerCase()
    if (kind !== 'local' && kind !== 'ssh') throw invalidInput('--kind 只能是 local 或 ssh')
    const host = str(values.host)
    if (kind === 'ssh' && !host) throw invalidInput('kind=ssh 需要 --host', '例：--host 192.168.31.222 或 --host pc')

    const store = loadStore()
    if (store.devices[name] && values.force !== true) {
      throw invalidInput(`设备已存在：${name}`, '要改加 --force')
    }

    const maps = Array.isArray(values.map) ? values.map : values.map ? [values.map] : []
    const pathMap = maps
      .map(String)
      .map((pair) => {
        const idx = pair.indexOf('=')
        if (idx <= 0) return null
        return { from: pair.slice(0, idx), to: pair.slice(idx + 1) }
      })
      .filter((x): x is { from: string; to: string } => x !== null)

    const device: Device = {
      name,
      kind: kind as Device['kind'],
      ...(host ? { host } : {}),
      ...(str(values.user) ? { user: str(values.user) } : {}),
      caps: capsOf(str(values.caps) || 'ffmpeg'),
      ...(str(values.tmp) ? { tmpDir: str(values.tmp) } : {}),
      ...(str(values.os) ? { os: str(values.os).toLowerCase() as Device['os'] } : {}),
      ...(str(values.ffmpeg) ? { ffmpegPath: str(values.ffmpeg) } : {}),
      ...(str(values.probe) ? { probe: str(values.probe) } : {}),
      ...(str(values.busy) ? { busyCmd: str(values.busy) } : {}),
      ...(pathMap.length > 0 ? { pathMap } : {}),
      ...(str(values.note) ? { note: str(values.note) } : {}),
      addedAt: new Date().toISOString(),
    }
    addDevice(store, device)
    saveStore(store)
    return { data: { action: 'added', device } }
  },
}

const list: Command = {
  name: 'device list',
  summary: '列出已登记设备',
  usage: 'astra device list [--table]',
  maxArgs: 0,
  async run() {
    const store = loadStore()
    const items = Object.values(store.devices)
    return {
      data: { count: items.length, devices: items },
      ...(items.length > 0
        ? {
            table: {
              headers: ['名字', '类型', '目标', '能力', '实测倍率', '备注'],
              rows: items.map((d) => [
                d.name,
                d.kind,
                d.kind === 'ssh' ? `${d.user ? `${d.user}@` : ''}${d.host}` : '本机',
                d.caps.join(','),
                d.speed ?? '未测',
                d.note ?? '',
              ]),
            },
          }
        : {}),
    }
  },
}

const remove: Command = {
  name: 'device remove',
  summary: '删掉一台设备',
  usage: 'astra device remove <名字>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const name = (positionals[0] ?? '').trim()
    const store = loadStore()
    if (name === 'nas' && store.devices.nas?.kind === 'local') {
      throw invalidInput('nas 是自动登记的本机，删了没意义', '真要删就先加别的 local 设备')
    }
    if (!store.devices[name]) throw invalidInput(`没有这个设备：${name}`)
    removeDevice(store, name)
    saveStore(store)
    return { data: { action: 'removed', name, remaining: Object.keys(store.devices) } }
  },
}

/** 跑一条命令，返回 { code, out, err, ms }；不抛异常。 */
const check: Command = {
  name: 'device check',
  summary: '探活 + 编码基准（6 秒 720p x264），写回实测倍率',
  usage: 'astra device check [名字]',
  notes: [
    '不给名字就检查全部；远端不可达只标记 offline，不抛错。',
    '倍率 = 视频时长 / 编码耗时，越大越快；1.0 表示实时。',
  ],
  maxArgs: 1,
  async run({ positionals }) {
    const store = loadStore()
    const names = positionals[0] ? [positionals[0].trim()] : Object.keys(store.devices)
    if (names.length === 0) throw invalidInput('没有登记任何设备', '先 astra device add …')

    const results: Array<Record<string, unknown>> = []
    const rows: (string | number | null)[][] = []
    for (const name of names) {
      const device = store.devices[name]
      if (!device) {
        results.push({ name, ok: false, error: 'device not found' })
        rows.push([name, '—', '—', '不存在'])
        continue
      }

      let online = true
      if (device.kind === 'ssh') {
        online = await sshOnline(device)
      }
      if (!online) {
        results.push({ name, ok: false, online: false })
        rows.push([name, '✗', '—', '不可达'])
        continue
      }

      // 6 秒 720p 测试源，x264 veryfast，输出丢弃
      const ff = [
        'ffmpeg', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=6:size=1280x720:rate=30',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-f', 'null', '-',
      ]
      const cmd = device.kind === 'ssh' ? ['ssh', ...sshBase(device), remoteLine(device, ff)] : ff
      const r = await run(cmd, 120_000)
      if (r.code !== 0) {
        results.push({ name, ok: false, online: true, error: (r.err || r.out).slice(0, 200) })
        rows.push([name, '✓', '—', 'ffmpeg 不可用'])
        continue
      }
      const speed = Number((6 / (r.ms / 1000)).toFixed(2))
      device.speed = speed
      results.push({ name, ok: true, online: true, speed, benchMs: r.ms })
      rows.push([name, '✓', `${speed}×`, `${r.ms}ms`])
    }
    saveStore(store)
    return {
      data: { results },
      table: { headers: ['名字', '在线', '倍率', '基准'], rows },
    }
  },
}

export const deviceCommands: Command[] = [add, list, remove, check]

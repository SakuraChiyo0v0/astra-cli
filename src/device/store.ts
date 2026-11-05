/** 设备清单的读写 + 选择逻辑（纯函数尽量单独可测）。 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homePath } from '../core/paths.ts'
import { invalidInput } from '../core/errors.ts'
import type { Device } from './types.ts'

export interface DeviceStore {
  version: 1
  devices: Record<string, Device>
}

export function storePath(): string {
  return homePath('devices.json')
}

export function emptyStore(): DeviceStore {
  return { version: 1, devices: {} }
}

export function loadStore(): DeviceStore {
  const file = storePath()
  if (!existsSync(file)) {
    // 首次使用：把本机登记成 nas，省得用户手动加
    const store = emptyStore()
    store.devices.nas = {
      name: 'nas',
      kind: 'local',
      caps: ['ffmpeg'],
      note: '本机（自动登记）',
      addedAt: new Date().toISOString(),
    }
    return store
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<DeviceStore>
    return { version: 1, devices: (raw.devices ?? {}) as Record<string, Device> }
  } catch {
    return emptyStore()
  }
}

export function saveStore(store: DeviceStore): void {
  const file = storePath()
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

export function addDevice(store: DeviceStore, device: Device): DeviceStore {
  store.devices[device.name] = device
  return store
}

export function removeDevice(store: DeviceStore, name: string): DeviceStore {
  delete store.devices[name]
  return store
}

/** 名称或 auto；auto 交给调用方配合候选列表决定。 */
export function resolveDevice(store: DeviceStore, name?: string): Device {
  const wanted = (name ?? 'auto').trim()
  if (wanted === 'auto') throw invalidInput('auto 需要调用方取舍', '用 pickDevice 而不是 resolveDevice')
  const device = store.devices[wanted]
  if (!device) {
    throw invalidInput(`没有这个设备：${wanted}`, `已登记：${Object.keys(store.devices).join(', ') || '（空）'}`)
  }
  return device
}

export interface PickOptions {
  /** 任务需要的能力，如 ['ffmpeg'] */
  requires: string[]
  /** 在线判定结果（名字 → 是否在线）；没给就视为在线 */
  online?: Record<string, boolean>
  /** 忙判定结果；true 表示不要用 */
  busy?: Record<string, boolean>
  /** 不可用名单（例如本次传输失败过） */
  exclude?: string[]
}

/**
 * 选设备：能力全匹配 → 在线 → 不忙 → 按实测倍率降序（没测过的排最后）→ 原顺序兜底。
 * 纯函数，便于单测；不认识的设备不会被选。
 */
export function pickDevice(store: DeviceStore, opts: PickOptions): Device | null {
  const exclude = new Set(opts.exclude ?? [])
  const candidates = Object.values(store.devices).filter((d) => {
    if (exclude.has(d.name)) return false
    if (opts.requires.some((cap) => !d.caps.includes(cap))) return false
    if (opts.online && opts.online[d.name] === false) return false
    if (opts.busy && opts.busy[d.name] === true) return false
    return true
  })
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => (b.speed ?? 0) - (a.speed ?? 0))[0] ?? null
}

/** NAS 路径 → 设备路径（Windows 上多半是盘符映射）。 */
export function mapPath(device: Device, path: string): string {
  for (const rule of device.pathMap ?? []) {
    if (path.startsWith(rule.from)) return rule.to + path.slice(rule.from.length)
  }
  return path
}

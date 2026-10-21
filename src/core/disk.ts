/**
 * 磁盘用量检查。
 *
 * 音乐和视频目录会持续增长（一张无损专辑 300–600MB，一个 B 站合集几十 GB），
 * 而且没人会主动去 NAS 上看还剩多少。所以让 `doctor` 顺便报一下。
 *
 * 两条线：
 * - **目录本身多大**：走一遍文件树累加。目录特别大时只统计到上限，避免 doctor 跑几分钟
 * - **所在文件系统还剩多少**：`statfs`（Node 18.15+ 的 `fs.statfs`），拿总量、可用量
 *
 * 判断"危险"用两个阈值：目录超过 `warnGb` 提示一次，剩余空间低于 `minFreeGb` 明确告警。
 */
import { statfsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export interface DirUsage {
  /** 目录路径。 */
  dir: string
  /** 目录本身占多少字节（受 maxFiles 限制，可能不完整）。 */
  bytes: number
  files: number
  /** 统计是否因为文件数上限被截断。 */
  truncated: boolean
  /** 所在文件系统：总量 / 可用。拿不到就是 null（某些平台不支持 statfs）。 */
  fsTotalBytes: number | null
  fsFreeBytes: number | null
  /** 人话描述，直接给 AI/用户看。 */
  detail: string
  /** 剩余空间是否到了警戒线。 */
  lowSpace: boolean
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)}${units[i]}`
}

/** 累加目录大小。用迭代而不是递归，避免深目录把调用栈打爆。 */
function measure(dir: string, maxFiles: number): { bytes: number; files: number; truncated: boolean } {
  let bytes = 0
  let files = 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      files += 1
      if (files > maxFiles) return { bytes, files, truncated: true }
      try {
        bytes += statSync(full).size
      } catch {
        // 单个文件读不到就跳过，不因为一个坏文件让整次统计失败
      }
    }
  }
  return { bytes, files, truncated: false }
}

/**
 * 检查一个目录的用量。
 *
 * `minFreeGb` 是"剩余空间低于多少 GB 就告警"。默认 10GB —— 一张无损专辑约 0.5GB，
 * 留 10GB 大约还能再装二十张。
 */
export function dirUsage(dir: string, options: { minFreeGb?: number; maxFiles?: number } = {}): DirUsage {
  const minFree = (options.minFreeGb ?? 10) * 1024 ** 3
  const { bytes, files, truncated } = measure(dir, options.maxFiles ?? 20000)

  let fsTotal: number | null = null
  let fsFree: number | null = null
  try {
    const s = statfsSync(dir)
    fsTotal = Number(s.blocks) * Number(s.bsize)
    fsFree = Number(s.bavail) * Number(s.bsize)
  } catch {
    // 有些平台的 statfs 不可用，或者路径刚被删 —— 不是错误，只是信息缺失
  }

  const parts = [`${human(bytes)}`]
  parts.push(truncated ? `（已统计 ${files} 个文件，超过上限未继续）` : `${files} 个文件`)
  if (fsFree !== null && fsTotal !== null) {
    const pct = fsTotal > 0 ? Math.round((fsFree / fsTotal) * 100) : null
    parts.push(`剩余 ${human(fsFree)}${pct !== null ? ` / ${human(fsTotal)}（${pct}%）` : ''}`)
  }
  const lowSpace = fsFree !== null && fsFree < minFree
  if (lowSpace) parts.push(`低于警戒线 ${options.minFreeGb ?? 10}GB`)

  return {
    dir,
    bytes,
    files,
    truncated,
    fsTotalBytes: fsTotal,
    fsFreeBytes: fsFree,
    detail: parts.join('；'),
    lowSpace,
  }
}

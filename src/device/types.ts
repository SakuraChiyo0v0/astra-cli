/**
 * 设备清单：把「在哪台机器上跑重活」变成声明式配置。
 *
 * - 一台设备 = 名字 + 类型（local / ssh）+ 能力（ffmpeg / gpu / …）+ 探活方式
 * - 任务只写 `--device auto`，由 `pickDevice()` 按「能力匹配 → 在线 → 不忙 → 上次实测倍率」挑
 * - 配置存 `<ASTRA_HOME>/devices.json`（600），密码/私钥不上盘，走系统 ssh 配置
 */
export interface DevicePathMap {
  /** NAS 上的路径前缀 */
  from: string
  /** 设备上的对应前缀（Windows 用 Z:\\ 之类） */
  to: string
}

export interface Device {
  name: string
  kind: 'local' | 'ssh'
  /** ssh 目标，如 pc / 192.168.31.222；kind=ssh 时必填 */
  host?: string
  user?: string
  /** 能力标签：ffmpeg / gpu / nvenc … */
  caps: string[]
  /** 设备上的临时目录（ssh 用） */
  tmpDir?: string
  /** 路径映射，便于把 NAS 路径翻成设备路径 */
  pathMap?: DevicePathMap[]
  /** 自定义探活命令；缺省 ssh 用 `true`，local 恒在线 */
  probe?: string
  /** 最近一次实测的编码速度（实时倍率），由 `device check` 写入 */
  speed?: number
  note?: string
  addedAt: string
}

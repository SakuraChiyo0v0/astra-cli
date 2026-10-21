/**
 * 数据目录。
 *
 * - `ASTRA_HOME`：状态（配置、会话、数据库、音源脚本），默认 `~/.astra`
 * - 音乐根目录：`ASTRA_MUSIC_DIR` > 配置里的 `music.dir` > `<ASTRA_HOME>/music`
 *
 * 容器里把这两个都挂成卷，CLI 本身无状态。
 */
import { homedir } from 'node:os'
import path from 'node:path'
import { mkdirSync } from 'node:fs'

export function astraHome(): string {
  const fromEnv = process.env.ASTRA_HOME
  const home = fromEnv && fromEnv.trim() ? path.resolve(fromEnv) : path.join(homedir(), '.astra')
  mkdirSync(home, { recursive: true })
  return home
}

export function homePath(...segments: string[]): string {
  return path.join(astraHome(), ...segments)
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 配置：`<ASTRA_HOME>/config.json`，一个扁平的键值表。
 *
 * 只登记已知键，未知键直接拒绝 —— 让 AI 拼错键名时立刻知道，而不是写进去了却不生效。
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { homePath } from './paths.ts'
import { AstraError, invalidInput } from './errors.ts'

export interface ConfigKey {
  key: string
  description: string
  default: string
  /** 列出时打码。 */
  secret?: boolean
  /** 返回 null 表示合法，否则是错误说明。 */
  validate?: (value: string) => string | null
}

const QUALITIES = ['128k', '320k', 'flac', '24bit']

export const CONFIG_KEYS: ConfigKey[] = [
  { key: 'music.dir', description: '音乐根目录（绝对路径）；环境变量 ASTRA_MUSIC_DIR 优先', default: '' ,
    validate: (v) => (v === '' || path.isAbsolute(v) ? null : '必须是绝对路径') },
  { key: 'music.quality', description: '默认请求音质：128k / 320k / flac / 24bit（实际以文件实测为准）', default: 'flac',
    validate: (v) => (QUALITIES.includes(v) ? null : `只能是 ${QUALITIES.join(' / ')}`) },
  { key: 'music.template', description: '落盘路径模板，变量 {artist} {albumartist} {album} {title} {year} {track} {disc} {ext}，支持 {track:02}',
    default: '{albumartist}/{album}/{track:02} {title}.{ext}' },
  { key: 'music.lyric', description: '是否写歌词：embed（写进标签）/ lrc（另存 .lrc）/ both / none', default: 'both',
    validate: (v) => (['embed', 'lrc', 'both', 'none'].includes(v) ? null : '只能是 embed / lrc / both / none') },
  { key: 'music.wordLyric', description: '逐字歌词：auto（从酷狗取，时长对不上就跳过）/ off', default: 'auto',
    validate: (v) => (['auto', 'off'].includes(v) ? null : '只能是 auto / off') },
  { key: 'music.ffmpeg', description: 'ffmpeg 可执行文件路径；留空则从 PATH 查找', default: '' },
  { key: 'music.concurrency', description: '批量下载并发数 1..4', default: '2',
    validate: (v) => (/^[1-4]$/.test(v) ? null : '只能是 1..4') },
  { key: 'notify.feishu_webhook', description: '后台任务结束时推送到飞书群机器人的 webhook 地址；环境变量 ASTRA_FEISHU_WEBHOOK 优先', default: '',
    secret: true, validate: (v) => (v === '' || /^https:\/\/open\.(feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\//.test(v) ? null : '不是飞书机器人 webhook 地址') },
  { key: 'notify.feishu_secret', description: '飞书机器人开了签名校验时的密钥；环境变量 ASTRA_FEISHU_SECRET 优先', default: '', secret: true },
]

function configFile(): string {
  return homePath('config.json')
}

function readAll(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(configFile(), 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
      return out
    }
    return {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new AstraError('CONFIG_CORRUPT', `配置文件无法解析：${configFile()}`, { exitCode: 3, hint: '手动修正或删除该文件后重试' })
  }
}

function writeAll(values: Record<string, string>): void {
  const file = configFile()
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

function keyDef(key: string): ConfigKey {
  const def = CONFIG_KEYS.find((k) => k.key === key)
  if (!def) throw invalidInput(`未知配置项 ${key}`, `可用配置项：${CONFIG_KEYS.map((k) => k.key).join(', ')}`)
  return def
}

export function getConfig(key: string): string {
  const def = keyDef(key)
  return readAll()[key] ?? def.default
}

export function setConfig(key: string, value: string): void {
  const def = keyDef(key)
  const problem = def.validate?.(value) ?? null
  if (problem) throw invalidInput(`${key} 的值不合法：${problem}`)
  const all = readAll()
  all[key] = value
  writeAll(all)
}

export function unsetConfig(key: string): void {
  keyDef(key)
  const all = readAll()
  delete all[key]
  writeAll(all)
}

export function listConfig(): { key: string; value: string; isDefault: boolean; description: string }[] {
  const all = readAll()
  return CONFIG_KEYS.map((def) => ({
    key: def.key,
    value: def.secret && all[def.key] ? '已设置（不显示）' : (all[def.key] ?? def.default),
    isDefault: all[def.key] === undefined,
    description: def.description,
  }))
}

export function musicRoot(): string {
  const fromEnv = process.env.ASTRA_MUSIC_DIR
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv)
  const configured = getConfig('music.dir')
  if (configured) return configured
  return homePath('music')
}

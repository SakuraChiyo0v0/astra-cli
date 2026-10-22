/**
 * 配置：`<ASTRA_HOME>/config.json`，一个扁平的键值表。
 *
 * 只登记已知键，未知键直接拒绝 —— 让 AI 拼错键名时立刻知道，而不是写进去了却不生效。
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { homePath } from './paths.ts'
import { AstraError, invalidInput } from './errors.ts'
import { QUALITY_NAMES } from '../bili/sign.ts'

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
  { key: 'music.template', description: '落盘路径模板，变量 {artist}（逗号分隔全部）{artist_list}（分号分隔）{primary_artist}（第一位）{albumartist} {album} {title} {year} {track} {disc} {source} {ext}，支持 {track:02}',
    default: '{albumartist}/{album}/{track:02} {title}.{ext}' },
  { key: 'music.compilation-dir', description: '合辑（专辑歌手是「群星」）的落盘目录，代替模板里的歌手一层；设成 Various Artists 可让播放器按惯例归类', default: '合辑',
    validate: (v) => (v.trim() === '' ? '不能为空' : /[\\/:*?"<>|]/.test(v) ? '目录名里不能有 \\ / : * ? " < > |' : null) },
  { key: 'music.lyric', description: '歌词怎么存：embed（写进标签，带时间戳）/ embed-plain（写纯文本，不认时间戳的老播放器用）/ embed-synced（同 embed）/ lrc（另存 .lrc）/ both / none', default: 'both',
    validate: (v) => (['embed', 'embed-synced', 'embed-plain', 'lrc', 'both', 'none'].includes(v) ? null : '只能是 embed / embed-synced / embed-plain / lrc / both / none') },
  { key: 'music.wordLyric', description: '逐字歌词：auto（从酷狗取，时长对不上就跳过）/ off', default: 'auto',
    validate: (v) => (['auto', 'off'].includes(v) ? null : '只能是 auto / off') },
  { key: 'music.ffmpeg', description: 'ffmpeg 可执行文件路径（B 站合并音视频也用它）；留空则从 PATH 查找', default: '' },
  { key: 'bili.dir', description: '视频根目录（绝对路径）；环境变量 ASTRA_VIDEO_DIR 优先', default: '',
    validate: (v) => (v === '' || path.isAbsolute(v) ? null : '必须是绝对路径') },
  { key: 'bili.template', description: '视频落盘模板，变量 {uploader} {title} {part} {page} {bvid} {quality} {ext}',
    default: '{uploader}/{title}/{page:02} {part}.{ext}' },
  { key: 'bili.quality', description: '默认请求画质：4k / 1080p60 / 1080p / 720p / 480p / 360p（未登录会被服务端封顶 360P）', default: '1080p',
    validate: (v) => ([...Object.values(QUALITY_NAMES)].includes(v) || /^\d+$/.test(v) ? null : '画质名或 qn 数字') },
  { key: 'bili.audio-format', description: '--audio-only 的输出格式：mp3（默认，能写标签）/ flac / m4a（不能写标签）', default: 'mp3',
    validate: (v) => (['mp3', 'flac', 'm4a'].includes(v) ? null : '只能是 mp3 / flac / m4a') },
  { key: 'bili.audio-bitrate', description: '转 mp3 时的码率（kbps）', default: '320',
    validate: (v) => (/^\d+$/.test(v) && Number(v) >= 96 && Number(v) <= 320 ? null : '只能是 96..320') },
  { key: 'bili.tag', description: '--audio-only 是否自动写标签并内嵌封面：true / false', default: 'true',
    validate: (v) => (['true', 'false'].includes(v) ? null : '只能是 true / false') },
  // 伴生文件：与视频同名的 .Metadata.nfo / .jpg / .Danmaku.ass，Emby/Jellyfin 会自动刮削。
  // 默认空 —— 弹幕要额外请求接口，多数情况不需要；要就一次配好。
  { key: 'bili.sidecar', description: '下载视频时顺带生成的伴生文件，逗号分隔：nfo / cover / danmaku / all（默认空 = 不生成）', default: '',
    validate: (v) => (/^[\s,，a-zA-Z]*$/.test(v) ? null : '只能是 nfo / cover / danmaku / all 的组合') },
  { key: 'bili.subscribe.pages', description: '订阅下载哪些分 P：all（默认，完整拿到）/ first（只下 P1，返回 partial: true）', default: 'all',
    validate: (v) => (['all', 'first'].includes(v) ? null : '只能是 all / first') },
  // B 站音频专用模板。留空则用 music.template。
  // 为什么单独一条：音乐模板会把"视频标题"当专辑名，于是一个视频一个目录 ——
  // 订阅开起来就是 201 个子目录。B 站音频本来就该平铺在 UP 主目录下。
  { key: 'bili.audio-template', description: 'B 站音频的落盘模板（留空用 music.template）；变量 {uploader} {title} {part} {page} {bvid} {quality} {ext}，如 Bilibili/{uploader}/{title}.{ext}', default: '' },
  // —— 代理 ——
  // NAS 上 Steam 全域名不通，但有 mihomo 容器提供 http://mihomo:7890。
  // 用 include/exclude 按域名控制，别让 B 站、网易云也绕一圈。
  { key: 'proxy.url', description: 'HTTP 代理地址（如 http://mihomo:7890）；留空则不用代理', default: '',
    validate: (v) => (v === '' || /^http:\/\/[^\s]+$/.test(v) ? null : '要写成 http://host:port') },
  // 这两条的「留空」含义必须写清楚：include 留空**不是**"谁都不走"，而是"全走"。
  // 只说一半会让人以为安全，实际把 B 站、网易云一起推进了代理。
  { key: 'proxy.include', description: '走代理的域名后缀，逗号分隔（如 steampowered.com,steamcommunity.com）；留空 = 全部走代理', default: '' },
  { key: 'proxy.exclude', description: '不走代理的域名后缀，逗号分隔（优先级高于 include）；留空 = 不排除', default: '' },
  // 视频文件大、CDN 也更容易被并发限速，默认比音乐保守
  { key: 'bili.concurrency', description: 'B 站批量任务并发数 1..3', default: '1',
    validate: (v) => (/^[1-3]$/.test(v) ? null : '只能是 1..3') },
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

/** 视频根目录：`ASTRA_VIDEO_DIR` > `bili.dir` > `<ASTRA_HOME>/video`。 */
export function mediaRoot(): string {
  const fromEnv = process.env.ASTRA_VIDEO_DIR
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv)
  const configured = getConfig('bili.dir')
  if (configured) return configured
  return homePath('video')
}

/**
 * B 站弹幕：下载并转字幕。
 *
 * 实测（2026-10-21）：
 * - XML 接口 `/x/v1/dm/list.so?oid=<cid>` 免登录可用，返回 `<d p="...">文本</d>`
 * - `p` 属性是逗号分隔的字段，**第 0 个是出现时间（秒）**，第 1 个是模式（1/2/3 滚动，4 底部，5 顶部）
 * - 还有 protobuf 版 `/x/v2/dm/web/seg.so`（分片，要解 protobuf），XML 版够用就不碰它
 *
 * 转字幕的取舍：弹幕不是字幕。全量塞进 ASS 会变成一坨糊在画面上，所以默认：
 * - 只取「普通弹幕」（模式 1..3），过滤底部/顶部固定弹幕
 * - 按时间聚合成"行"：同一时间窗内的弹幕合并成一条，最多 3 条，避免刷屏
 * - 生成的是 ASS，能带颜色和描边，比 SRT 更像弹幕
 */
import { writeFileSync } from 'node:fs'
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { loadBiliSession, cookieHeader } from './auth.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

export interface DanmakuItem {
  /** 出现时间（秒）。 */
  time: number
  /** 1..3 滚动，4 底部固定，5 顶部固定。 */
  mode: number
  /** 字号。 */
  size: number
  /** 十进制颜色值。 */
  color: number
  text: string
}

/** 解析 XML 弹幕。只做这一件事，损坏的行跳过而不是整批失败。 */
export function parseDanmakuXml(xml: string): DanmakuItem[] {
  const items: DanmakuItem[] = []
  const pattern = /<d p="([^"]*)">([\s\S]*?)<\/d>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml))) {
    const fields = (match[1] ?? '').split(',')
    const time = Number(fields[0])
    if (!Number.isFinite(time)) continue
    // XML 里文本是转义过的；只处理最常见的几种
    const text = (match[2] ?? '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .trim()
    if (!text) continue
    items.push({
      time,
      mode: Number(fields[1]) || 1,
      size: Number(fields[2]) || 25,
      color: Number(fields[3]) || 0xffffff,
      text,
    })
  }
  items.sort((a, b) => a.time - b.time)
  return items
}

export interface DanmakuOptions {
  /** 只保留滚动弹幕（默认 true）。 */
  scrollOnly?: boolean
  /** 单条最大字数，超了截断（弹幕常刷一整段）。 */
  maxLength?: number
  signal?: AbortSignal
}

export async function fetchDanmaku(cid: number, options: DanmakuOptions = {}): Promise<DanmakuItem[]> {
  const session = loadBiliSession()
  const requestOptions: Parameters<typeof httpRequest>[1] = {
    headers: {
      'user-agent': UA,
      referer: REFERER,
      ...(session ? { cookie: cookieHeader(session) } : {}),
    },
    timeoutMs: 20_000,
    retries: 1,
  }
  if (options.signal) requestOptions.signal = options.signal
  const response = await httpRequest(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, requestOptions)
  if (!response.ok) {
    throw new AstraError('BILI_DANMAKU_FAILED', `弹幕接口返回 HTTP ${response.status}`, { exitCode: 5, retryable: true })
  }
  const xml = await response.text()
  if (!xml.includes('<d p=')) return []
  let items = parseDanmakuXml(xml)
  if (options.scrollOnly !== false) items = items.filter((d) => d.mode >= 1 && d.mode <= 3)
  const maxLength = options.maxLength ?? 50
  return items.map((d) => ({ ...d, text: d.text.length > maxLength ? `${d.text.slice(0, maxLength)}…` : d.text }))
}

export interface AssOptions {
  /** 视频宽高，决定弹幕画布。 */
  width: number
  height: number
  /** 同一时间窗内的弹幕合并成一条，默认 2 秒。 */
  bucketSeconds?: number
  /** 每条字幕最多显示几条弹幕。 */
  maxPerLine?: number
  /** 每条停留时长（秒）。 */
  holdSeconds?: number
  /** 最多保留多少条弹幕（按时间先后），默认 1500。弹幕动辄几千条，全塞进去播放器会卡。 */
  maxItems?: number
}

function assTime(seconds: number): string {
  const total = Math.max(0, seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const cs = Math.floor((total % 1) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function assColor(rgb: number): string {
  // ASS 是 &HBBGGRR&
  const r = (rgb >> 16) & 0xff
  const g = (rgb >> 8) & 0xff
  const b = rgb & 0xff
  return `&H${b.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${r.toString(16).padStart(2, '0')}&`
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\r?\n/g, ' ')
}

/**
 * 弹幕转 ASS。
 *
 * 不分轨道、全部用滚动字幕（`\move`），按时间聚合避免同一秒几十条糊在一起。
 */
export function danmakuToAss(items: DanmakuItem[], options: AssOptions): string {
  const { width, height } = options
  const bucket = options.bucketSeconds ?? 2
  const maxPerLine = options.maxPerLine ?? 3
  const hold = options.holdSeconds ?? 6
  // 弹幕动辄上千条，全塞进 ASS 播放器会卡。按时间取前 N 条（而不是随机抽样，
  // 保留开头和结尾的观感更好）。
  const kept = options.maxItems !== undefined && items.length > options.maxItems ? items.slice(0, options.maxItems) : items

  const groups = new Map<number, DanmakuItem[]>()
  for (const item of kept) {
    const key = Math.floor(item.time / bucket)
    const list = groups.get(key)
    if (list) list.push(item)
    else groups.set(key, [item])
  }

  // 同一个桶里的多条弹幕**分摊到桶内的不同时刻**，而不是挤在同一秒一起飞出来。
  // 挤在一起会糊成一片，这也是"1000 条弹幕只剩 48 行"的原因之一。
  const events: string[] = []
  for (const [key, list] of [...groups].sort((a, b) => a[0] - b[0])) {
    const chosen = list.slice(0, maxPerLine)
    const step = bucket / Math.max(1, chosen.length)
    chosen.forEach((item, i) => {
      const start = key * bucket + i * step
      const text = escapeAss(item.text)
      events.push(
        `Dialogue: 0,${assTime(start)},${assTime(start + hold)},Danmaku,,0,0,0,,{\\move(${width + 50},${Math.round(height * 0.8)},-${width},${Math.round(height * 0.8)})\\c${assColor(item.color)}}${text}`,
      )
    })
  }

  const header = `[Script Info]
Title: Bilibili Danmaku
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Danmaku,Microsoft YaHei,${Math.round(height / 24)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  return header + events.join('\n') + '\n'
}

/** 存成 XML（原始弹幕）或 ASS（转换后）。扩展名决定格式。 */
export function writeDanmakuFile(path: string, items: DanmakuItem[], rawXml: string | null, options: AssOptions): 'ass' | 'xml' {
  if (path.toLowerCase().endsWith('.xml') && rawXml !== null) {
    writeFileSync(path, rawXml, 'utf8')
    return 'xml'
  }
  writeFileSync(path, danmakuToAss(items, options), 'utf8')
  return 'ass'
}

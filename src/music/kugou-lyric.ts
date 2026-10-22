/**
 * 酷狗逐字歌词（KRC）。
 *
 * 网易云的歌词只有逐行，`klyric` 字段实测恒为空；逐字只有酷狗 KRC 和 QQ QRC 提供。
 * 这里走酷狗：搜索拿 hash 与时长 → krcs 拿歌词候选 → download 拿 base64 的 krc1 → XOR + zlib。
 *
 * KRC 解密：前 4 字节是 `krc1`，其余字节用 **16 字节循环密钥**异或，然后 zlib inflate。
 * （注意不是流传的"整体异或 0x64"——那是另一种格式，直接用会 `incorrect header check`。）
 *
 * ## 错位防护（关键）
 *
 * 歌词按时间戳渲染，**时长对不上就会整段错位**——唱到副歌时还显示前奏词。三道闸门：
 * 1. 搜索时按网易云时长过滤候选（±3 秒）
 * 2. krcs 候选自带 `duration`（毫秒），再核一次（±3 秒）
 * 3. 解出来的 KRC 头部 `[total:毫秒]` 第三次核对（±5 秒）
 * 任何一道不过就放弃逐字歌词，退回逐行 LRC —— 宁可不给，也不给错的。
 */
import { inflateSync } from 'node:zlib'
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { progress } from '../core/output.ts'
import type { Track } from './netease.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
/** KRC 的 XOR 密钥（16 字节循环）。 */
const KRC_KEY = [0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69]
/** 时长容差：搜索 / 候选 / 文件头三处都用秒级容差。 */
const DURATION_TOLERANCE_MS = 3000
const TOTAL_TOLERANCE_MS = 5000

export interface Word {
  /** 相对这一行开始的毫秒数。 */
  startMs: number
  durationMs: number
  text: string
}

export interface KrcLine {
  startMs: number
  durationMs: number
  text: string
  words: Word[]
}

export interface KrcResult {
  lines: KrcLine[]
  /** 酷狗那边的歌名 - 歌手，用于日志核对。 */
  matched: string
  durationMs: number | null
  /** 是否和网易云时长一致；不一致时调用方不该用它。 */
  durationOk: boolean
}

interface KgSong { FileHash?: string; SongName?: string; SingerName?: string; Duration?: number; AlbumAudioID?: number }
interface KgCandidate { id?: string; accesskey?: string; song?: string; singer?: string; duration?: number }

function plain(text: string | undefined): string {
  return (text ?? '').replace(/<[^>]+>/g, '').trim()
}

async function getJson<T>(url: string, what: string, signal?: AbortSignal): Promise<T> {
  const options: Parameters<typeof httpRequest>[1] = { headers: { 'user-agent': UA }, timeoutMs: 15_000, retries: 1 }
  if (signal) options.signal = signal
  const response = await httpRequest(url, options)
  if (!response.ok) throw new AstraError('KUGOU_HTTP', `酷狗${what}返回 HTTP ${response.status}`, { exitCode: 5, retryable: true })
  try {
    return (await response.json()) as T
  } catch {
    throw new AstraError('KUGOU_BAD_RESPONSE', `酷狗${what}返回的不是 JSON`, { exitCode: 5 })
  }
}

/**
 * 从搜索结果里挑一个时长够近的候选。**没有就返回 null，绝不回退到第一条**
 * —— 回退等于绕过闸门，正是"时长不符→整段错位"的来源。抽成纯函数便于测试。
 */
export function pickByDuration(list: KgSong[], wantMs: number | null): KgSong | null {
  if (wantMs === null) return null
  const wantSec = wantMs / 1000
  return list.find((s) => s.Duration !== undefined && Math.abs(Number(s.Duration) - wantSec) <= DURATION_TOLERANCE_MS / 1000) ?? null
}

/**
 * 在酷狗搜这首歌。按歌名 + 歌手搜，**必须**有候选时长落在容差内。
 *
 * 这里绝不回退到 `list[0]`：那等于绕过第一道闸门，正是"时长不符→整段错位"的来源。
 * 找不到时长的够近的候选就返回 null，交给调用方放弃逐字。
 */
async function searchSong(track: Track, signal?: AbortSignal): Promise<KgSong | null> {
  const keyword = `${track.title} ${track.artists[0] ?? ''}`.trim()
  const url =
    'https://songsearch.kugou.com/song_search_v2?keyword=' + encodeURIComponent(keyword) +
    '&page=1&pagesize=10&platform=WebFilter&tag=em&filter=2&iscorrection=1&privilege_filter=0'
  const body = await getJson<{ data?: { lists?: KgSong[] } }>(url, '搜索', signal)
  const list = body.data?.lists ?? []
  const hit = pickByDuration(list, track.durationMs)
  if (!hit) progress('lyric.rejected', { id: track.id, reason: 'no-candidate-within-tolerance', wantMs: track.durationMs, candidates: list.slice(0, 3).map((s) => s.Duration) })
  return hit
}

async function fetchKrc(hash: string, albumAudioId: number | undefined, durationSec: number | undefined, signal?: AbortSignal): Promise<{ raw: Buffer; candidate: KgCandidate } | null> {
  const search = new URLSearchParams({
    ver: '1', client: 'pc', man: 'yes', hash, album_audio_id: String(albumAudioId ?? ''), dfid: '-', mid: '1',
    uuid: '-', appid: '1005', platid: '4', _: String(Date.now()),
  })
  if (durationSec !== undefined) search.set('duration', String(durationSec))
  const cand = await getJson<{ candidates?: KgCandidate[] }>(`https://krcs.kugou.com/search?${search}`, '歌词搜索', signal)
  const candidate = (cand.candidates ?? [])[0]
  if (!candidate?.id || !candidate.accesskey) return null

  const download = new URLSearchParams({ ver: '1', client: 'pc', id: candidate.id, accesskey: candidate.accesskey, fmt: 'krc', charset: 'utf8' })
  const options: Parameters<typeof httpRequest>[1] = { headers: { 'user-agent': UA }, timeoutMs: 20_000, retries: 1 }
  if (signal) options.signal = signal
  const response = await httpRequest(`https://lyrics.kugou.com/download?${download}`, options)
  if (!response.ok) return null
  // 返回的是 JSON，歌词在 content 字段里（base64）
  const body = (await response.json()) as { content?: string }
  if (!body.content) return null
  return { raw: Buffer.from(body.content, 'base64'), candidate }
}

/** `krc1` + 16 字节循环 XOR + zlib。key 可注入，只为了让测试证明错误密钥确实解不开。 */
export function decodeKrc(raw: Buffer, key: number[] = KRC_KEY): string {
  let body = raw
  if (body.subarray(0, 4).toString('latin1') === 'krc1') {
    body = body.subarray(4)
    for (let i = 0; i < body.length; i += 1) body[i] = body[i]! ^ key[i % key.length]!
  }
  return inflateSync(body).toString('utf8')
}

/**
 * 制作人员行（作词 / 作曲 / 编曲…）。
 *
 * 酷狗 KRC 常把这几行当成歌词正文带出来，时间戳还挤在开头几秒。
 * 播放器会把它当第一句"歌词"高亮 —— 用户看到的是"作词: 汪苏泷"在闪。
 * 逐字歌词里尤其明显，因为每个字都带时间戳。
 */
export function isCreditLine(text: string): boolean {
  return /^[\s[\]\d:.]*(作词|作曲|编曲|词|曲|制作人|录音|混音|母带|吉他|贝斯|鼓|和声|监制|出品|发行|监制|OP|SP)\s*[:：]/i.test(text)
}

/** 解析 `[start,duration]<off,dur,0>字<off,dur,0>字…`。 */
export function parseKrc(text: string): KrcResult {
  const lines: KrcLine[] = []
  let declaredTotal: number | null = null
  for (const raw of text.split(/\r?\n/)) {
    const total = raw.match(/^\[total:(\d+)\]$/)
    if (total) {
      declaredTotal = Number(total[1])
      continue
    }
    const head = raw.match(/^\[(\d+),(\d+)\](.*)$/)
    if (!head) continue
    const startMs = Number(head[1])
    const durationMs = Number(head[2])
    const rest = head[3] ?? ''
    const words: Word[] = []
    const hasTags = /<\d+,\d+,\d+>/.test(rest)
    // 没有逐字标签就是纯文本行，words 保持为空（下游据此判断"这行没有逐字"）
    if (!hasTags) {
      const text = rest.trim()
      if (text && !isCreditLine(text)) lines.push({ startMs, durationMs, text, words })
      continue
    }
    // 第一个标签**之前**的文字也算内容（KRC 里确实出现过 `a<0,100,0>b` 这种写法），
    // 不能只抓标签后面的，否则开头会凭空少字。
    const firstTag = rest.indexOf('<')
    const leading = firstTag === -1 ? rest : rest.slice(0, firstTag)
    if (leading.length > 0) words.push({ startMs: 0, durationMs: 0, text: leading })
    const pattern = /<(\d+),(\d+),\d+>([^<]*)/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(rest))) {
      const word = match[3]!
      if (word.length > 0) words.push({ startMs: Number(match[1]), durationMs: Number(match[2]), text: word })
    }
    const lineText = words.map((w) => w.text).join('')
    if (!lineText.trim()) continue
    // 作词/作曲/编曲这几行不是歌词，留着会让播放器把它当第一句高亮
    if (isCreditLine(lineText)) continue
    lines.push({ startMs, durationMs, text: lineText, words })
  }
  // 上面逐行扫到过 [total:] 就用它；没扫到再兜一次（有的文件把它写在别的行里）。
  // 两边都没有就是 null —— 表示"不知道"，不是 0。下游据此决定要不要用时长拦。
  if (declaredTotal === null) {
    const totalMatch = text.match(/\[total:(\d+)\]/)
    if (totalMatch) declaredTotal = Number(totalMatch[1])
  }
  return {
    lines,
    matched: '',
    durationMs: declaredTotal,
    durationOk: true,
  }
}

/**
 * 给一首网易云的歌取酷狗逐字歌词。
 *
 * 任何一步对不上（找不到、时长不符）都返回 null，**不是错误** —— 调用方退回逐行歌词就好。
 */
export async function kugouWordLyric(track: Track, signal?: AbortSignal): Promise<KrcResult | null> {
  if (!track.durationMs) return null
  try {
    const song = await searchSong(track, signal)
    if (!song?.FileHash) return null
    const krc = await fetchKrc(song.FileHash, song.AlbumAudioID, song.Duration, signal)
    if (!krc) return null

    // 第二道闸门：候选自带的时长（毫秒）
    const candidateMs = krc.candidate.duration ?? null
    if (candidateMs !== null && Math.abs(candidateMs - track.durationMs) > DURATION_TOLERANCE_MS) {
      progress('lyric.rejected', { id: track.id, reason: 'candidate-duration', candidateMs, wantMs: track.durationMs })
      return null
    }

    const text = decodeKrc(krc.raw)
    const parsed = parseKrc(text)
    if (parsed.lines.length === 0) return null

    // 第三道闸门：KRC 头部 [total:]。
    // 只有"能读到 total 且明显不符"才拦；读不到 total 说明信息缺失，不构成错位证据。
    //
    // `[total:0]` 也算"读不到"：酷狗有一部分 KRC 就是这个值，把它当成真实时长
    // 会与任何歌曲都差出几分钟，从而把**正确**的逐字歌词整批丢掉。
    const totalMs = parsed.durationMs
    if (totalMs !== null && totalMs > 0 && Math.abs(totalMs - track.durationMs) > TOTAL_TOLERANCE_MS) {
      progress('lyric.rejected', { id: track.id, reason: 'krc-total', totalMs, wantMs: track.durationMs })
      return null
    }
    const durationOk = true

    return {
      ...parsed,
      matched: `${plain(krc.candidate.song ?? song.SongName)} - ${plain(krc.candidate.singer ?? song.SingerName)}`,
      durationOk,
    }
  } catch (err) {
    progress('lyric.krc_failed', { id: track.id, error: (err as Error).message.slice(0, 120) })
    return null
  }
}

/** 逐字 + 逐行一起：逐行给播放器，逐字另存一份增强 LRC。 */
export function toEnhancedLrc(krc: KrcResult): string {
  return krc.lines
    .map((line) => {
      const stamp = formatStamp(line.startMs)
      if (line.words.length === 0) return `[${stamp}]${line.text}`
      // 增强 LRC 的逐字标签在**字前面**：`<00:01.00>あ` 表示「あ」从 1.00 秒开始
      const words = line.words.map((w) => `<${formatStamp(line.startMs + w.startMs)}>${w.text}`).join('')
      return `[${stamp}]${words}`
    })
    .join('\n')
}

function formatStamp(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const minutes = Math.floor(total / 60000)
  const seconds = Math.floor((total % 60000) / 1000)
  const centis = Math.floor((total % 1000) / 10)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`
}

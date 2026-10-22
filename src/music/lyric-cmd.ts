/**
 * `music lyric`：单独取歌词，**不下载音频**。
 *
 * 为什么需要它：库里常有"音频已经在、但没有歌词"的曲子 —— 典型是
 * `bili get --audio-only` 下来的翻唱 mp3。补歌词时不能重下（重复占盘、
 * 还会打乱已经整理好的文件名和标签），而 astra 内部的歌词能力（网易云逐行 +
 * 酷狗逐字）此前只在下完一首歌时顺带用，没有对外的命令。
 *
 * 两条链路各管一段：
 * - **匹配**：先确定"是哪首歌"。用关键词搜网易云，拿它的时长当基准
 * - **逐字**：酷狗 KRC 自带三道时长闸门（见 kugou-lyric.ts）。校验基准可用
 *   `--duration` 覆盖 —— 库里的 B 站音频不是网易云记录，得用实际音频时长去核
 *
 * 宁可不给，也不给错的：时长对不上的候选一律丢弃，报 `lyric.no_match`。
 */
import { getConfig } from '../core/config.ts'
import { lyric as neteaseLyric, searchSongs, songDetail, type Track } from './netease.ts'
import { isCreditLine, kugouWordLyric, toEnhancedLrc } from './kugou-lyric.ts'
import { mergeLrc } from './download.ts'
import { resolveTarget } from './target.ts'

/** 候选判定：歌名要能对上，时长差要在容差内。 */
export interface LyricCandidate {
  track: Track
  /** 歌名相似度 0..1（正规化后完全包含即 1）。 */
  titleScore: number
  /** 时长差（毫秒）；候选没有时长时是 null。 */
  durationDeltaMs: number | null
}

/** 逐字校验允许的时长容差，与 kugou-lyric 的搜索闸门保持一致。 */
const DURATION_TOLERANCE_MS = 3000

/** 一个可程序化选择的候选。 */
export interface LyricCandidateView {
  ref: string
  title: string
  artists: string[]
  durationMs: number | null
  /** 与 `--duration` 的差（毫秒）；没给基准时是 null。排序依据。 */
  durationDeltaMs: number | null
}

/**
 * 多个版本都能匹配上。
 *
 * 用专门的类型而不是往消息里塞 JSON：调用方要的是结构化数据，
 * 塞进文案里逼着人去正则解析，正是这个错误要避免的事。
 */
export class AmbiguousLyricError extends Error {
  readonly candidates: LyricCandidateView[]
  constructor(message: string, candidates: LyricCandidateView[]) {
    super(`AMBIGUOUS:${message}`)
    this.name = 'AmbiguousLyricError'
    this.candidates = candidates
  }
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    // 括号里的附注（"（Live）"、"【TV size】"）不影响"是不是同一首"
    .replace(/[（(【\[].*?[)）】\]]/g, '')
    .replace(/[\s\-_·・.,，。!！?？'"“”‘’/\\]/g, '')
}

/**
 * 从候选里挑"确实就是这首"的。
 *
 * 两条硬要求：
 * 1. **歌名要能对上**（含附注的算部分匹配）
 * 2. **时长差要在容差内** —— 有基准时是必须的
 *
 * 没有基准时长（纯关键词、用户没给 `--duration`）时**不做版本判断**：
 * 搜"年轮"第一条是汪苏泷的男声版（4:06），张碧晨原版（4:35）排第二，
 * 只按歌名取第一条就会拿错版本 —— 而不同版本的歌词和时长都不同。
 * 这种情况下返回全部够格的候选，让调用方决定是报歧义还是让用户补 --duration。
 * 「拿不准就返回候选，不替用户选版本」。
 */
export function pickLyricCandidates(
  candidates: Track[],
  wanted: { title: string; durationMs: number | null },
): LyricCandidate[] {
  const want = normalize(wanted.title)
  const scored: LyricCandidate[] = []
  for (const track of candidates) {
    const have = normalize(track.title)
    const artists = track.artists.map(normalize).filter(Boolean)
    // 判据是"整个查询串能不能对上歌名，或者对上'歌名+歌手'"。
    // 只比歌名的话，"年轮 张碧晨"会把汪苏泷版也当成候选；
    // 但反过来只认严格相等，"年轮 (Live)" 这类附注版就永远选不到。
    const asTitle = matchScore(have, want)
    // 查询串里带了歌手：标题对上之后，再用歌手精确度细分，
    // 避免「年轮 张碧晨」把「年轮 - 张碧晨/周芷莹」也算成完全匹配
    const queryArtist = artists.length > 0 ? artistScore(artists, want) : 0
    const titleScore = asTitle === 0 && queryArtist === 0
      ? 0
      : Math.max(asTitle > 0 ? asTitle * 0.6 : 0, queryArtist) * (asTitle > 0 ? 1 : 0.9)
    if (titleScore === 0) continue
    const delta = track.durationMs !== null && wanted.durationMs !== null
      ? Math.abs(track.durationMs - wanted.durationMs)
      : null
    // 有基准时长时必须落在容差内；没有基准就看歌名
    if (delta !== null && delta > DURATION_TOLERANCE_MS) continue
    scored.push({ track, titleScore, durationDeltaMs: delta })
  }
  scored.sort((a, b) => {
    const da = a.durationDeltaMs ?? Number.MAX_SAFE_INTEGER
    const db = b.durationDeltaMs ?? Number.MAX_SAFE_INTEGER
    // 先比"查询串对得有多全"，再比时长差
    return b.titleScore - a.titleScore || da - db
  })
  return scored
}

/** 两段文字是否一方包含另一方；完全相等给 1，部分包含给 0.8，对不上给 0。 */
function matchScore(have: string, want: string): number {
  if (!have || !want) return 0
  if (have === want) return 1
  if (have.includes(want) || want.includes(have)) return 0.8
  return 0
}

/**
 * 歌手匹配的语义比标题更严：查询里点到几个歌手，就要对上几个。
 *
 * `年轮 张碧晨` 对 `张碧晨/周芷莹` 只能算部分匹配（0.8）——
 * 那是对唱现场版，不是原版。不这样区分的话两者都拿 1.0，歧义永远消不掉。
 */
function artistScore(trackArtists: string[], want: string): number {
  const wanted = want.split(/[\s/、,，]+/).map(normalize).filter(Boolean)
  if (wanted.length === 0) return 0
  let matched = 0
  for (const w of wanted) {
    if (trackArtists.some((a) => a === w || a.includes(w) || w.includes(a))) matched += 1
  }
  if (matched === 0) return 0
  // 点到的歌手全都对上，且曲目没有多出来的合作者，才算完全匹配
  if (matched === wanted.length && trackArtists.length === wanted.length) return 1
  return 0.8
}

/**
 * 从排好序的候选里定一个。
 *
 * - 只有一个 → 就是它
 * - 查询串完整匹配（歌名 + 歌手都对上）且只有一个 → 选它
 * - 给了基准时长、且有一个**明显更接近** → 选它
 * - 否则 → 返回 null，由调用方报歧义
 *
 * 第三条是给"同一首歌多个版本、都落在 ±3s 容差内"的情形兜底的：
 * 比如「Cry For Me」有 Echo艾歌 302s 和 DJ阿哲 299s 两个候选，
 * 用户传了 `--duration 302` 就说明他知道自己那版是哪个 —— 此时按"时长最接近"
 * 决胜是合理的，不该再让他从提示里手工挑。
 *
 * 但如果两个候选的时长一样近（差 0 秒），仍然报歧义 —— 那种情况下
 * 时长不构成任何证据，替用户选就是瞎猜。
 *
 * 只给歌名、没给 `--duration` 时：多个候选 score 都是 1，没有领先者 → 报歧义。
 * **不替用户选版本**。
 */
export function pickUnique(candidates: LyricCandidate[]): LyricCandidate | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]!
  const perfect = candidates.filter((c) => c.titleScore >= 1)
  if (perfect.length === 1) return perfect[0]!
  // 有时长基准时按"最接近"决胜 —— 但必须明显领先（第二名至少差 1 秒）
  const timed = [...candidates].filter((c) => c.durationDeltaMs !== null)
  if (timed.length >= 2) {
    timed.sort((a, b) => a.durationDeltaMs! - b.durationDeltaMs!)
    const [best, runnerUp] = timed as [LyricCandidate, LyricCandidate]
    if (best.durationDeltaMs! + 1000 <= runnerUp.durationDeltaMs!) return best
  }
  return null
}

/**
 * `--out` 给定的路径要不要改成逐行的那份。
 *
 * 约定与下载一致：`.lrc` 放逐字（增强 LRC 是普通 LRC 的超集），
 * 逐行另存 `.line.lrc`。用户显式给了 `.line.lrc` 就尊重它。
 */
export function lyricFilePaths(outPath: string, wantWord: boolean): { main: string; line: string } {
  const base = outPath.replace(/\.line\.lrc$|\.lrc$/i, '')
  if (!wantWord) return { main: `${base}.lrc`, line: `${base}.lrc` }
  return { main: `${base}.lrc`, line: `${base}.line.lrc` }
}

export interface LyricFetchInput {
  /** 关键词或 ref。 */
  query: string
  /** 要逐字。 */
  wantWord: boolean
  /** 校验用的时长（毫秒）；不给就用匹配到的网易云记录。 */
  durationOverrideMs?: number | null
  signal?: AbortSignal
}

export interface LyricFetchResult {
  matched: { title: string; artists: string[]; durationMs: number | null; source: 'netease' }
  /** 逐行 LRC（可能是逐字剥出来的）。 */
  line: string
  /** 逐字增强 LRC；没拿到就是 null。 */
  word: string | null
  /** 逐字为什么没拿到 —— 给用户一句能懂的话，不是错误。 */
  wordUnavailableReason: string | null
}

/**
 * 取歌词的编排：先定位歌曲，再分别取逐行 / 逐字。
 *
 * 逐字失败**不是错误**：退化成逐行就好。但"连逐行都没有"是错误，
 * 由调用方抛 `lyric.no_match`。
 */
export async function fetchLyric(input: LyricFetchInput): Promise<LyricFetchResult> {
  const target = await resolveTarget(input.query)
  if (target.kind !== 'song' && target.kind !== 'keyword') {
    throw new Error(`只能按单曲取歌词，这个是 ${target.kind}`)
  }

  // 1) 定位歌曲
  let track: Track
  if (target.kind === 'song') {
    track = await songDetail(target.id, input.signal)
  } else {
    const found = await searchSongs(target.keyword, 10, 0, input.signal)
    const candidates = pickLyricCandidates(found.tracks, {
      title: target.keyword,
      // 关键词搜索本身没有基准时长；用户给了 --duration 才用得上
      durationMs: input.durationOverrideMs ?? null,
    })
    if (candidates.length === 0) {
      throw new Error(`NO_MATCH:网易云搜不到「${target.keyword}」`)
    }
    // 歌名相同但版本不同（男声版 / 原版 / DJ 版）时不能替用户选：
    // 搜"年轮"第一条是汪苏泷 4:06，张碧晨原版 4:35 排第二，取第一条就是错的版本。
    const unique = pickUnique(candidates)
    if (!unique) {
      // 机器可读的候选列表挂到 details 上：调用方要程序化选择时不值得去解析错误文案
      throw new AmbiguousLyricError(
        `「${target.keyword}」有 ${candidates.length} 个版本，需要指定：`
        + candidates.slice(0, 5).map((c) => `${c.track.title} - ${c.track.artists.join('/')}（wy:${c.track.id}，${Math.round((c.track.durationMs ?? 0) / 1000)}s）`).join('；'),
        candidates.map((c) => ({
          ref: `wy:${c.track.id}`,
          title: c.track.title,
          artists: c.track.artists,
          durationMs: c.track.durationMs,
          durationDeltaMs: c.durationDeltaMs,
        })),
      )
    }
    track = unique.track
  }

  // 2) 校验基准：用户给了 --duration 就用它（库里的 B 站音频不是网易云记录）
  const verifyTrack: Track = input.durationOverrideMs
    ? { ...track, durationMs: input.durationOverrideMs }
    : track

  // 3) 逐行（网易云，含翻译合并）
  const lr = await neteaseLyric(track.id, input.signal)
  // 网易云 LRC 会在开头带「作词 : xxx / 作曲 : xxx」和一行「歌名 - 歌手」，
  // 播放器会把它们当歌词滚出来 —— 先剔掉再合并翻译
  let line = lr.lrc ? stripNonLyricLines(mergeLrc(lr.lrc, lr.translation), { title: track.title, artists: track.artists }) : ''

  // 4) 逐字（酷狗，自带三道时长闸门）
  let word: string | null = null
  let wordUnavailableReason: string | null = null
  if (input.wantWord) {
    if (getConfig('music.wordLyric') === 'off') {
      wordUnavailableReason = 'music.wordLyric 设为 off，逐字已关闭'
    } else if (!verifyTrack.durationMs) {
      wordUnavailableReason = '没有时长做校验，逐字歌词可能整段错位；用 --duration <秒> 指定实际时长'
    } else {
      try {
        const krc = await kugouWordLyric(verifyTrack, input.signal)
        if (krc) {
          // 逐字同样要滤歌名行（KRC 里的制作信息在 parseKrc 已挡掉，
          // 但「年轮 - 张碧晨 (Diamond)」这种首行还在）
          word = stripNonLyricLines(toEnhancedLrc(krc), { title: track.title, artists: track.artists })
          // 逐字拿到了但逐行是空（网易云没这首）时，从逐字剥一份逐行
          if (!line) {
            line = stripNonLyricLines(
              krc.lines.map((l) => `[${stamp(l.startMs)}]${l.text}`).join('\n'),
              { title: track.title, artists: track.artists },
            )
          }
        } else {
          wordUnavailableReason = '酷狗没有时长能对上的逐字歌词（差超过 3 秒就丢弃，避免整段错位）'
        }
      } catch (err) {
        wordUnavailableReason = `逐字获取失败：${(err as Error).message.slice(0, 120)}`
      }
    }
  }

  if (!line && !word) {
    throw new Error(`NO_MATCH:找不到「${track.title}」的歌词`)
  }

  return {
    matched: {
      title: track.title,
      artists: track.artists,
      durationMs: track.durationMs,
      source: 'netease',
    },
    line: line || '',
    word,
    wordUnavailableReason,
  }
}

/**
 * 去掉"不是歌词的歌词行"。
 *
 * 两种来源都会混进来，播放器一律当歌词滚出来：
 * - **制作信息**：`[00:00.000] 作词 : 汪苏泷` / `作曲` / `编曲` —— 网易云 LRC
 *   和酷狗 KRC 都带（KRC 那边在 parseKrc 里已经滤过，这里兜网易云）
 * - **歌名行**：`[00:00.00]年轮 - 张碧晨 (Diamond)` —— 有的歌词文件把标题塞在第一行
 *
 * 判据只看**行文本本身**，不依赖时间戳：真实歌词也可能正好在 0 秒开始。
 * 歌名行用"和已知的 title/artists 对上"来判断，对不上就不动 —— 宁可留下
 * 一行可疑的，也不要误删开头的第一句歌词。
 */
export function stripNonLyricLines(
  lrc: string,
  meta: { title?: string; artists?: string[] },
): string {
  const norm = (s: string): string => s.toLowerCase().replace(/[\s\-_·・.,，。!！?？'"“”‘’/\\()（）\[\]【】]/g, '')
  const title = norm(meta.title ?? '')
  const artists = (meta.artists ?? []).map(norm).filter(Boolean)

  return lrc
    .split(/\r?\n/)
    .filter((raw) => {
      if (!raw.trim()) return false
      // 取出这一行的时间戳，剩下的才是正文
      const m = raw.match(/^((?:\[[\d:.]+\])+)(.*)$/)
      // 逐字行带着 `<mm:ss.xx>` 标签，判断"这行是什么文字"要先剥掉它们，
      // 否则 norm 之后会混进一长串时间戳数字，什么判据都不准
      const body = (m?.[2] ?? raw).replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim()
      if (!body) return false
      if (isCreditLine(body)) return false
      // 歌名行：正文里能同时找到 title 和所有 artist，且没有多余的实质内容。
      //
      // 逐字那版长这样：`年轮 - 张碧晨 (Diamond)`。`norm` 已经把括号和标点剥掉了，
      // 剩下的就是 `年轮张碧晨diamond` —— 剥掉 title 和 artists 后还剩 `diamond`。
      // 判据用"剩多少"而不是"总长多少"：附注长短不影响判断，只有混进真正的歌词才会超。
      if (title && artists.length > 0) {
        let rest = norm(body)
        // 正文里根本没有歌名 —— 那就是一句歌词，别动它
        if (!rest.includes(title)) return true
        rest = rest.replace(title, '')
        for (const a of artists) rest = rest.replace(a, '')
        // 剩下的部分是"附注"而不是歌词。判据两条，满足其一就算歌名行：
        // - 很短（≤4 字）：`年轮 - 张碧晨` 这种纯标题
        // - 不含中文且 ≤12 字符：`年轮 - 张碧晨 (Diamond)` 的英文版名
        // 真正的歌词行剥掉歌名和歌手后必然还剩一整句中文，两条都不满足。
        const hasCjk = /[一-龥]/.test(rest)
        if (rest.length <= 4 || (!hasCjk && rest.length <= 12)) return false
      }
      return true
    })
    .join('\n')
}

/** LRC 时间戳（`mm:ss.xx`），与 kugou-lyric / netease 的写法保持一致。 */
function stamp(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const minutes = Math.floor(total / 60000)
  const seconds = Math.floor((total % 60000) / 1000)
  const centis = Math.floor((total % 1000) / 10)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`
}

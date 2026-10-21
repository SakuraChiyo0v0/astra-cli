/**
 * 从搜索结果里判断"用户要的是不是这一首"。
 *
 * 只决定一件事：**能不能不问用户就直接下**。宁可多问一次，也不要下错版本。
 *
 * 实测（2026-10-21）教训：搜"晴天 周杰伦"，前 15 条全是翻唱 / 深情版 / 钢琴版，
 * 原唱已不在网易云。所以不能"取第一条"，必须看歌手是否匹配、标题是否带版本标记。
 */
import type { Track } from './netease.ts'

/** 标题里出现这些，说明不是原版。 */
const VARIANT_PATTERNS: [RegExp, string][] = [
  [/原唱|翻唱|翻自|cover|cvoer/i, '翻唱'],
  [/acoustic|不插电|unplugged/i, '特别版'],
  [/live|演唱会|现场/i, 'Live'],
  [/伴奏|instrumental|off\s*vocal|karaoke|纯音乐/i, '伴奏'],
  [/钢琴|吉他|八音盒|music\s*box|piano|guitar|纯音/i, '器乐版'],
  [/dj|remix|混音|电音|beat|bootleg/i, 'Remix'],
  [/女声|男声|深情|治愈|抒情|加速|降速|慢速|0\.\d+x|\d\.\d+x|sped\s*up|slowed|reverb|8d/i, '改编版'],
  [/demo|试听|片段|铃声/i, '片段'],
  [/版\)|版）|ver\.|version|合唱|对唱|tv\s*size|short/i, '特别版'],
]

export interface Candidate {
  track: Track
  score: number
  /** 给人看的标签，比如 ["翻唱", "歌手不符"]。 */
  flags: string[]
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s·・\-_'"“”‘’`~!！?？,，.。:：;；()（）[\]【】<>《》/\\|]+/g, '')
}

export function variantFlags(track: Track): string[] {
  const text = [track.title, ...track.aliases].join(' ')
  const flags: string[] = []
  for (const [pattern, label] of VARIANT_PATTERNS) {
    if (pattern.test(text) && !flags.includes(label)) flags.push(label)
  }
  // 现场专辑里的歌，标题常常不写 Live
  if (!flags.includes('Live') && /\blive\b|演唱会|音乐会|concert/i.test(track.album ?? '')) flags.push('Live')
  return flags
}

const COMPILATION = /精选|纪念|极品|音色|best|greatest|collection|anniversary|合集|全集|金曲|经典/i

/**
 * 同一首歌的多个收录里选哪个：先选不是精选集的，再选发行最早的。
 * 精选集常是重新母带、音质版本不一，原专辑更接近用户心里的"那首歌"。
 */
function preferOriginal(a: Candidate, b: Candidate): number {
  const ac = COMPILATION.test(a.track.album ?? '') ? 1 : 0
  const bc = COMPILATION.test(b.track.album ?? '') ? 1 : 0
  if (ac !== bc) return ac - bc
  return (a.track.publishTime ?? Infinity) - (b.track.publishTime ?? Infinity)
}

/**
 * 关键词拆成"歌名部分"和"歌手部分"：哪些词命中了这首歌的歌手名，就算歌手部分。
 * 例：「晴天 周杰伦」对一首周杰伦的歌 → 歌手命中；对 RyaVocal 的翻唱 → 歌手未命中。
 */
function splitKeyword(keyword: string): string[] {
  return keyword.split(/\s+/).map(normalize).filter(Boolean)
}

export function scoreTrack(keyword: string, track: Track): Candidate {
  const words = splitKeyword(keyword)
  const title = normalize(track.title)
  const artists = track.artists.map(normalize)
  const album = normalize(track.album ?? '')
  const flags = variantFlags(track)

  let score = 0
  const artistWords = words.filter((w) => artists.some((a) => a.includes(w) || (a.length >= 2 && w.includes(a))))
  const restWords = words.filter((w) => !artistWords.includes(w))
  const restJoined = restWords.join('')
  // 去掉歌名里的括号附注再比，"アイドル (TV Size)" 之类交给版本标记去管
  const bareTitle = normalize(track.title.replace(/[(（[【].*?[)）\]】]/g, ''))

  // 歌名：完全相等 > 去附注后相等 > 包含。歌名没对上，歌手对上也没用（"YOASOBI" 能命中它所有歌）
  let titleHit = true
  if (restJoined && title === restJoined) score += 50
  else if (restJoined && bareTitle === restJoined) score += 45
  else if (restJoined && title.includes(restJoined)) score += 20
  else if (restWords.length > 0 && restWords.every((w) => title.includes(w) || album.includes(w))) score += 10
  else titleHit = restWords.length === 0

  const keywordMentionsArtist = artistWords.length > 0
  if (keywordMentionsArtist && titleHit) score += 30
  // 合作曲（歌手比关键词多）稍微让一让独唱原版
  if (keywordMentionsArtist && track.artists.length > artistWords.length) score -= 5 * Math.min(3, track.artists.length - artistWords.length)
  // 关键词里有词既不在歌名里也不在歌手里，八成是没对上的歌手名
  const unexplained = restWords.filter((w) => !title.includes(w) && !album.includes(w))
  if (unexplained.length > 0 && !keywordMentionsArtist && words.length > 1) {
    score -= 25
    flags.push('歌手不符')
  }
  // 不到一分钟的多半是片段 / 铃声
  if (track.durationMs !== null && track.durationMs < 60_000 && !flags.includes('片段')) flags.push('片段')
  // 用户自己写了"live""伴奏"之类，就不惩罚对应的版本
  const kwText = keyword.toLowerCase()
  const penalized = flags.filter((f) => f !== '歌手不符' && !VARIANT_PATTERNS.some(([p, label]) => label === f && p.test(kwText)))
  score -= penalized.length * 20

  score += Math.round((track.popularity ?? 0) / 10)
  return { track, score, flags }
}

export interface MatchDecision {
  /** 确定是它，可以直接下。 */
  pick: Candidate | null
  /** 拿不准时给用户挑的候选（按分数降序）。 */
  candidates: Candidate[]
  /** 选定后，同一首歌在别的专辑里的版本（单曲 / 专辑 / 精选），供用户改主意。 */
  alternatives: Candidate[]
  reason: string
}

/** 同名同歌手（一方的歌手包含另一方，比如加了伴唱嘉宾）视为同一首歌的不同收录。 */
function sameSong(a: Track, b: Track): boolean {
  if (normalize(a.title) !== normalize(b.title)) return false
  const as = new Set(a.artists.map(normalize))
  const bs = new Set(b.artists.map(normalize))
  return [...as].every((x) => bs.has(x)) || [...bs].every((x) => as.has(x))
}

/**
 * 决策规则（按顺序）：
 * 1. 第一名必须"干净"：没有版本标记、歌名命中（分数 ≥ 40）
 * 2. 同歌名同歌手、只是专辑不同的，视为同一首歌：取第一名，其它放进 alternatives
 * 3. 剩下的干净候选里，第一名要领先第二名 ≥ 15 分
 * 4. 其余情况一律让用户挑
 */
export function decide(keyword: string, tracks: Track[], max = 5): MatchDecision {
  const scored = tracks.map((t) => scoreTrack(keyword, t)).sort((a, b) => b.score - a.score)
  const candidates = scored.slice(0, max)
  const top = scored[0]
  if (!top) return { pick: null, candidates: [], alternatives: [], reason: '没有搜到结果' }
  const clean = scored.filter((c) => c.flags.length === 0 && c.score >= 40)
  const best = clean[0]
  if (!best) return { pick: null, candidates, alternatives: [], reason: '搜索结果里没有明显的原版，可能都是翻唱或改编' }
  if (best !== top) return { pick: null, candidates, alternatives: [], reason: '排在前面的是改编版本，需要确认要哪一个' }
  const group = clean.filter((c) => sameSong(c.track, best.track))
  const rivals = clean.filter((c) => !sameSong(c.track, best.track))
  const second = rivals[0]
  if (second && best.score - second.score < 15) return { pick: null, candidates, alternatives: [], reason: '有几个相近的结果，需要确认' }
  // 同一首歌的多个收录：只在分数接近（±3，热度抖动）的里面挑原专辑
  const near = group.filter((c) => best.score - c.score <= 3).sort(preferOriginal)
  const chosen = near[0] ?? best
  const alternatives = group.filter((c) => c !== chosen)
  return {
    pick: chosen,
    candidates,
    alternatives,
    reason: alternatives.length > 0 ? '明确匹配；同一首歌还收录在其它专辑里' : '唯一明确的匹配',
  }
}

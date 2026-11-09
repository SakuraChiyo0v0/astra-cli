/**
 * 文本工具：HTML 片段 → 段落、繁→简、书名比较用的归一。
 */
import { PHRASES, SIMP, TRAD } from './t2s-data.ts'

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** 去标签、解实体，压缩行内空白。 */
export function stripTags(fragment: string): string {
  return decodeEntities(fragment.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/**
 * 按 `<br>` / `<p>` 分段，返回段落数组（去掉空段、段首尾全角空格）。
 *
 * 各站用的分段方式不同：有的整章一个 `<p>` 里全是 `<br>`，有的每段一个 `<p>`。两种一起切。
 */
export function htmlParagraphs(fragment: string): string[] {
  return fragment
    .split(/(?:<br\s*\/?>\s*)+|<\/?p(?:\s[^>]*)?>/i)
    .map((part) => stripTags(part).replace(/^[\s　]+|[\s　]+$/g, '').replace(BROKEN_ENTITY, '').trim())
    .filter((part) => part.length > 0)
}

/**
 * 段首残缺的实体：站点把 `&nbsp;` 截成了 `p;` / `bsp;`（8novel 实测一章里出现过两次）。
 * 只在段首、且后面紧跟非 ASCII 字符时才删，英文段落里的 `p;` 不动。
 */
const BROKEN_ENTITY = /^(?:&?n?b?s?p;)+(?=[^\x00-\x7f])/

let charMap: Map<string, string> | null = null
let phraseList: [string, string][] = []

function tables(): { chars: Map<string, string>; phrases: [string, string][] } {
  if (!charMap) {
    const map = new Map<string, string>()
    const trad = [...TRAD]
    const simp = [...SIMP]
    trad.forEach((t, i) => map.set(t, simp[i]!))
    charMap = map
    // 长词优先，避免「不瞭解」被「瞭解」抢先拆掉
    phraseList = [...PHRASES].sort((a, b) => b[0].length - a[0].length)
  }
  return { chars: charMap, phrases: phraseList }
}

/**
 * 繁→简：先换词组，再逐字换。
 *
 * 数据来自 OpenCC，但这里没有它的分词：一个繁体字有多个简体写法、要看上下文的情况
 * 只能取第一个候选，偶尔会错。词组表能兜住常见的那批（「瞭解」「乾淨」之类）。
 */
export function toSimplified(text: string): string {
  if (!text) return text
  const { chars, phrases } = tables()
  let out = text
  for (const [from, to] of phrases) if (out.includes(from)) out = out.split(from).join(to)
  let result = ''
  for (const ch of out) result += chars.get(ch) ?? ch
  return result
}

/**
 * 比较书名时额外归一的字。
 *
 * 这些字 OpenCC 不做逐字转换（要看上下文：「著作」不能变「着作」），所以正文转换不能动它们，
 * 但比较书名时必须等同 —— 台版写「活著」，大陆版写「活着」，是同一本书。
 */
const TITLE_FOLD: Record<string, string> = { 著: '着', 乾: '干', 於: '于', 裡: '里', 裏: '里', 麼: '么', 么: '么', 綫: '线', 鬥: '斗', 姊: '姐' }

/** 比较书名用：去空白、书名号、常见标点，统一成简体小写。 */
export function normalizeTitle(text: string): string {
  return [...toSimplified(text)].map((c) => TITLE_FOLD[c] ?? c).join('').replace(/[\s《》「」『』【】[\]()（）·・:：,，.。!！?？~～\-—_]/g, '').toLowerCase()
}

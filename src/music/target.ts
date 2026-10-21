/**
 * 把用户/AI 给的东西解析成明确的目标。
 *
 * 接受：
 * - `wy:186016`、`song:186016`、纯数字 id（≥5 位）
 * - 网易云链接：`music.163.com/#/song?id=`、`/song?id=`、`y.music.163.com/m/song?id=`、`/album?id=`、`/playlist?id=`、`/artist?id=`
 * - 网易云短链 `163cn.tv/xxx`（需要联网展开）
 * - 其余当作关键词
 */
import { httpRequest } from '../core/http.ts'

export type Target =
  | { kind: 'song'; id: string }
  | { kind: 'album'; id: string }
  | { kind: 'playlist'; id: string }
  | { kind: 'artist'; id: string }
  | { kind: 'keyword'; keyword: string }

const KIND_ALIASES: Record<string, Target['kind']> = {
  wy: 'song', song: 'song', s: 'song',
  album: 'album', al: 'album',
  playlist: 'playlist', pl: 'playlist',
  artist: 'artist', ar: 'artist',
}

export function parseTarget(input: string): Target {
  const text = input.trim()
  const prefixed = text.match(/^([a-z]+):(\d+)$/i)
  if (prefixed) {
    const kind = KIND_ALIASES[prefixed[1]!.toLowerCase()]
    if (kind) return { kind, id: prefixed[2]! } as Target
  }
  if (/^\d{5,}$/.test(text)) return { kind: 'song', id: text }
  const link = text.match(/(?:music\.163\.com|163\.com)[^\s]*?\/(song|album|playlist|artist|discover\/toplist)\b[^\s]*?[?&]id=(\d+)/i)
  if (link) {
    const raw = link[1]!.toLowerCase()
    const kind: Target['kind'] = raw === 'discover/toplist' ? 'playlist' : (raw as Target['kind'])
    return { kind, id: link[2]! } as Target
  }
  return { kind: 'keyword', keyword: text }
}

/** 展开 `163cn.tv` 一类短链。不是短链就原样返回。 */
export async function expandShortLink(input: string): Promise<string> {
  const match = input.match(/https?:\/\/(?:163cn\.tv|163cn\.link)\/[A-Za-z0-9]+/i)
  if (!match) return input
  const response = await httpRequest(match[0], { method: 'GET', timeoutMs: 8000 })
  await response.body?.cancel()
  return response.url && response.url !== match[0] ? response.url : input
}

export async function resolveTarget(input: string): Promise<Target> {
  const direct = parseTarget(input)
  if (direct.kind !== 'keyword') return direct
  if (/163cn\.(tv|link)\//i.test(input)) return parseTarget(await expandShortLink(input))
  return direct
}

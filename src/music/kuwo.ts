/**
 * 酷我：只用来给"同一首歌"找第二条音频路线，身份 / 元数据仍以网易云为准。
 *
 * 实测（2026-10-21）：
 * - 周杰伦等在网易云上音源返回 404 的歌，酷我能经 qdy 拿到直链
 * - 酷我经 qdy 请求 flac 给的是真 FLAC（`fLaC`，48MB 量级）；请求 320k 反而给 48kbps 的 AAC
 * - 搜索接口 `search.kuwo.cn/r.s` 免登录，`MUSICRID` 形如 `MUSIC_7119717`，`DURATION` 是秒
 * - 歌名常带附注："アイドル-《【我推的孩子】》TV动画片头曲|第1话片尾曲"，比较前要去掉
 */
import { httpJson } from '../core/http.ts'
import { normalize, variantFlags } from './match.ts'
import type { Track } from './netease.ts'

export interface KuwoHit {
  rid: string
  title: string
  artists: string[]
  album: string | null
  durationSec: number | null
}

interface RawKuwo { MUSICRID?: string; SONGNAME?: string; ARTIST?: string; ALBUM?: string; DURATION?: string }

export async function searchKuwo(keyword: string, limit = 10, signal?: AbortSignal): Promise<KuwoHit[]> {
  const params = new URLSearchParams({
    client: 'kt', all: keyword, pn: '0', rn: String(limit), uid: '794762570', ver: 'kwplayer_ar_9.2.2.1', vipver: '1',
    show_copyright_off: '1', newver: '1', ft: 'music', cluster: '0', strategy: '2012', encoding: 'utf8', rformat: 'json', vermerge: '1', mobi: '1',
  })
  const options: Parameters<typeof httpJson>[1] = { timeoutMs: 10_000, retries: 1 }
  if (signal) options.signal = signal
  const body = await httpJson<{ abslist?: RawKuwo[] }>(`http://search.kuwo.cn/r.s?${params}`, options)
  return (body.abslist ?? [])
    .filter((x) => x.MUSICRID?.startsWith('MUSIC_'))
    .map((x) => ({
      rid: x.MUSICRID!.slice('MUSIC_'.length),
      title: decodeEntities(x.SONGNAME ?? ''),
      artists: decodeEntities(x.ARTIST ?? '').split(/&|、/).map((s) => s.trim()).filter(Boolean),
      album: x.ALBUM ? decodeEntities(x.ALBUM) : null,
      durationSec: x.DURATION ? Number(x.DURATION) || null : null,
    }))
}

function decodeEntities(text: string): string {
  return text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"')
}

/** 酷我歌名的附注写法：`歌名-《xxx》片头曲`、`歌名 (xxx)`。 */
export function bareKuwoTitle(title: string): string {
  return title.replace(/-《.*$/, '').replace(/[(（[【].*?[)）\]】]/g, '').trim()
}

/**
 * 在酷我结果里找"同一首歌"：歌名（去附注）相等、至少一个歌手相同、时长差 ≤ 3 秒、不是 Live / 伴奏等变体。
 * 宁缺毋滥：对不上就返回 null，绝不拿另一个版本冒充。
 */
export function matchKuwo(track: Track, hits: KuwoHit[]): KuwoHit | null {
  const wantTitle = normalize(track.title.replace(/[(（[【].*?[)）\]】]/g, ''))
  const wantArtists = new Set(track.artists.map(normalize))
  const wantSec = track.durationMs ? track.durationMs / 1000 : null
  const wantFlags = variantFlags(track)
  for (const hit of hits) {
    if (normalize(bareKuwoTitle(hit.title)) !== wantTitle) continue
    if (!hit.artists.some((a) => wantArtists.has(normalize(a)))) continue
    if (wantSec !== null && (hit.durationSec === null || Math.abs(hit.durationSec - wantSec) > 3)) continue
    const flags = variantFlags({ ...track, title: hit.title, aliases: [], album: hit.album })
    if (flags.some((f) => !wantFlags.includes(f))) continue
    return hit
  }
  return null
}

export async function findOnKuwo(track: Track, signal?: AbortSignal): Promise<KuwoHit | null> {
  const keyword = `${track.title.replace(/[(（[【].*?[)）\]】]/g, '').trim()} ${track.artists[0] ?? ''}`.trim()
  return matchKuwo(track, await searchKuwo(keyword, 10, signal))
}

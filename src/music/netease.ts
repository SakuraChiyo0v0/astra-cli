/**
 * 网易云官方接口：搜索、详情、歌词、歌单 / 专辑 / 歌手。全部免登录。
 *
 * 实测（2026-10-21）：
 * - 搜索用 `/api/cloudsearch/pc`：比 `/api/search/get` 多给封面、别名、privilege
 * - 详情用 `/api/v3/song/detail?c=[{id}]`，一次可批量；`/api/song/detail` 能多拿专辑公司 / 专辑歌手
 * - 歌单 `/api/v6/playlist/detail` 的 `tracks` 只给前 10 首（大歌单），**`trackIds` 才是全量**，必须再按 id 批量查详情
 * - 专辑 `/api/v1/album/<id>` 直接给全部曲目
 * - code 405 / "操作频繁" 是限流，不是"没有这首歌"
 * - 官方取链 `/api/song/enhance/player/url` 匿名时 url=null、code=-110：取链只能靠洛雪音源
 */
import { AstraError } from '../core/errors.ts'
import { httpJson } from '../core/http.ts'
import { cookieHeader, loadSession, type Session } from './auth.ts'

const BASE = 'https://music.163.com'
const BASE_HEADERS: Record<string, string> = {
  Referer: 'https://music.163.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
}

/**
 * 带会话的请求头。
 *
 * 匿名也能查公开内容，但**私人歌单、每日推荐、账号维度的曲目**只有带 MUSIC_U 才看得到。
 * 会话文件不存在时退回匿名（`appver=2.0.2` 是匿名请求一直用的 cookie）。
 */
export function headers(session: Session | null = loadSession()): Record<string, string> {
  return { ...BASE_HEADERS, Cookie: cookieHeader(session) }
}


export interface Track {
  id: string
  title: string
  artists: string[]
  album: string | null
  albumId: string | null
  durationMs: number | null
  coverUrl: string | null
  /** 歌名附注，例如"TV动画《我推的孩子》片头曲"。 */
  aliases: string[]
  /** 翻译名。 */
  translations: string[]
  trackNo: number | null
  discNo: string | null
  publishTime: number | null
  /** 网易云热度 0..100。用来在候选里区分原唱和翻唱。 */
  popularity: number | null
  /** 平台判定的付费类型：0/8 免费，1 VIP，4 购买专辑。只是参考，取链不看它。 */
  fee: number | null
}

export interface AlbumInfo {
  id: string
  name: string
  artists: string[]
  company: string | null
  publishTime: number | null
  size: number | null
  coverUrl: string | null
}

interface RawArtist { id?: number; name?: string }
interface RawAlbum { id?: number; name?: string; picUrl?: string }
export interface RawSong {
  id: number
  name: string
  ar?: RawArtist[]
  artists?: RawArtist[]
  al?: RawAlbum
  album?: RawAlbum & { publishTime?: number }
  dt?: number
  duration?: number
  alia?: string[]
  alias?: string[]
  tns?: string[]
  transNames?: string[]
  no?: number
  cd?: string
  disc?: string
  publishTime?: number
  pop?: number
  popularity?: number
  fee?: number
}

interface CodeBody { code?: number; msg?: string; message?: string }

function https(url: string | undefined | null): string | null {
  if (!url) return null
  return url.replace(/^http:/, 'https:')
}

export function toTrack(raw: RawSong): Track {
  const artists = (raw.ar ?? raw.artists ?? []).map((a) => a.name ?? '').filter(Boolean)
  const album = raw.al ?? raw.album
  const publishTime = raw.publishTime ?? raw.album?.publishTime ?? null
  return {
    id: String(raw.id),
    title: raw.name,
    artists,
    album: album?.name ? album.name : null,
    albumId: album?.id ? String(album.id) : null,
    durationMs: raw.dt ?? raw.duration ?? null,
    coverUrl: https(album?.picUrl),
    aliases: raw.alia ?? raw.alias ?? [],
    translations: raw.tns ?? raw.transNames ?? [],
    trackNo: raw.no && raw.no > 0 ? raw.no : null,
    discNo: raw.cd ?? raw.disc ?? null,
    publishTime: publishTime && publishTime > 0 ? publishTime : null,
    popularity: typeof raw.pop === 'number' ? raw.pop : typeof raw.popularity === 'number' ? raw.popularity : null,
    fee: typeof raw.fee === 'number' ? raw.fee : null,
  }
}

function checkCode(body: CodeBody, what: string): void {
  if (body.code === 200 || body.code === undefined) return
  const msg = body.msg ?? body.message ?? ''
  if (body.code === 405 || /频繁/.test(msg)) {
    throw new AstraError('RATE_LIMITED', `网易云限流（${what}）：${msg || '操作频繁'}`, { exitCode: 5, retryable: true, hint: '等一两分钟再试' })
  }
  throw new AstraError('UPSTREAM_ERROR', `网易云${what}返回 code=${body.code}${msg ? `：${msg}` : ''}`, { exitCode: 5, details: { code: body.code } })
}

async function get<T extends CodeBody>(pathAndQuery: string, what: string, signal?: AbortSignal): Promise<T> {
  const options: Parameters<typeof httpJson>[1] = { headers: headers(), retries: 2 }
  if (signal) options.signal = signal
  const body = await httpJson<T>(BASE + pathAndQuery, options)
  checkCode(body, what)
  return body
}

/** 网易云的 publishTime 是北京时间零点的 epoch，按 UTC 取日期会早一天。 */
export function beijingDate(epochMs: number | null): string | null {
  if (!epochMs) return null
  const d = new Date(epochMs + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export async function searchSongs(keyword: string, limit: number, offset = 0, signal?: AbortSignal): Promise<{ total: number; tracks: Track[] }> {
  const query = `s=${encodeURIComponent(keyword)}&type=1&limit=${limit}&offset=${offset}`
  const body = await get<CodeBody & { result?: { songs?: RawSong[]; songCount?: number } }>(`/api/cloudsearch/pc?${query}`, '搜索', signal)
  const songs = body.result?.songs ?? []
  return { total: body.result?.songCount ?? songs.length, tracks: songs.map(toTrack) }
}

/** 批量详情。一次最多 500 个，超出自动分批。缺失的 id 不报错，由调用方比对。 */
export async function songDetails(ids: string[], signal?: AbortSignal): Promise<Track[]> {
  const out: Track[] = []
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500).map((id) => ({ id: Number(id) }))
    const body = await get<CodeBody & { songs?: RawSong[] }>(`/api/v3/song/detail?c=${encodeURIComponent(JSON.stringify(batch))}`, '歌曲详情', signal)
    out.push(...(body.songs ?? []).map(toTrack))
  }
  return out
}

export async function songDetail(id: string, signal?: AbortSignal): Promise<Track> {
  const [track] = await songDetails([id], signal)
  if (!track) throw new AstraError('NOT_FOUND', `网易云没有歌曲 ${id}`, { exitCode: 4 })
  return track
}

/**
 * 从专辑接口的 `artist` / `artists` 里挑出真正的专辑艺术家。
 *
 * **单数字段 `artist` 优先，复数字段 `artists` 只做兜底。**
 *
 * 实测（2026-10-23）复数字段会把曲目歌手一起灌进来：
 *   Die With A Smile  artist="Lady Gaga"  artists=["Lady Gaga","Bruno Mars"]  曲数 1
 *   两个人叫我们        artist="林可期"     artists=["林可期","陆锦舟"]           曲数 1
 * 这两张专辑实际都只有一位主艺术家，复数里的第二个是合作歌手。
 * 取复数会把它们拼成 "Lady Gaga, Bruno Mars"，落盘各起一个假歌手目录 ——
 * 这是"合作曲散落在假歌手目录下"的根因，修在别处都没用，错的数据是这里传出去的。
 *
 * 真正多人共同署名的专辑，单数是一整个组合名，仍然对：
 *   マクロス40周年…  artist="シェリル・ランカ・ワルキューレ"  artists=[同名, May'n, 中島愛, ワルキューレ]
 *
 * 单数缺失时才退回复数（老数据 / 别的接口形状）。
 */
export function albumArtistsFrom(album: { artist?: RawArtist; artists?: RawArtist[] }): string[] {
  return (album.artist ? [album.artist] : album.artists ?? []).map((x) => x.name ?? '').filter(Boolean)
}

/** 专辑元数据（公司、专辑歌手、发行时间），写标签用。 */
export async function albumInfo(albumId: string, signal?: AbortSignal): Promise<{ album: AlbumInfo; tracks: Track[] }> {
  const body = await get<CodeBody & { album?: { id: number; name: string; picUrl?: string; company?: string; publishTime?: number; size?: number; artists?: RawArtist[]; artist?: RawArtist }; songs?: RawSong[] }>(
    `/api/v1/album/${encodeURIComponent(albumId)}`,
    '专辑',
    signal,
  )
  if (!body.album) throw new AstraError('NOT_FOUND', `网易云没有专辑 ${albumId}`, { exitCode: 4 })
  const a = body.album
  const artists = albumArtistsFrom(a)
  return {
    album: {
      id: String(a.id),
      name: a.name,
      artists,
      company: a.company?.trim() || null,
      publishTime: a.publishTime && a.publishTime > 0 ? a.publishTime : null,
      size: a.size ?? null,
      coverUrl: https(a.picUrl),
    },
    tracks: (body.songs ?? []).map(toTrack),
  }
}

export async function playlistTracks(playlistId: string, signal?: AbortSignal): Promise<{ name: string; total: number; tracks: Track[]; coverUrl: string | null }> {
  const body = await get<CodeBody & { playlist?: { name: string; trackCount?: number; trackIds?: { id: number }[]; tracks?: RawSong[]; coverImgUrl?: string } }>(
    `/api/v6/playlist/detail?id=${encodeURIComponent(playlistId)}&n=100000`,
    '歌单',
    signal,
  )
  const playlist = body.playlist
  if (!playlist) throw new AstraError('NOT_FOUND', `网易云没有歌单 ${playlistId}（或歌单是私密的）`, { exitCode: 4 })
  const ids = (playlist.trackIds ?? []).map((t) => String(t.id))
  const tracks = ids.length > 0 ? await songDetails(ids, signal) : (playlist.tracks ?? []).map(toTrack)
  // 按歌单原顺序排
  const order = new Map(ids.map((id, i) => [id, i]))
  tracks.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  return { name: playlist.name, total: playlist.trackCount ?? tracks.length, tracks, coverUrl: playlist.coverImgUrl ? playlist.coverImgUrl.replace(/^http:/, 'https:') : null }
}

export async function artistTopTracks(artistId: string, signal?: AbortSignal): Promise<{ name: string; tracks: Track[] }> {
  const body = await get<CodeBody & { artist?: { name: string }; hotSongs?: RawSong[] }>(`/api/v1/artist/${encodeURIComponent(artistId)}`, '歌手', signal)
  if (!body.artist) throw new AstraError('NOT_FOUND', `网易云没有歌手 ${artistId}`, { exitCode: 4 })
  return { name: body.artist.name, tracks: (body.hotSongs ?? []).map(toTrack) }
}

export async function searchCollection(kind: 'album' | 'playlist' | 'artist', keyword: string, limit: number, signal?: AbortSignal): Promise<{ id: string; name: string; subtitle: string | null; count: number | null }[]> {
  const type = kind === 'album' ? 10 : kind === 'playlist' ? 1000 : 100
  const body = await get<CodeBody & { result?: Record<string, unknown> }>(`/api/cloudsearch/pc?s=${encodeURIComponent(keyword)}&type=${type}&limit=${limit}&offset=0`, '搜索', signal)
  const result = body.result ?? {}
  if (kind === 'album') {
    const albums = (result.albums as { id: number; name: string; artist?: RawArtist; artists?: RawArtist[]; size?: number; publishTime?: number }[] | undefined) ?? []
    return albums.map((a) => ({
      id: String(a.id),
      name: a.name,
      subtitle: [(a.artists ?? (a.artist ? [a.artist] : [])).map((x) => x.name).join(' / '), beijingDate(a.publishTime ?? null)?.slice(0, 4)].filter(Boolean).join(' · ') || null,
      count: a.size ?? null,
    }))
  }
  if (kind === 'playlist') {
    const lists = (result.playlists as { id: number; name: string; trackCount?: number; creator?: { nickname?: string } }[] | undefined) ?? []
    return lists.map((p) => ({ id: String(p.id), name: p.name, subtitle: p.creator?.nickname ?? null, count: p.trackCount ?? null }))
  }
  const artists = (result.artists as { id: number; name: string; albumSize?: number; alias?: string[] }[] | undefined) ?? []
  return artists.map((a) => ({ id: String(a.id), name: a.name, subtitle: a.alias?.join(' / ') || null, count: a.albumSize ?? null }))
}

export interface LyricResult {
  lrc: string | null
  translation: string | null
  romanization: string | null
}

export async function lyric(id: string, signal?: AbortSignal): Promise<LyricResult> {
  const body = await get<CodeBody & { lrc?: { lyric?: string }; tlyric?: { lyric?: string }; romalrc?: { lyric?: string } }>(
    `/api/song/lyric?id=${encodeURIComponent(id)}&lv=-1&tv=-1&rv=-1`,
    '歌词',
    signal,
  )
  const clean = (s: string | undefined): string | null => (s && s.trim() ? s : null)
  return { lrc: clean(body.lrc?.lyric), translation: clean(body.tlyric?.lyric), romanization: clean(body.romalrc?.lyric) }
}

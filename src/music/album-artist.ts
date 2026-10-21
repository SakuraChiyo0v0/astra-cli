/**
 * 专辑艺术家 / 合辑判定。
 *
 * 单独成文件是因为 download.ts 会连带拉起网络、音源脚本、ffmpeg 这些重东西，
 * 而下面这两个函数是纯的 —— 测试要能单独 import。
 *
 * ## 合辑怎么认
 *
 * 实测（2026-10-23）`/api/v1/album/<id>`：网易云没有 "Various Artists" 这个值，
 * 群星专辑的 `album.artists` 是 `[{ id: 122455, name: "群星", alias: ["华语群星"] }]`。
 * 所以按规范名 "Various Artists" 去匹配永远匹配不上。
 *
 * **只能看专辑级的 artist，不能看曲目。**「那些年的华语情歌」里每首歌的 `ar`
 * 只有那首歌自己的歌手（雪中莲→王菲、断点→张敬轩），拿曲目去判会得出"这不是合辑"。
 *
 * 判成合辑后，标签里的 album_artist 与落盘目录都用 "Various Artists" ——
 * Navidrome / Plex 认这个标准值，"群星" 它们不认。
 *
 * ## 为什么不按"专辑歌手有多个"来判
 *
 * 那会把**合作专辑**误判成合辑（两个人各出一半的专辑，专辑级就是两个歌手），
 * 文件一落地就进了 `合辑/`，而且不会有人立刻发现。合辑只认显式的群星标记，
 * 判不准的时候宁可按普通专辑走。
 */

/** 网易云与其它平台对"群星"的叫法，全部按规范名处理。 */
const COMPILATION_NAMES = new Set(['群星', 'various artists', 'various artist', 'va', 'v.a.'])

/**
 * 网易云的群星歌手 id。名字对不上时兜底 —— 它的 alias 是「华语群星」之类的变体，
 * 万一哪天名字跟着改，id 不会变。
 */
const NETEASE_VARIOUS_ID = '122455'

/** 写进标签和目录的规范名。 */
export const COMPILATION_ARTIST = 'Various Artists'

export interface AlbumArtistInput {
  /** 专辑级歌手（`AlbumInfo.artists`）；查不到专辑时传 null / 空数组。 */
  albumArtists: string[] | string | null
  /** 曲目自己的歌手；只判合辑时用不上。 */
  trackArtists?: string[]
  /** 专辑 id，只有网易云的群星 id 兜底时才用得上。 */
  albumId?: string | null
}

function namesOf(value: string[] | string | null | undefined): string[] {
  const list = value == null ? [] : typeof value === 'string' ? [value] : value
  return list.map((v) => v.trim()).filter(Boolean)
}

/** `namesOf` 里用得上：第一位歌手就是首选歌手。 */
function firstOf(value: string[] | string | null | undefined): string {
  return namesOf(value)[0] ?? ''
}

/** 只看专辑级字段 —— `trackArtists` 在类型里是给调用方方便，判定时不用它。 */
export function isCompilation(input: AlbumArtistInput): boolean {
  const names = namesOf(input.albumArtists)
  if (input.albumId && String(input.albumId) === NETEASE_VARIOUS_ID) return true
  if (names.length === 0) return false
  return names.some((n) => COMPILATION_NAMES.has(n.toLowerCase()))
}

/**
 * 标签里的专辑艺术家。
 *
 * 专辑查不到时退回**第一位**歌手，不是拼接全部 —— 专辑级字段塞一串歌手
 * 会让每首歌的专辑归属看起来都不一样，播放器列表里同一个专辑散成好几张。
 */
export function albumArtistsFor(input: AlbumArtistInput): string[] {
  if (isCompilation(input)) return [COMPILATION_ARTIST]
  const fromAlbum = namesOf(input.albumArtists)
  if (fromAlbum.length > 0) return fromAlbum
  const primary = firstOf(input.trackArtists)
  return primary ? [primary] : []
}

/** 落盘模板里的 `{primary_artist}`：第一位歌手，没有专辑信息时也不会拼成一长串。 */
export function primaryArtist(trackArtists: string[]): string {
  return firstOf(trackArtists)
}

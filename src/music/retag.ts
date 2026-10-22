/**
 * `music retag`：把已经下载好的歌，按**当前**规则重写标签和落盘路径。
 *
 * ## 为什么需要
 *
 * 落盘规则改过好几轮（合作曲归到主艺术家、群星合辑归到 `合辑/`、新增
 * `{primary_artist}`），但这些改动只对新下载生效。已经下好的几千首还停在旧目录、
 * 旧标签上 —— 播放器里同一张专辑仍然散成好几张。
 *
 * ## 三条安全边界（都是"删改用户真实文件"，不能图省事）
 *
 * 1. **默认只预览，不落盘。** 走 `core/confirm.ts` 那套：第一次调用只返回
 *    「哪些要动、动到哪」，带一次性令牌再调一次才真的改。
 * 2. **先算完全部目标路径，确认无冲突才动手。** 冲突包括：目标已存在且不是自己、
 *    两个源指向同一个目标（大小写不敏的文件系统上 `Idol` / `idol` 会撞）、
 *    目标路径逃出音乐目录。任何一条命中就整批拒绝，不做"改了一半"。
 * 3. **写标签保音频字节。** 复用 `writeTags`，写前写后比 `audioPayload` 的哈希，
 *    和下载时同一条铁律。歌词、封面从原文件里读回来带上，否则整块替换会丢。
 *
 * ## 为什么按"专辑"分组而不是按曲目
 *
 * 专辑艺术家（以及合辑判定）是**专辑级**属性：同一张专辑里的歌必须算出同一个
 * albumartist，否则播放器里又散开。所以先把曲目按专辑归组，每组查一次专辑信息，
 * 组内共用。这也顺带把专辑查询从 N 次降到「专辑数」次。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { albumArtistsFor, isCompilation, primaryArtist } from './album-artist.ts'
import { templateFor } from './download.ts'
import { getConfig, musicRoot } from '../core/config.ts'
import { renderTemplate, resolveInside } from './paths.ts'
import { audioPayload, extractCoverArt, readTags, writeTags, type TagData } from './tags.ts'
import { albumInfo, songDetail, type AlbumInfo } from './netease.ts'
import { updateTrackPath, type LibraryTrack } from './library.ts'
import { probeFile } from './audio.ts'
import { progress } from '../core/output.ts'

/** 落盘模板里 `{source}` 用不了 —— 重下才知道来源。用这个占位，保持一致。 */
const SOURCE_UNKNOWN = 'unknown'

export interface RetagPlanItem {
  id: string
  title: string
  artists: string[]
  album: string | null
  /** 当前文件路径。 */
  from: string
  /** 按当前规则算出来的目标路径。 */
  to: string
  albumArtist: string[]
  compilation: boolean
  /** 标签会有变化吗（标题/歌手/专辑艺术家/合辑归属）。 */
  tagsChange: boolean
  /** 路径会变化吗。 */
  moves: boolean
  /** 什么都不用做。 */
  unchanged: boolean
  /** 这一项做不了的原因（文件缺失、读不出来等）。 */
  problem: string | null
}

export interface RetagPlan {
  items: RetagPlanItem[]
  /** 整批不能执行的硬冲突；非空时不允许带令牌执行。 */
  conflicts: string[]
  summary: {
    total: number
    moves: number
    tagsChange: number
    unchanged: number
    problems: number
    compilation: number
  }
}

export interface RetagOptions {
  /** 只看这些曲目；不传就是全库。 */
  tracks?: LibraryTrack[]
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

/**
 * 算出完整的迁移计划。**只读，不动任何文件。**
 *
 * 把它和"执行"分开，是因为预览阶段就要把冲突全查出来 —— 用户看到"要动 2000 首"
 * 之前，得先知道其中有没有会撞车的。
 */
export async function planRetag(options: RetagOptions = {}): Promise<RetagPlan> {
  const tracks = options.tracks ?? (await import('./library.ts')).allTracks()
  const root = musicRoot()

  // 按专辑归组：albumartist / 合辑判定是专辑级属性，同组必须算出同一个值
  const groups = new Map<string, LibraryTrack[]>()
  for (const track of tracks) {
    // 专辑 id 不在曲库里，只能靠「专辑名 + 第一位歌手」近似归组。
    // 拿不准时宁可多查一次专辑接口，也不能让同专辑的歌算出不同 albumartist。
    const key = `${track.album ?? ''}\u0000${track.artists[0] ?? ''}`
    const list = groups.get(key) ?? []
    list.push(track)
    groups.set(key, list)
  }

  const items: RetagPlanItem[] = []
  let done = 0

  for (const [, group] of groups) {
    let album: AlbumInfo | null = null
    let identityMismatch: { id: string; stored: string; actual: string } | null = null
    // 专辑信息用来判合辑、取公司/年份；查不到就按普通专辑走（albumArtistsFor 会退回曲目歌手）
    const sample = group[0]!
    try {
      const detail = await songDetail(sample.id, options.signal)
      // **先核对这一条记录是不是真的对得上这个 id。**
      // 曲库里的 native_id 会过期（改过名、手改过库、记录从别的机器搬来），
      // 而网易云的 id 是会被复用的另一首歌 —— 实测随便编一个 999001 就查到了
      // Anouar Brahem 的《Claquem les voiles》。不核对就会把用户的文件
      // 搬进一个完全不相干的歌手目录，这比不整理糟得多。
      if (!sameRecording(sample, detail)) {
        album = null
        identityMismatch = { id: sample.id, stored: sample.title, actual: detail.title }
      } else if (detail.albumId) {
        album = (await albumInfo(detail.albumId, options.signal)).album
      }
    } catch {
      album = null
    }

    for (const track of group) {
      done += 1
      options.onProgress?.(done, tracks.length)
      const planned = await planOne(track, album, root)
      // 身份对不上的组，整组按"查不到专辑"处理：只用曲目自己的歌手，
      // 绝不因为一个可疑的 id 把文件搬到陌生歌手名下。但仍然允许移动
      // （用户可能就是要按正确歌手名整理），只在结果里明确标出来。
      items.push(identityMismatch && !planned.problem
        ? {
            ...planned,
            problem: `曲库记录的 id 对不上：库里是「${identityMismatch.stored}」，网易云 ${identityMismatch.id} 是「${identityMismatch.actual}」。跳过这一组，先用 \`music have --refresh\` 核对`,
            // 判成问题的条目不该再声称"要移动" —— 计划和执行两个阶段的判据必须一致，
            // 否则预览里显示"要搬 1 个"而实际一个都不搬。
            moves: false,
            tagsChange: false,
          }
        : planned)
    }
  }

  const conflicts = findConflicts(items)
  const summary = {
    total: items.length,
    moves: items.filter((i) => i.moves && !i.problem).length,
    tagsChange: items.filter((i) => i.tagsChange && !i.problem).length,
    unchanged: items.filter((i) => i.unchanged).length,
    problems: items.filter((i) => i.problem !== null).length,
    compilation: items.filter((i) => i.compilation).length,
  }
  return { items, conflicts, summary }
}

async function planOne(track: LibraryTrack, album: AlbumInfo | null, root: string): Promise<RetagPlanItem> {
  const base: RetagPlanItem = {
    id: track.id,
    title: track.title,
    artists: track.artists,
    album: track.album,
    from: track.path,
    to: track.path,
    albumArtist: [],
    compilation: false,
    tagsChange: false,
    moves: false,
    unchanged: false,
    problem: null,
  }

  if (!existsSync(track.path)) return { ...base, problem: '文件不存在（可能被删或挪走了，可用 `music have --refresh` 核对）' }

  const albumScope = { albumArtists: album?.artists ?? null, albumId: album?.id ?? null }
  const albumArtists = albumArtistsFor({ ...albumScope, trackArtists: track.artists })
  const compilation = isCompilation(albumScope)

  const vars = {
    artist: track.artists.join(', '),
    artist_list: track.artists.join(';'),
    albumartist: albumArtists.join(', '),
    primary_artist: primaryArtist(track.artists),
    album: track.album ?? '未知专辑',
    title: track.title,
    year: '',
    track: '',
    disc: '',
    // 重下才知道音源；用固定占位，避免每次 retag 算出不同路径
    source: SOURCE_UNKNOWN,
    ext: path.extname(track.path).replace('.', ''),
  }

  let relative: string
  try {
    // 复用下载时那一份模板函数，合辑的归置规则（`合辑/{album}/{文件名}`）才和下载一致
    relative = renderTemplate(
      templateFor({ template: getConfig('music.template'), compilationDir: getConfig('music.compilation-dir'), compilation }),
      vars,
    )
  } catch (err) {
    return { ...base, albumArtist: albumArtists, compilation, problem: `模板渲染失败：${(err as Error).message}` }
  }

  let target: string
  try {
    target = resolveInside(root, relative)
  } catch {
    return { ...base, albumArtist: albumArtists, compilation, problem: '目标路径会逃出音乐目录，拒绝改' }
  }

  // 标签层面有没有变化：只看专辑艺术家 —— 标题、歌手、专辑名原本就不会变，
  // 重写的只是归档归属（合作曲归主艺术家、群星归 Various Artists）。
  // 和曲目第一位歌手比对：两者一样说明这条标签本来就是对的。
  const primary = track.artists[0] ?? ''
  const tagsChange = albumArtists.length > 0 && albumArtists.join('\u0000') !== primary

  return {
    ...base,
    to: target,
    albumArtist: albumArtists,
    compilation,
    tagsChange,
    moves: path.resolve(target) !== path.resolve(track.path),
  }
}

/**
 * 曲库记录和接口返回的是不是同一首歌。
 *
 * 只比标题 + 第一位歌手，都是归一化后比（标题里的括号附注、全半角、空格标点都不算差异）。
 * 比时长更稳的字段没有 —— 曲库里存的时长本身来自同一次查询，比它等于自己比自己。
 *
 * 标题或歌手任一为空时**判为一致**：宁可放过一次「其实对不上」，
 * 也不能因为接口少给一个字段就把整批文件判成危险、什么都不做。
 */
function sameRecording(stored: { title: string; artists: string[] }, actual: { title: string; artists: string[] }): boolean {
  if (!stored.title.trim() || !actual.title.trim()) return true
  if (normalizeTitle(stored.title) !== normalizeTitle(actual.title)) return false
  const a = stored.artists[0]?.trim()
  const b = actual.artists[0]?.trim()
  if (!a || !b) return true
  return normalizeTitle(a) === normalizeTitle(b)
}

/** 两组歌手名字是不是同一批（忽略顺序与空项）。用于判断"标签要不要重写"。 */
function sameArtistSet(a: string[], b: string[]): boolean {
  const norm = (list: string[]): string[] => [...new Set(list.map((x) => normalizeTitle(x)).filter(Boolean))].sort()
  const left = norm(a)
  const right = norm(b)
  return left.length === right.length && left.every((x, i) => x === right[i])
}

/** 标题/歌手归一化：去括号附注、NFKC、小写、去空白与标点。和去重指纹用的是同一套口径。 */
function normalizeTitle(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[(（[【].*?[)）\]】]/g, '')
    .replace(/[\s·・\-_'"“”‘’`~!！?？,，.。:：;；()（）[\]【】<>《》/\\|]+/g, '')
}

/**
 * 查整批计划的冲突。任何一条命中都返回，调用方据此拒绝执行。
 *
 * 三类：
 * - **目标已被别的文件占着**：会覆盖掉不认识的歌
 * - **两个源指向同一目标**：后写的会把先写的顶掉，等于凭空少一首
 * - **同一首歌判定对不上**：源和目标都不存在（不该发生，防逻辑错）
 */
function findConflicts(items: RetagPlanItem[]): string[] {
  const conflicts: string[] = []
  const targets = new Map<string, RetagPlanItem[]>()

  for (const item of items) {
    if (item.problem) continue
    const key = normalizeForCompare(item.to)
    const list = targets.get(key) ?? []
    list.push(item)
    targets.set(key, list)
  }

  for (const [, list] of targets) {
    if (list.length > 1) {
      conflicts.push(
        `${list.length} 首歌算出了同一个目标路径：${list[0]!.to}（${list.map((i) => i.title).join(' / ')}）`,
      )
    }
  }

  for (const item of items) {
    if (item.problem || !item.moves) continue
    if (!existsSync(item.to)) continue
    // 目标存在，且不是这一组的任何源 —— 那就是一份不认识的同名文件
    if (path.resolve(item.to) === path.resolve(item.from)) continue
    const owners = targets.get(normalizeForCompare(item.to)) ?? []
    const isOwnSource = owners.some((o) => path.resolve(o.from) === path.resolve(item.to))
    if (!isOwnSource) conflicts.push(`目标位置已经有文件了，不会覆盖：${item.to}（来自 ${item.title}）`)
  }

  return conflicts
}

/**
 * 大小写不敏的文件系统（Windows / 默认的 macOS）上，`Idol` 和 `idol` 是同一个文件。
 * 冲突检测要按这个口径比，否则真到 rename 才发现撞了。
 */
function normalizeForCompare(p: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p
}

/**
 * 找同一首歌旁边的同步歌词文件。
 *
 * `.word.lrc`（逐字 `<mm:ss.xx>`）优先，其次 `.lrc`（`[mm:ss.xx]`）。
 * 只认带时间戳的 —— 纯文本文件带回去没有意义，内嵌要的就是时间轴。
 * 都不存在或都是纯文本时返回 null，调用方沿用原标签。
 */
export async function syncedLyricsFor(audioPath: string): Promise<string | null> {
  const base = audioPath.replace(/\.[^.]+$/, '')
  for (const ext of ['.word.lrc', '.lrc']) {
    const file = base + ext
    if (!existsSync(file)) continue
    const text = await readFile(file, 'utf8').catch(() => null)
    if (!text) continue
    // 有时间戳才算数：`[mm:ss.xx]` 或逐字的 `<mm:ss.xx>`
    if (/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(text)) return text
  }
  return null
}

export interface RetagExecuteResult {
  moved: number
  tagged: number
  failed: { id: string; title: string; reason: string }[]
  skipped: number
}

/**
 * 执行计划。**调用前必须已经处理过 conflicts。**
 *
 * 顺序是「先写标签到原位置 → 再移动」。反过来的话，移动过程中出错会留下
 * "路径已经变了但标签还是旧的"的中间状态，重跑也认不出来。
 */
export async function executeRetag(plan: RetagPlan, options: { signal?: AbortSignal } = {}): Promise<RetagExecuteResult> {
  const result: RetagExecuteResult = { moved: 0, tagged: 0, failed: [], skipped: 0 }
  const pending = plan.items.filter((i) => !i.problem && (i.moves || i.tagsChange))

  for (const item of pending) {
    if (options.signal?.aborted) break
    try {
      const changed = await retagOne(item)
      if (changed.tagged) result.tagged += 1
      if (changed.moved) result.moved += 1
      if (!changed.tagged && !changed.moved) result.skipped += 1
    } catch (err) {
      result.failed.push({ id: item.id, title: item.title, reason: (err as Error).message })
    }
  }
  return result
}

/**
 * 处理一首：写标签 → 移动 → 更新曲库记录。
 *
 * 写标签刻意保留原文件里的歌词与封面。`writeTags` 是整块替换，
 * 不带过去就丢了 —— 歌词重下要联网，封面重下可能平台已经换图。
 */
async function retagOne(item: RetagPlanItem): Promise<{ tagged: boolean; moved: boolean }> {
  const original = await readFile(item.from)
  const existing = readTags(original)
  const cover = extractCoverArt(original)
  const probe = await probeFile(item.from, null)
  if (probe.problem) throw new Error(`不是可识别的音频：${probe.problem}`)

  const albumName = item.album
  const tags: TagData = {
    title: item.title,
    artists: item.artists,
    album: albumName,
    albumArtists: item.albumArtist,
    date: null,
    trackNo: null,
    trackTotal: null,
    discNo: null,
    publisher: null,
    // 歌词：优先从同目录的 `.word.lrc` / `.lrc` 换一份带时间戳的。
    //
    // 直接沿用 `existing.lyrics` 会把老文件里的纯文本原样写回去 ——
    // 那是 v0.12.4 之前写进去的，播放器解析不出滚动歌词，等于把这次修复抵消掉。
    // 两边都没有（或就是纯文本）才退回原值，至少不丢歌词。
    lyrics: await syncedLyricsFor(item.from) ?? existing.lyrics,
    cover,
    source: { platform: 'netease', id: item.id },
  }

  let tagged = false
  if (probe.format === 'mp3' || probe.format === 'flac') {
    const before = createHash('sha256').update(audioPayload(original, probe.format)).digest('hex')
    // writeTags 自己会写临时文件再 rename；这里只需要校验它没动音频字节
    const written = await writeTags(item.from, probe.format, tags)
    if (written.written) {
      const after = createHash('sha256').update(audioPayload(await readFile(item.from), probe.format)).digest('hex')
      if (after !== before) throw new Error('写标签改动了音频数据，已放弃')
      tagged = true
      progress('music.retag.tags', { id: item.id, title: item.title })
    } else if (written.reason) {
      throw new Error(written.reason)
    }
  }

  let moved = false
  if (item.moves) {
    await mkdir(path.dirname(item.to), { recursive: true })
    await rename(item.from, item.to)
    moved = true
    progress('music.retag.move', { id: item.id, from: item.from, to: item.to })
    // 同名 .lrc / .word.lrc 跟着走，不然歌词留在原地等于丢了
    for (const ext of ['.lrc', '.word.lrc']) {
      const sidecar = item.from.replace(/\.[^.]+$/, ext)
      if (!existsSync(sidecar)) continue
      try {
        await rename(sidecar, item.to.replace(/\.[^.]+$/, ext))
      } catch {
        // 歌词搬不动不该让整首歌算失败
      }
    }
  }

  // 曲库记录跟着走，否则 `music have` 会说文件缺失
  const info = await stat(moved ? item.to : item.from)
  updateTrackPath('netease', item.id, moved ? item.to : item.from, info.size)
  return { tagged, moved }
}

/**
 * `bili audio`：把一个 UP / 合集整体转成音乐库。
 *
 * 为什么需要它：给 o叔 建音乐子库时，319 首是在外部循环调
 * `astra bili get <bv> --audio-only` 完成的，中间还得
 * ① 用 `ASTRA_MUSIC_DIR` 临时把文件导到别处 ② 事后数文件发现丢了 39 首
 * ③ 写补下脚本 ④ 写脚本重刷标签。换一个 UP 就重来一遍。
 *
 * 这里的每一步都是"已经在 astra 里、但没串起来"的能力：
 * 投稿列表（`spaceVideos`）、音频下载（`downloadPage --audio-only`）、
 * 同名消歧（`resolveTargetPath`）、标签写入（`writeTags`）。
 *
 * ## 关键设计
 *
 * - **先报数再下载**：`投稿 322 / 排除 3 / 待下 319`，让用户在下之前就能判断
 * - **增量**：已存在（同 bvid）跳过，所以连跑两次第二次是 0 下载
 * - **失败不中断**：单个视频失败记进 failed，其余照跑
 * - **并发有上限**：默认 4，遇到 412 / 风控自动降到 1
 */
import { progress } from '../core/output.ts'
import { fetchInfo, downloadPage, probePath, targetPathFor } from './download.ts'
import { renderTemplate } from '../core/template.ts'
import { resolveInside } from '../core/template.ts'
import { spaceVideos } from './space.ts'
import { parseCollectionRef, fetchSeriesArchives, fetchSeasonArchives, fetchFavorite } from './collection.ts'

export interface AudioSyncOptions {
  /** UP 的 mid、`season:<sid>`、`fav:<id>`，或合集链接。 */
  target: string
  /** 排除正则（标题匹配就跳过）。 */
  exclude?: string | null
  /** 专辑名（TALB）；不给用 UP 名。 */
  album?: string | null
  /** 最多取多少个投稿。 */
  limit?: number
  /** 只报计划，不下载。 */
  dry?: boolean
  /** 并发数。 */
  concurrency?: number
  signal?: AbortSignal
  /** 进度回调（测试与 stderr 用）。 */
  onProgress?: (event: { phase: 'plan' | 'download'; done: number; total: number; bvid?: string }) => void
}

export interface AudioSyncItem {
  bvid: string
  title: string
  durationSec: number | null
}

export interface AudioSyncResult {
  /** 投稿总数（排除前）。 */
  total: number
  /** 被 --exclude 过滤掉的。 */
  excluded: number
  /** 计划下载的。 */
  planned: number
  downloaded: { bvid: string; title: string; path: string }[]
  /** 已存在而跳过的。 */
  skipped: { bvid: string; title: string }[]
  failed: { bvid: string; title: string; error: string }[]
  /** 因重名改过名的。 */
  renamed: { bvid: string; from: string; to: string }[]
  /** 计划里有、但既没下载也没跳过也没失败的（理论上为空，用于对账）。 */
  missing: string[]
}

/** 从各种输入里认出是哪个 UP / 合集。 */
export async function resolveAudioSource(
  target: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ kind: 'space' | 'collection'; mid: string | null; items: AudioSyncItem[]; title: string }> {
  const trimmed = target.trim()

  // 纯数字 = UP 的 mid
  if (/^\d+$/.test(trimmed)) {
    const result = await spaceVideos(trimmed, '', limit, signal)
    return {
      kind: 'space',
      mid: trimmed,
      title: `UP ${trimmed}`,
      items: result.videos.map((v) => ({ bvid: v.bvid, title: v.title, durationSec: v.durationSec })),
    }
  }

  // 合集 / 系列 / 收藏夹
  const ref = parseCollectionRef(trimmed)
  if (ref.kind !== null) {
    const collection = ref.kind === 'fav'
      ? await fetchFavorite(ref.id, limit, signal)
      : ref.kind === 'series'
        ? await fetchSeriesArchives(ref.mid, ref.seriesId, limit, signal)
        : await fetchSeasonArchives(ref.mid, ref.seasonId, limit, signal)
    return {
      kind: 'collection',
      mid: ref.kind === 'fav' ? null : ref.mid,
      title: collection.title,
      items: collection.items.map((v) => ({ bvid: v.bvid, title: v.title, durationSec: v.durationSec })),
    }
  }

  // 空间页链接：`space.bilibili.com/12345`
  const fromUrl = trimmed.match(/space\.bilibili\.com\/(\d+)/)
  if (fromUrl) {
    const result = await spaceVideos(fromUrl[1]!, '', limit, signal)
    return {
      kind: 'space',
      mid: fromUrl[1]!,
      title: `UP ${fromUrl[1]}`,
      items: result.videos.map((v) => ({ bvid: v.bvid, title: v.title, durationSec: v.durationSec })),
    }
  }

  throw new Error(`认不出这是哪个 UP 或合集：${trimmed.slice(0, 40)}`)
}

/**
 * 按 `--exclude` 过滤。
 *
 * 正则写错时**抛错而不是静默跳过全部** —— "排除 322 / 待下 0" 看着像正常，
 * 实际是正则坏了，那种静默最要命。
 */
export function filterByExclude<T extends { title: string }>(
  items: T[],
  pattern: string | null | undefined,
): { kept: T[]; excluded: T[] } {
  if (!pattern || !pattern.trim()) return { kept: items, excluded: [] }
  let re: RegExp
  try {
    re = new RegExp(pattern, 'i')
  } catch (err) {
    throw new Error(`--exclude 不是合法正则：${(err as Error).message}`)
  }
  const kept: T[] = []
  const excluded: T[] = []
  for (const item of items) (re.test(item.title) ? excluded : kept).push(item)
  return { kept, excluded }
}

/** 不下载、只算"这个视频会落到哪、那儿现在有没有东西"。 */
async function previewTargetPath(
  info: Awaited<ReturnType<typeof fetchInfo>>,
  page: NonNullable<Awaited<ReturnType<typeof fetchInfo>>['pages'][number]>,
  album: string | null,
): Promise<{ path: string; exists: boolean; ownedByBvid: boolean }> {
  void album
  const { root, template, vars } = targetPathFor(info, page, { audioOnly: true }, 80)
  const target = resolveInside(root, renderTemplate(template, vars))
  const occ = probePath(target, info.bvid)
  return {
    path: target,
    exists: occ.state !== 'free',
    ownedByBvid: occ.state === 'same',
  }
}

/**
 * 跑完整流程。
 *
 * 增量判断不靠自己扫目录 —— 交给 `downloadPage` 里的 `resolveTargetPath`：
 * 它先按模板算出目标路径，再用"文件名 bvid → 标签 SOURCE_ID"认归属，
 * 同一个 bvid 就覆盖自己、不同 bvid 就消歧。这套逻辑在 2e 已经验过，
 * 这里再实现一遍只会分叉。
 */
export async function runAudioSync(options: AudioSyncOptions): Promise<AudioSyncResult> {
  const limit = options.limit ?? 2000
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 4))
  const signal = options.signal

  const source = await resolveAudioSource(options.target, limit, signal)
  const { kept, excluded } = filterByExclude(source.items, options.exclude)

  const result: AudioSyncResult = {
    total: source.items.length,
    excluded: excluded.length,
    planned: kept.length,
    downloaded: [],
    skipped: [],
    failed: [],
    renamed: [],
    missing: [],
  }

  options.onProgress?.({ phase: 'plan', done: 0, total: kept.length })
  progress('bili.audio.plan', {
    source: source.title,
    total: result.total,
    excluded: result.excluded,
    planned: result.planned,
  })

  if (options.dry === true) return result

  // 并发上限：B 站对同一账号的并发请求有风控（实测 412）。
  // 撞上了就把**后续批次**降到 1，已经跑完的不管 —— 比全军覆没强。
  let batchSize = concurrency
  let done = 0

  /**
   * 下一项下载。返回 'skipped' 表示它本来就在（同 bvid 同路径）。
   *
   * 怎么区分"下了"和"本来就在"：`downloadPage` 会先算目标路径、
   * 再判断那个路径归谁。如果是同一个 bvid（标签里的 SOURCE_ID 对得上），
   * 它会照常重下一遍覆盖自己 —— 从外面看是分不出来的。
   *
   * 所以这里**下之前先探一次**：目标文件已存在且属于这个 bvid，就当跳过。
   * 这比等到下完再猜准。
   */
  const planOne = async (item: AudioSyncItem): Promise<{ kind: 'skip' } | { kind: 'go'; pageIndex: number; path: string }> => {
    const info = await fetchInfo(item.bvid, signal)
    const page = info.pages[0]
    if (!page) throw new Error('没有分 P')
    const preview = await previewTargetPath(info, page, options.album ?? null)
    if (preview.exists && preview.ownedByBvid) return { kind: 'skip' }
    return { kind: 'go', pageIndex: 0, path: preview.path }
  }

  const runOne = async (item: AudioSyncItem): Promise<void> => {
    try {
      const plan = await planOne(item)
      if (plan.kind === 'skip') {
        result.skipped.push({ bvid: item.bvid, title: item.title })
        return
      }
      const info = await fetchInfo(item.bvid, signal)
      const r = await downloadPage(info, plan.pageIndex, {
        quality: 80,
        audioOnly: true,
        ...(options.album ? { album: options.album } : {}),
        ...(signal ? { signal } : {}),
      })
      result.downloaded.push({ bvid: item.bvid, title: item.title, path: r.path })
      if (r.renamedFrom) result.renamed.push({ bvid: item.bvid, from: r.renamedFrom, to: r.path })
    } catch (err) {
      const message = (err as Error).message ?? ''
      // 412 / 风控：后续批次降速
      if (/412|风控|too many|频繁/i.test(message)) batchSize = 1
      result.failed.push({ bvid: item.bvid, title: item.title, error: message.slice(0, 160) })
    } finally {
      done += 1
      options.onProgress?.({ phase: 'download', done, total: kept.length, bvid: item.bvid })
      progress('bili.audio.progress', { done, total: kept.length, bvid: item.bvid })
    }
  }

  // 按批并发。用批而不是常驻 worker 池：风控降速时能干净地缩小批次，
  // 不用去停已经在跑的 worker。
  for (let i = 0; i < kept.length && !signal?.aborted; i += batchSize) {
    const batch = kept.slice(i, i + batchSize)
    await Promise.all(batch.map((item) => runOne(item)))
  }

  // 对账：计划里的每一项都该有归宿
  const accounted = new Set([
    ...result.downloaded.map((d) => d.bvid),
    ...result.skipped.map((s) => s.bvid),
    ...result.failed.map((f) => f.bvid),
  ])
  result.missing = kept.filter((k) => !accounted.has(k.bvid)).map((k) => k.bvid)

  return result
}

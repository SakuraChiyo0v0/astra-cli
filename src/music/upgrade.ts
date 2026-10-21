/**
 * 音质升级：找出"现在能下载到比库里更好版本"的歌，并批量重下。
 *
 * 关键区别（这也是为什么不能只看 `--low`）：
 * **低规格 ≠ 能升级**。很多歌的母带本来就是 16bit / 44.1k，换哪个源都一样；
 * 实测一份 15 首的曲库里，12 首"低于 24bit"，逐首问官方后发现**没有一首真能升**。
 *
 * 所以这里的做法是：先问一次"现在能拿到什么"，真的比库里好才列为可升级。
 * 代价是要多打一轮接口（每首一次），收益是不做无用功、不误导用户。
 */
import { AstraError } from '../core/errors.ts'
import { progress } from '../core/output.ts'
import { qualityRank, type Quality } from './audio.ts'
import { officialUrl } from './official.ts'
import { songDetail, type Track } from './netease.ts'
import { allTracks, type LibraryTrack } from './library.ts'

export interface UpgradeCandidate {
  ref: string
  title: string
  artists: string[]
  /** 库里现在的：档位 + 规格。 */
  current: { quality: Quality; sampleRate: number | null; bitsPerSample: number | null; bitrateKbps: number | null }
  /** 现在能从官方拿到的最高档。 */
  available: { quality: Quality; sampleRate: number | null; bitsPerSample: number | null; bitrateKbps: number | null }
  /** 为什么判为可升级。 */
  reason: string
}

export interface ScanResult {
  /** 扫了多少首。 */
  scanned: number
  candidates: UpgradeCandidate[]
  /** 查了但结论是"升不了"的，附带原因，供用户理解为什么没列进来。 */
  noUpgrade: { title: string; reason: string }[]
}

/** 一份规格快照，用于比较"库里"与"现在能拿到"。 */
export interface SpecSnapshot {
  quality: Quality
  sampleRate: number | null
  bitsPerSample: number | null
  bps: number | null
}

/**
 * 现在能拿到的，是否真的比库里好。
 *
 * 判据（依次）：
 * 1. 档位更高
 * 2. 同档位下采样率更高
 * 3. 同档位同位深下码率明显更高（>10%，防编码抖动误判）
 *
 * **缺字段一律当"更差"**：不知道就不升，避免把好文件换成差的。
 */
export function isUpgrade(current: SpecSnapshot, available: SpecSnapshot): boolean {
  if (qualityRank(available.quality) < qualityRank(current.quality)) return true
  if (available.quality !== current.quality) return false
  if ((available.sampleRate ?? 0) > (current.sampleRate ?? 0)) return true
  if ((available.bitsPerSample ?? 0) > (current.bitsPerSample ?? 0)) return true
  return (available.bps ?? 0) > (current.bps ?? 0) * 1.1
}

/** 库里比这个低的才值得看一眼（24bit 已是当前能拿到的上限）。 */
function worthChecking(track: LibraryTrack): boolean {
  if (track.missing) return false
  if (track.quality === '24bit') return false
  return true
}

function bitrateOf(bps: number | null): number | null {
  return bps ? Math.round(bps / 1000) : null
}

/**
 * 扫描曲库，找出真正能升级的。
 *
 * `limit` 控制最多查多少首（每首一次网络请求，曲库大时别一次全查）。
 */
export async function scanUpgradable(limit: number, signal?: AbortSignal): Promise<ScanResult> {
  const all = allTracks().filter(worthChecking)
  const targets = all.slice(0, limit)
  const candidates: UpgradeCandidate[] = []
  const noUpgrade: { title: string; reason: string }[] = []

  for (const [index, entry] of targets.entries()) {
    if (signal?.aborted) break
    progress('upgrade.scan', { index: index + 1, total: targets.length, title: entry.title })
    let track: Track
    try {
      track = await songDetail(entry.id, signal)
    } catch (err) {
      noUpgrade.push({ title: entry.title, reason: `查不到歌曲：${(err as Error).message.slice(0, 80)}` })
      continue
    }

    // 问官方现在能拿到什么（不需要真下载，只要地址和元信息）
    let available: Awaited<ReturnType<typeof officialUrl>>
    try {
      available = await officialUrl(track, '24bit', signal)
    } catch (err) {
      noUpgrade.push({ title: entry.title, reason: `取链失败：${(err as Error).message.slice(0, 80)}` })
      continue
    }
    if ('skip' in available) {
      noUpgrade.push({ title: entry.title, reason: `官方拿不到：${available.skip}` })
      continue
    }

    const newer = available.probe
    const betterRank = qualityRank(newer.quality) < qualityRank(entry.quality)
    const upgrade = isUpgrade(
      { quality: entry.quality, sampleRate: entry.spec.sampleRate, bitsPerSample: entry.spec.bitsPerSample, bps: entry.bps },
      { quality: newer.quality, sampleRate: newer.flac?.sampleRate ?? null, bitsPerSample: newer.flac?.bitsPerSample ?? null, bps: newer.bps },
    )

    if (!upgrade) {
      noUpgrade.push({ title: entry.title, reason: `官方也只能给到 ${newer.quality}${newer.flac ? `（${Math.round(newer.flac.sampleRate / 1000)}k/${newer.flac.bitsPerSample}bit）` : ''}` })
      continue
    }

    candidates.push({
      ref: `${entry.platform}:${entry.id}`,
      title: entry.title,
      artists: entry.artists,
      current: {
        quality: entry.quality,
        sampleRate: entry.spec.sampleRate,
        bitsPerSample: entry.spec.bitsPerSample,
        bitrateKbps: bitrateOf(entry.bps),
      },
      available: {
        quality: newer.quality,
        sampleRate: newer.flac?.sampleRate ?? null,
        bitsPerSample: newer.flac?.bitsPerSample ?? null,
        bitrateKbps: bitrateOf(newer.bps),
      },
      reason: betterRank
        ? `档位更高：${entry.quality} → ${newer.quality}`
        : `同档位规格更好：${Math.round((entry.spec.sampleRate ?? 0) / 1000)}k/${entry.spec.bitsPerSample ?? '?'}bit → ${Math.round((newer.flac?.sampleRate ?? 0) / 1000)}k/${newer.flac?.bitsPerSample ?? '?'}bit`,
    })
  }

  return { scanned: targets.length, candidates, noUpgrade }
}

/** 把候选转成下载任务需要的曲目信息。 */
export async function loadCandidateTracks(candidates: UpgradeCandidate[], signal?: AbortSignal): Promise<Track[]> {
  const ids = candidates.map((c) => c.ref.split(':')[1] ?? '').filter(Boolean)
  const tracks: Track[] = []
  for (const id of ids) {
    try {
      tracks.push(await songDetail(id, signal))
    } catch {
      // 单首失败不阻塞其它
    }
  }
  if (tracks.length === 0) throw new AstraError('NOTHING_TO_UPGRADE', '候选里没有能重新下载的歌', { exitCode: 4 })
  return tracks
}

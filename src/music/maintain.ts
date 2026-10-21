/**
 * 曲库维护：回读文件补齐规格、检查配套文件。
 *
 * 老记录只有档位名（`flac`），没有采样率 / 位深。这里直接读文件头补上，
 * 顺便核对封面、歌词、逐字歌词还在不在 —— 这些都可能被手动删过。
 */
import { existsSync, readFileSync } from 'node:fs'
import { progress } from '../core/output.ts'
import { probeFile } from './audio.ts'
import { hasCoverArt } from './tags.ts'
import { allTracks, updateTrackSpec, type LibraryTrack } from './library.ts'

export interface RefreshResult {
  checked: number
  updated: number
  missing: number
  /** 规格有变化的条目，供调用方展示。 */
  changed: { ref: string; title: string; spec: string; quality: string }[]
}

function specLabel(sampleRate: number | null, bits: number | null): string {
  if (!sampleRate || !bits) return '未知'
  return `${Math.round((sampleRate / 1000) * 10) / 10}kHz/${bits}bit`
}

export async function refreshLibrarySpecs(tracks?: LibraryTrack[]): Promise<RefreshResult> {
  const list = tracks ?? allTracks()
  const result: RefreshResult = { checked: 0, updated: 0, missing: 0, changed: [] }
  for (const track of list) {
    result.checked += 1
    if (!existsSync(track.path)) {
      result.missing += 1
      continue
    }
    let probe
    try {
      probe = await probeFile(track.path, track.durationMs)
    } catch {
      continue
    }
    if (probe.problem) continue

    const spec = {
      sampleRate: probe.flac?.sampleRate ?? null,
      bitsPerSample: probe.flac?.bitsPerSample ?? null,
      channels: probe.flac?.channels ?? null,
    }
    // 配套文件：同名换扩展名
    const base = track.path.replace(/\.[^.]+$/, '')
    const hasLyric = ['.lrc', '.word.lrc'].some((ext) => existsSync(base + ext))
    const hasWordLyric = existsSync(base + '.word.lrc')
    // 封面在 FLAC 的 PICTURE 块 / MP3 的 APIC 帧里，不在文本标签里
    const hasCover = (() => {
      try {
        return hasCoverArt(readFileSync(track.path))
      } catch {
        return false
      }
    })()

    const sizeChanged = probe.bytes !== null && probe.bytes !== track.bytes
    const specChanged = spec.sampleRate !== track.spec.sampleRate || spec.bitsPerSample !== track.spec.bitsPerSample
    const qualityChanged = probe.quality !== track.quality
    const sideChanged = track.hasLyric !== hasLyric || track.hasWordLyric !== hasWordLyric || track.hasCover !== hasCover

    if (!specChanged && !qualityChanged && !sideChanged && !sizeChanged) continue

    updateTrackSpec(track.platform, track.id, {
      spec,
      bytes: probe.bytes,
      bps: probe.bps,
      quality: probe.quality,
      hasLyric,
      hasWordLyric,
      hasCover,
    })
    result.updated += 1
    result.changed.push({ ref: `${track.platform}:${track.id}`, title: track.title, spec: specLabel(spec.sampleRate, spec.bitsPerSample), quality: probe.quality })
    progress('library.refresh', { id: track.id, spec: specLabel(spec.sampleRate, spec.bitsPerSample), quality: probe.quality })
  }
  return result
}

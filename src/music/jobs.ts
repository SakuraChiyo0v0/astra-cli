/**
 * 音乐域的批量任务：只负责"一首歌怎么处理"，生命周期交给 `core/jobs.ts`。
 *
 * 歌单 / 专辑 / 歌手 / 每日推荐 / 红心的批量下载都走这里。
 */
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { db } from '../core/db.ts'
import { getConfig } from '../core/config.ts'
import { registerJobHandler, type ItemOutcome, type JobItemView } from '../core/jobs.ts'
import { songDetails, albumInfo, type AlbumInfo, type Track } from './netease.ts'
import { downloadTrack } from './download.ts'
import type { Quality } from './audio.ts'

export const MUSIC_DOMAIN = 'music'

/**
 * 把曲目信息塞进 item 的 meta。
 *
 * worker 是**另一个进程**，内存缓存带不过去；建任务时把详情一起写进库，
 * worker 就完全不必再为每首歌打一次详情接口。
 */
export function jobItemsFor(tracks: Track[], quality: Quality): { id: string; title: string; subtitle: string; meta: Record<string, unknown> }[] {
  return tracks.map((t) => ({
    id: t.id,
    title: t.title,
    subtitle: t.artists.join(' / '),
    meta: { quality, track: t },
  }))
}

function trackFromMeta(meta: Record<string, unknown>): Track | null {
  const raw = meta.track
  return raw && typeof raw === 'object' ? (raw as Track) : null
}

/** "音质：24bit 3 / flac 2 / 128k 5"。热歌榜实测大半只有 128k，用户应该知道。 */
export function qualitySummary(items: JobItemView[]): string {
  const counts = new Map<string, number>()
  for (const i of items) if ((i.status === 'done' || i.status === 'skipped') && i.profile) counts.set(i.profile, (counts.get(i.profile) ?? 0) + 1)
  if (counts.size === 0) return ''
  const order = ['24bit', 'flac', '320k', '128k']
  return '音质：' + [...counts].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([q, n]) => `${q} ${n}`).join(' / ')
}

/** worker 启动时清掉上次被强杀留下的临时文件。 */
async function sweepPartials(): Promise<void> {
  const rows = db().prepare('select file_path from tracks').all() as { file_path: string }[]
  const dirs = new Set(rows.filter((r) => r.file_path).map((r) => path.dirname(r.file_path)))
  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names) {
      if (/\.part-\d+(\.tagging)?$/.test(name)) await rm(path.join(dir, name), { force: true })
    }
  }
}

registerJobHandler(MUSIC_DOMAIN, {
  concurrency: () => Number(getConfig('music.concurrency')) || 2,
  sweep: sweepPartials,
  summary: (items) => [qualitySummary(items)],

  async handle(item, ctx): Promise<ItemOutcome> {
    const meta = item.meta
    const quality = (typeof meta.quality === 'string' ? meta.quality : 'flac') as Quality

    // 建任务时把详情写进了 meta；万一老任务没有，就现查一次
    let track = trackFromMeta(meta)
    if (!track) {
      const fetched = await songDetails([item.id]).catch(() => [] as Track[])
      track = fetched[0] ?? null
    }
    if (!track) throw new Error('网易云已下架这首歌')

    // 同一张专辑只查一次专辑信息（写标签要专辑歌手 / 公司）
    let cache = ctx.shared.get('albumCache') as Map<string, Promise<AlbumInfo | null>> | undefined
    if (!cache) {
      cache = new Map()
      ctx.shared.set('albumCache', cache)
    }

    const result = await downloadTrack(track, { quality, albumCache: cache })
    return {
      status: result.status === 'already_have' ? 'skipped' : 'done',
      profile: result.quality,
      path: result.path,
      note: result.warnings.length > 0 ? result.warnings.join('；') : null,
    }
  },
})

/**
 * B 站域的批量任务：只负责"一个视频怎么下"，生命周期交给 `core/jobs.ts`。
 *
 * 与音乐那边共用同一套 job / job_items 表，业务字段（画质、分 P）放 meta。
 */
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { getConfig, mediaRoot } from '../core/config.ts'
import { registerJobHandler, type ItemOutcome, type JobItemView } from '../core/jobs.ts'
import { downloadPage, fetchInfo } from './download.ts'
import { qualityName } from './sign.ts'

export const BILI_DOMAIN = 'bili'

/** 建任务时把一个视频的分 P 展开成条目。 */
export interface BiliJobItem {
  id: string
  title: string
  subtitle: string
  meta: Record<string, unknown>
}

/** 一组视频（合集 / 收藏夹 / 订阅发现的新视频）直接转成任务项。 */
export function collectionToItems(items: { bvid: string; title: string }[], collectionTitle: string, quality: number): BiliJobItem[] {
  return items.map((v) => ({
    id: v.bvid,
    title: v.title,
    subtitle: collectionTitle,
    meta: { bvid: v.bvid, pageIndex: 0, quality, singlePage: true },
  }))
}

/** 一个 bvid 的若干分 P 展开成 job item；`pages` 为空表示只下第 1 个。 */
export async function biliJobItems(bvid: string, pages: number[] | null, quality: number): Promise<BiliJobItem[]> {
  const info = await fetchInfo(bvid)
  const selected = pages ?? [0]
  return selected
    .filter((i) => i >= 0 && i < info.pages.length)
    .map((i) => {
      const page = info.pages[i]!
      return {
        id: `${bvid}:${page.cid}`,
        title: info.pages.length > 1 ? `${info.title} - P${page.page} ${page.part}` : info.title,
        subtitle: info.owner.name,
        meta: { bvid, pageIndex: i, quality, pageTitle: page.part, singlePage: info.pages.length <= 1 },
      }
    })
}

/** "画质：1080P 5 / 360P 2"。 */
export function qualitySummary(items: JobItemView[]): string {
  const counts = new Map<string, number>()
  for (const i of items) if ((i.status === 'done' || i.status === 'skipped') && i.profile) counts.set(i.profile, (counts.get(i.profile) ?? 0) + 1)
  if (counts.size === 0) return ''
  return '画质：' + [...counts].map(([q, n]) => `${q} ${n}`).join(' / ')
}

/** 清掉上次被强杀留下的临时片段。 */
async function sweepPartials(): Promise<void> {
  const root = mediaRoot()
  const stack = [root]
  let guard = 0
  while (stack.length > 0 && guard < 200) {
    guard += 1
    const dir = stack.pop()!
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name))
        continue
      }
      // download.ts 的临时文件形如 `xxx.mp4.v-123.tmp`
      if (/\.(?:v|a|out)-\d+\.tmp(?:\.mp4|\.m4a)?$/.test(entry.name)) await rm(path.join(dir, entry.name), { force: true })
    }
  }
}

registerJobHandler(BILI_DOMAIN, {
  concurrency: () => Math.max(1, Math.min(3, Number(getConfig('bili.concurrency') ?? '1') || 1)),
  sweep: sweepPartials,
  summary: (items) => [qualitySummary(items)],

  async handle(item, ctx): Promise<ItemOutcome> {
    const meta = item.meta
    const bvid = typeof meta.bvid === 'string' ? meta.bvid : ''
    const pageIndex = typeof meta.pageIndex === 'number' ? meta.pageIndex : 0
    const quality = typeof meta.quality === 'number' ? meta.quality : 80
    if (!bvid) throw new Error('任务项缺少 bvid')

    // 同一个视频的分 P 共用一份详情（避免每个分 P 都查一次）
    let info = ctx.shared.get(`info:${bvid}`) as Awaited<ReturnType<typeof fetchInfo>> | undefined
    if (!info) {
      info = await fetchInfo(bvid)
      ctx.shared.set(`info:${bvid}`, info)
    }

    const result = await downloadPage(info, pageIndex, { quality })
    return {
      status: 'done',
      profile: qualityName(result.actualQuality),
      path: result.path,
      note: [
        result.downgraded ? `请求 ${qualityName(result.requestedQuality)}，实际 ${result.actualQualityLabel}` : null,
        ...result.warnings,
      ].filter(Boolean).join('；') || null,
    }
  },
})

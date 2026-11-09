/**
 * 漫画域的后台任务：一项 = 一话。生命周期交给 `core/jobs.ts`。
 *
 * 同一本的详情和 scramble_id 在一个任务里只查一次（放 `ctx.shared`）。
 */
import { getConfig } from '../core/config.ts'
import { registerJobHandler, type ItemOutcome } from '../core/jobs.ts'
import { comicClient, type AlbumDetail } from './client.ts'
import { COMIC_DOMAIN } from './job-items.ts'
import { downloadChapter } from './download.ts'
import { recordComicSubscriptionChapters } from './subscribe.ts'

export { COMIC_DOMAIN, chapterItems } from './job-items.ts'

function pageConcurrency(): number {
  return Math.max(1, Math.min(6, Number(getConfig('comic.concurrency')) || 3))
}

registerJobHandler(COMIC_DOMAIN, {
  // 一话里的图已经并发了；话与话之间串行，避免对上游开太多连接
  concurrency: () => 1,
  summary: (items) => {
    const pages = items.reduce((n, i) => n + (typeof i.meta?.pages === 'number' ? i.meta.pages : 0), 0)
    return pages > 0 ? [`共 ${pages} 页`] : []
  },
  // 订阅：只把真的落盘了的话记进基线，失败的下一轮再补
  afterFinish: async (job) => {
    const subscriptionId = typeof job.meta?.subscriptionId === 'string' ? job.meta.subscriptionId : ''
    if (subscriptionId) await recordComicSubscriptionChapters(subscriptionId, job.id)
  },

  async handle(item, ctx): Promise<ItemOutcome> {
    const albumId = typeof item.meta.albumId === 'string' ? item.meta.albumId : ''
    const chapterId = typeof item.meta.chapterId === 'string' ? item.meta.chapterId : item.id
    if (!albumId) throw new Error('任务项缺少 albumId')
    const client = comicClient()

    let album = ctx.shared.get(`album:${albumId}`) as AlbumDetail | undefined
    if (!album) {
      album = await client.getAlbum(albumId)
      ctx.shared.set(`album:${albumId}`, album)
    }
    let scrambleId = ctx.shared.get(`scramble:${albumId}`) as string | undefined
    if (scrambleId === undefined) {
      scrambleId = await client.getScrambleId(album.episodes[0]!.id)
      ctx.shared.set(`scramble:${albumId}`, scrambleId)
    }

    const detail = await client.getChapter(chapterId, scrambleId)
    const result = await downloadChapter(album, detail, { concurrency: pageConcurrency() })
    return {
      status: result.status === 'already_have' ? 'skipped' : 'downloaded',
      path: result.dir,
      note: result.registered < result.pages ? `资产库登记 ${result.registered}/${result.pages} 页` : null,
      meta: { albumId, chapterId: result.chapterId, sort: result.sort, pages: result.pages },
    }
  },
})

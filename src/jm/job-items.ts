/**
 * 漫画任务的域名和任务项形状。单独放一个文件，`jobs.ts` 和 `subscribe.ts` 都引它，不互相引。
 */
import type { JobItemInput } from '../core/jobs.ts'
import type { AlbumDetail, AlbumEpisode } from './client.ts'

export const JM_DOMAIN = 'jm'

/** 一本里选中的几话转成任务项。id 用章节 id，同一任务里不会撞。 */
export function chapterItems(album: Pick<AlbumDetail, 'id' | 'title'>, episodes: AlbumEpisode[]): JobItemInput[] {
  return episodes.map((ep) => ({
    id: ep.id,
    title: `${album.title} - 第${ep.sort}话${ep.title && ep.title !== album.title ? ` ${ep.title}` : ''}`,
    subtitle: album.id,
    meta: { albumId: album.id, chapterId: ep.id, sort: ep.sort },
  }))
}

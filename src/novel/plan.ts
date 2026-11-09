/**
 * 一次下载要做什么：选哪几卷、书名怎么定、章节名怎么写。纯逻辑，不碰网络和磁盘。
 */
import { AstraError, invalidInput } from '../core/errors.ts'
import type { BookInfo, Volume } from './sources/types.ts'

export interface PlannedChapter {
  id: string
  /** 写进 EPUB 的章节名。 */
  title: string
}

export interface Plan {
  /** 成书的书名（单卷时带卷名和副标题）。 */
  title: string
  /** `v2` / `all` / null（不分卷的书）。 */
  volumeKey: string | null
  chapters: PlannedChapter[]
}

/**
 * 一卷的副标题：这一卷所有章节名都以「卷名 X 」开头、X 相同，X 就是副标题。
 *
 * 8novel 的章节名常写成「第二卷 青春豬頭少年不會夢到小惡魔學妹 第一章 …」，
 * 也有书只写「第一章」。用「全卷一致」来判断，不会把「第二卷 第一章」的「第一章」误当副标题。
 */
export function volumeSubtitle(volume: Volume): string | null {
  if (volume.chapters.length < 2) return null
  let common: string | null = null
  for (const ch of volume.chapters) {
    if (!ch.title.startsWith(`${volume.title} `)) return null
    const token = ch.title.slice(volume.title.length + 1).split(/\s+/)[0] ?? ''
    if (common === null) common = token
    else if (common !== token) return null
  }
  return common || null
}

/** 去掉章节名前面重复的「卷名 副标题」。 */
export function stripVolumePrefix(title: string, volume: Volume, subtitle: string | null): string {
  const prefix = subtitle ? `${volume.title} ${subtitle} ` : `${volume.title} `
  const rest = title.startsWith(prefix) ? title.slice(prefix.length).trim() : title
  return rest || title
}

export function describeVolumes(book: BookInfo): { n: number; title: string; chapters: number }[] {
  return book.volumes.map((v, i) => ({ n: i + 1, title: [v.title, volumeSubtitle(v)].filter(Boolean).join(' '), chapters: v.chapters.length }))
}

/** `--volume` 的写法：缺省 / `all` / `0` / 从 1 开始的序号。 */
export function parseVolumeOption(raw: string | undefined): number | 'all' | null {
  if (raw === undefined || raw === '') return null
  if (raw === 'all' || raw === '0') return 'all'
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw invalidInput('--volume 只能是从 1 开始的序号，或 all')
  return n
}

/**
 * 定下这次要成哪本书。
 *
 * `volumesAreBooks` 的书源（8novel：每卷是单独出版的一本）多卷时必须明确选卷；
 * 其它书源的「卷」只是书内分部，默认整本。
 */
export function makePlan(book: BookInfo, volume: number | 'all' | null, volumesAreBooks: boolean): Plan {
  const multi = book.volumes.length > 1
  if (multi && volume === null && volumesAreBooks) {
    throw new AstraError('AMBIGUOUS_VOLUME', `《${book.title}》有 ${book.volumes.length} 卷，要哪一卷？`, {
      exitCode: 2,
      hint: '加 `--volume <n>` 只出一卷，`--volume all` 合成一本',
      details: { volumes: describeVolumes(book) },
    })
  }
  if (typeof volume === 'number') {
    const picked = book.volumes[volume - 1]
    if (!picked) throw invalidInput(`--volume 超出范围：共 ${book.volumes.length} 卷`)
    const subtitle = volumeSubtitle(picked)
    // 日轻每卷单独出版、各有书名：「第二卷 青春豬頭少年不會夢到小惡魔學妹」的副标题就是那本书的名字。
    // 没有副标题时才用「总书名 第N卷」
    const volumeTitle = subtitle ? `${subtitle}（${picked.title}）` : `${book.title} ${picked.title}`
    return {
      title: multi ? volumeTitle : book.title,
      volumeKey: multi ? `v${volume}` : null,
      chapters: picked.chapters.map((c) => ({ id: c.id, title: stripVolumePrefix(c.title, picked, subtitle) })),
    }
  }
  // 整本：多卷时章节名带上卷名，避免出现十几个同名的「第一章」
  const chapters: PlannedChapter[] = []
  for (const v of book.volumes) {
    const named = multi && v.title !== '正文'
    for (const c of v.chapters) chapters.push({ id: c.id, title: named && !c.title.startsWith(v.title) ? `${v.title} ${c.title}` : c.title })
  }
  return { title: book.title, volumeKey: multi ? 'all' : null, chapters }
}

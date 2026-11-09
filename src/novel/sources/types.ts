/**
 * 书源接口。每个站一个文件，只做三件事：认链接、搜书、读目录与正文。
 *
 * 打包、落盘、任务、订阅都在书源之外 —— 换站或站点改版只动对应的文件。
 */

export interface SearchHit {
  /** 书源 id（`eightnovel` / `lnovel` / `kanunu`）。 */
  source: string
  /** 书源内的书 id（各站自己的格式，`book()` 认得就行）。 */
  id: string
  title: string
  author: string | null
}

export interface ChapterRef {
  /** 书源内唯一，订阅用它判断「新章节」。 */
  id: string
  title: string
}

export interface Volume {
  title: string
  chapters: ChapterRef[]
}

export interface BookInfo {
  source: string
  id: string
  title: string
  author: string | null
  /** 封面图地址；没有就是 null。 */
  cover: string | null
  /** 书页地址，下载图片时作为 Referer。 */
  url: string
  /** 至少一卷；不分卷的书是一个「正文」卷。 */
  volumes: Volume[]
}

export interface ChapterContent {
  paragraphs: string[]
  /** 插图地址（按出现顺序）。 */
  images: string[]
}

export interface NovelSource {
  /** 对外名字（`--source` 用）。 */
  name: string
  /** 一句话：这个书源收什么书、什么语言。 */
  description: string
  /** 正文语言，写进 EPUB。 */
  language: 'zh-Hant' | 'zh-Hans'
  /**
   * 「卷」是不是各自独立的一本书。
   * 轻小说站是（每卷单独出版，默认一卷一本）；出版读物站的卷只是书内分部（默认整本）。
   */
  volumesAreBooks: boolean
  /** 认得这个输入就返回书 id，否则 null。 */
  match(input: string): string | null
  /** 不支持搜索的书源返回空数组。 */
  search(keyword: string, signal?: AbortSignal): Promise<SearchHit[]>
  book(id: string, signal?: AbortSignal): Promise<BookInfo>
  chapter(book: BookInfo, chapter: ChapterRef, signal?: AbortSignal): Promise<ChapterContent>
  /** 连通性自检用的一个轻请求，返回一句说明。 */
  probe(signal?: AbortSignal): Promise<string>
}

/**
 * 漫画源接口。每个站一个文件，只做四件事：认链接、搜作品、读目录、读一话的图片地址。
 *
 * 落盘、任务、额度等待都在源之外 —— 换站或站点改版只动对应的文件。
 *
 * 走不走代理由 `proxy.include` 按域名决定（core/proxy.ts），源里不管：
 * Komiic 要走（直连不通），拷贝漫画不能走（代理出口 IP 被拒）。
 */
import { AstraError } from '../../core/errors.ts'

export interface SearchHit {
  /** 源 id（`komiic` / `copymanga`）。 */
  source: string
  /** 源内作品 id。 */
  id: string
  title: string
  author: string | null
}

export interface ChapterRef {
  /** 源内唯一。 */
  id: string
  /** 站上的原名：`01` / `第01话` / `第03卷`。 */
  name: string
  /** 页数；站上不给就是 null。 */
  pages: number | null
}

export interface Group {
  /** 展示名：`单行本` / `单话` / `连载` / 翻译组名。 */
  name: string
  /** 是不是「卷」：单行本按卷落盘、目录叫「第NN卷」。 */
  volumes: boolean
  chapters: ChapterRef[]
}

export interface ComicInfo {
  source: string
  id: string
  title: string
  author: string | null
  status: string | null
  tags: string[]
  cover: string | null
  url: string
  /** 至少一个非空分组；顺序 = 默认优先级（第一个是默认分组）。 */
  groups: Group[]
}

export interface PageRef {
  url: string
  headers: Record<string, string>
}

export interface ComicSource {
  /** 对外名字（`--source` 用），也是稳定 id。 */
  name: string
  description: string
  /** 认得这个输入就返回作品 id，否则 null。 */
  match(input: string): string | null
  search(keyword: string, signal?: AbortSignal): Promise<SearchHit[]>
  comic(id: string, signal?: AbortSignal): Promise<ComicInfo>
  pages(comic: ComicInfo, chapter: ChapterRef, signal?: AbortSignal): Promise<PageRef[]>
  /** 下一张图。额度 / 限流时抛 `QuotaError`。 */
  image(page: PageRef, signal?: AbortSignal): Promise<Buffer>
  /** 连通性 + 额度自检，返回一句说明。 */
  probe(signal?: AbortSignal): Promise<string>
}

/**
 * 源的「过一会儿就好」类错误：Komiic 每日看图额度、拷贝漫画 code 210。
 * `resetInSeconds` 是源给的或估计的恢复时间。任务层据此把这一项标成失败、记下何时可以 resume。
 */
export class QuotaError extends AstraError {
  readonly source: string
  readonly resetInSeconds: number

  constructor(source: string, resetInSeconds: number, message: string) {
    super('RATE_LIMITED', message, {
      exitCode: 5,
      retryable: true,
      hint: `约 ${Math.ceil(resetInSeconds / 60)} 分钟后再试；下载任务用 \`astra comic job resume <id>\` 接着下`,
      details: { source, resetInSeconds },
    })
    this.name = 'QuotaError'
    this.source = source
    this.resetInSeconds = resetInSeconds
  }
}

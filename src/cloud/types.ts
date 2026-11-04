/**
 * 网盘的统一接口。夸克和百度都实现它，命令层只依赖这个接口。
 *
 * 为什么用「路径」而不是 fid/fs_id：两家网盘都把「父目录 id + 名字」拆成两个参数，
 * 而人对网盘的心智是路径。适配层负责把路径翻成 id，命令层不需要知道。
 *
 * 能力差异用 capabilities 声明，上层据此决定哪些子命令可用（比如百度没有「分享直链」，
 * 夸克必须先转存才能下载），不要用 if (provider === 'baidu') 散在各处。
 */
export interface CloudNode {
  /** 平台内部 id：夸克是 fid，百度是 fs_id（字符串化） */
  id: string
  name: string
  dir: boolean
  size: number
  /** 绝对路径，以 / 开头；根目录是 / */
  path: string
  modifiedAt?: string
}

export interface DriveCapabilities {
  /** 能否直接解析分享链接（夸克能列分享目录，百度要先转存） */
  share: boolean
  /** 删除是否进回收站（两家都是，用于提示"可恢复"） */
  trash: boolean
  /** 取直链是否需要登录凭证 */
  downloadNeedsAuth: boolean
  /** 移动是同步完成还是异步任务（百度返回 taskid） */
  asyncMove: boolean
}

export interface DownloadTarget {
  url: string
  /** 下载时必须带的请求头（百度要求 UA 是 pan.baidu.com） */
  headers: Record<string, string>
}

export interface CloudDrive {
  readonly id: 'quark' | 'baidu'
  readonly label: string
  readonly capabilities: DriveCapabilities

  /** 列出目录直接子项；path 用 / 分隔，根为 / */
  list(path: string, signal?: AbortSignal): Promise<CloudNode[]>
  /** 取单个节点；不存在返回 null */
  stat(path: string, signal?: AbortSignal): Promise<CloudNode | null>
  /** 建目录（父级不存在要自动建）；返回最终路径 */
  mkdir(path: string, signal?: AbortSignal): Promise<string>
  /** 把若干路径移动到目标目录 */
  move(sources: string[], destDir: string, signal?: AbortSignal): Promise<void>
  /** 删除（进回收站） */
  remove(paths: string[], signal?: AbortSignal): Promise<void>
  /** 取下载地址与必需请求头 */
  downloadTarget(node: CloudNode, signal?: AbortSignal): Promise<DownloadTarget>
}

/** 统一的路径处理：合并多余斜杠、去掉尾部 /、拒绝 .. 越界。 */
export function normalizePath(input: string): string {
  const cleaned = input.replace(/\\/g, '/').trim()
  const parts = cleaned.split('/').filter((x) => x.length > 0 && x !== '.')
  if (parts.some((x) => x === '..')) {
    throw new Error('路径里不允许出现 ..')
  }
  return '/' + parts.join('/')
}

/** 取父目录路径；根目录的父目录仍是根。 */
export function parentPath(path: string): string {
  const p = normalizePath(path)
  if (p === '/') return '/'
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

/** 拼子路径。 */
export function joinPath(dir: string, name: string): string {
  const d = normalizePath(dir)
  const n = name.replace(/^\/+|\/+$/g, '')
  return d === '/' ? `/${n}` : `${d}/${n}`
}

/** 路径末段（文件名）。 */
export function baseName(path: string): string {
  const p = normalizePath(path)
  if (p === '/') return '/'
  return p.slice(p.lastIndexOf('/') + 1)
}

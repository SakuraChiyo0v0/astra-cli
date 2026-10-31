/**
 * 夸克网盘整理的「只读部分」：把索引算成一份可 review 的整理清单。
 *
 * 设计原则：
 * - plan **绝不改文件**，只输出建议；apply 才动手，而且删除一律走回收站。
 * - 判断依据只用索引里有的字段（路径/体积/扩展名），不猜内容。
 * - 重复文件只「提示」，不自动删：夸克列表没有 md5（实测恒 null），
 *   「体积+归一化文件名」相同的未必同内容，误删代价太大。
 */
import type { DriveEntry } from './index.ts'
import { extOf, humanSize } from './index.ts'

export type Category =
  | '视频'
  | 'AI模型'
  | '压缩包'
  | '安装包'
  | '镜像'
  | '图片'
  | '音频'
  | '文档'
  | '其他'

const EXT_CATEGORY: Record<string, Category> = {
  // 视频
  mkv: '视频', mp4: '视频', avi: '视频', mov: '视频', rmvb: '视频', ts: '视频',
  wmv: '视频', flv: '视频', m2ts: '视频', webm: '视频', m4v: '视频',
  // AI 模型 / 权重
  gguf: 'AI模型', safetensors: 'AI模型', ckpt: 'AI模型', pth: 'AI模型',
  pt: 'AI模型', onnx: 'AI模型', lora: 'AI模型',
  // 压缩包
  zip: '压缩包', rar: '压缩包', '7z': '压缩包', tar: '压缩包', gz: '压缩包',
  tgz: '压缩包', xz: '压缩包', bz2: '压缩包', jzl: '压缩包',
  // 安装包
  exe: '安装包', msix: '安装包', msi: '安装包', dmg: '安装包', pkg: '安装包',
  apk: '安装包', deb: '安装包', appimage: '安装包',
  // 镜像
  iso: '镜像', img: '镜像', vhd: '镜像',
  // 图片
  jpg: '图片', jpeg: '图片', png: '图片', webp: '图片', gif: '图片',
  bmp: '图片', psd: '图片', tif: '图片', tiff: '图片', heic: '图片',
  // 音频
  mp3: '音频', flac: '音频', wav: '音频', ape: '音频', m4a: '音频',
  aac: '音频', ogg: '音频', dsf: '音频',
  // 文档
  pdf: '文档', doc: '文档', docx: '文档', xls: '文档', xlsx: '文档',
  ppt: '文档', pptx: '文档', txt: '文档', md: '文档', epub: '文档',
  mobi: '文档', azw3: '文档', csv: '文档',
}

export function categoryOf(name: string): Category {
  return EXT_CATEGORY[extOf(name)] ?? '其他'
}

export interface PlanAction {
  id: number
  op: 'mkdir' | 'move' | 'remove'
  /** 给人看的说明 */
  label: string
  /** mkdir: 目标目录路径 */
  dir?: string
  /** move/remove: 涉及的文件 */
  fids?: string[]
  names?: string[]
  /** move: 目标目录路径 */
  to?: string
  bytes?: number
  /** remove 是否只是建议（需要人工确认） */
  advisory?: boolean
}

export interface Plan {
  generatedAt: string
  scope: string
  rules: string[]
  summary: {
    moveCount: number
    moveBytes: number
    moveText: string
    dirCount: number
    dupGroups: number
    dupWasted: number
    dupWastedText: string
  }
  actions: PlanAction[]
  /** 需要人工判断的重复文件组 */
  review: Array<{
    size: number
    sizeText: string
    keep: string
    duplicates: Array<{ path: string; fid: string }>
  }>
}

/**
 * 规则 1：把某个目录「根上散着的文件」按类型收进子目录。
 * 只处理直接位于 scope 下的文件，不碰已有的子目录，避免改动过深。
 */
export function ruleScatter(files: DriveEntry[], scope: string): PlanAction[] {
  const scatter = files.filter((f) => {
    if (f.dir) return false
    const parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
    return parent === scope
  })
  if (!scatter.length) return []

  const buckets = new Map<Category, DriveEntry[]>()
  for (const file of scatter) {
    const category = categoryOf(file.name)
    const list = buckets.get(category) ?? []
    list.push(file)
    buckets.set(category, list)
  }

  const actions: PlanAction[] = []
  let id = 1
  for (const [category, items] of [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const target = scope ? `${scope}/${category}` : category
    actions.push({
      id: id++,
      op: 'mkdir',
      dir: target,
      label: `建目录 ${target}`,
    })
    actions.push({
      id: id++,
      op: 'move',
      label: `${items.length} 个文件 → ${target}`,
      fids: items.map((x) => x.fid),
      names: items.map((x) => x.name),
      to: target,
      bytes: items.reduce((sum, x) => sum + x.size, 0),
    })
  }
  return actions
}

/** 规则 2：找重复（体积 + 归一化文件名相同），只作为 review 建议。 */
export type KeepStrategy = 'shortest' | 'oldest' | { prefer: string }

/** 按策略从重复组里挑「保留哪一份」。 */
function pickKeep(group: DriveEntry[], strategy: KeepStrategy): DriveEntry {
  const sorted = [...group]
  if (strategy === 'shortest') {
    sorted.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))
    return sorted[0]!
  }
  if (strategy === 'oldest') {
    sorted.sort((a, b) => (a.updatedAt || Infinity) - (b.updatedAt || Infinity) || a.path.localeCompare(b.path))
    return sorted[0]!
  }
  const keyword = strategy.prefer.toLowerCase()
  const preferred = sorted.filter((x) => x.path.toLowerCase().includes(keyword))
  const pool = preferred.length ? preferred : sorted
  pool.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))
  return pool[0]!
}

/** 去重清单：每组留一份，其余生成 remove 动作（进回收站）。 */
export function ruleDedupe(
  files: DriveEntry[],
  minBytes: number,
  strategy: KeepStrategy = 'shortest',
): { actions: PlanAction[]; review: Plan['review'] } {
  const norm = (name: string) => name
    .replace(/\(\d+\)/g, '')
    .replace(/[\s_\-]+/g, '')
    .replace(/副本|copy/gi, '')
    .toLowerCase()

  const groups = new Map<string, DriveEntry[]>()
  for (const file of files) {
    if (file.dir || file.size < minBytes) continue
    const key = `${file.size}::${norm(file.name)}`
    const list = groups.get(key) ?? []
    list.push(file)
    groups.set(key, list)
  }

  const dups = [...groups.values()].filter((g) => g.length > 1)
  const actions: PlanAction[] = []
  const review: Plan['review'] = []
  let id = 1
  for (const group of dups) {
    const keep = pickKeep(group, strategy)
    const drop = group.filter((x) => x.fid !== keep.fid)
    if (!drop.length) continue
    actions.push({
      id: id++,
      op: 'remove',
      label: `保留 ${keep.path}，删除 ${drop.length} 份副本（省 ${humanSize(keep.size * drop.length)}）`,
      fids: drop.map((x) => x.fid),
      names: drop.map((x) => x.name),
      bytes: keep.size * drop.length,
    })
    review.push({
      size: keep.size,
      sizeText: humanSize(keep.size),
      keep: keep.path,
      duplicates: drop.map((x) => ({ path: x.path, fid: x.fid })),
    })
  }
  return { actions, review }
}

export function ruleDuplicates(files: DriveEntry[], minBytes: number): Plan['review'] {
  const norm = (name: string) => name
    .replace(/\(\d+\)/g, '')
    .replace(/[\s_\-]+/g, '')
    .replace(/副本|copy/gi, '')
    .toLowerCase()

  const groups = new Map<string, DriveEntry[]>()
  for (const file of files) {
    if (file.dir || file.size < minBytes) continue
    const key = `${file.size}::${norm(file.name)}`
    const list = groups.get(key) ?? []
    list.push(file)
    groups.set(key, list)
  }

  return [...groups.values()]
    .filter((g) => g.length > 1)
    .sort((a, b) => b.length * b[0]!.size - a.length * a[0]!.size)
    .map((g) => ({
      size: g[0]!.size,
      sizeText: humanSize(g[0]!.size),
      keep: g[0]!.path,
      duplicates: g.slice(1).map((x) => ({ path: x.path, fid: x.fid })),
    }))
}

/** 规则 3：空目录（索引里没有任何子项）。 */
export function ruleEmptyDirs(entries: DriveEntry[]): DriveEntry[] {
  const parents = new Set<string>()
  for (const entry of entries) {
    const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
    parents.add(parent)
  }
  // 只有「深度 ≥ 2」的目录才建议清，顶层目录不动（用户可能有用途）
  return entries.filter((e) => e.dir && !parents.has(e.path) && e.path.includes('/'))
}

export function buildPlan(options: {
  entries: DriveEntry[]
  scope: string
  dupMinBytes?: number
  includeEmpty?: boolean
  /** 索引是否扫到叶子（depth=0）。没扫全的话不能判断「空目录」，否则会把没展开的目录全当成空的 */
  indexComplete?: boolean
}): Plan {
  const files = options.entries.filter((e) => !e.dir)
  const actions = ruleScatter(options.entries, options.scope)
  const review = ruleDuplicates(files, options.dupMinBytes ?? 100 * 1024 * 1024)
  // 索引没扫到叶子时，深层的目录在索引里都是「没有子项」的假象，必须禁用这条规则
  const emptyDirs = options.includeEmpty === false || !options.indexComplete ? [] : ruleEmptyDirs(options.entries)

  let id = actions.length + 1
  for (const dir of emptyDirs) {
    actions.push({
      id: id++,
      op: 'remove',
      label: `空目录 ${dir.path}`,
      fids: [dir.fid],
      names: [dir.name],
      advisory: true,
    })
  }

  const moveActions = actions.filter((a) => a.op === 'move')
  const moveBytes = moveActions.reduce((sum, a) => sum + (a.bytes ?? 0), 0)
  const dupWasted = review.reduce((sum, g) => sum + g.size * g.duplicates.length, 0)

  return {
    generatedAt: new Date().toISOString(),
    scope: options.scope,
    rules: [
      '散文件按类型归档（只处理目录根上的文件）',
      '重复文件只提示，不自动删（无 md5，保守判定）',
      options.indexComplete ? '空目录建议清理（顶层目录不动）' : '索引未扫到叶子，跳过空目录清理建议',
    ],
    summary: {
      moveCount: moveActions.reduce((sum, a) => sum + (a.fids?.length ?? 0), 0),
      moveBytes,
      moveText: humanSize(moveBytes),
      dirCount: actions.filter((a) => a.op === 'mkdir').length,
      dupGroups: review.length,
      dupWasted,
      dupWastedText: humanSize(dupWasted),
    },
    actions,
    review,
  }
}

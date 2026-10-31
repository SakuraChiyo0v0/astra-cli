/**
 * 网盘文件系统的小工具：路径解析、递归遍历、按类型归类。
 *
 * 这些逻辑原先散在几个临时 python 脚本里（quark_group_dirs / clean_empty / tree），
 * 收进 CLI 后同一套行为只维护一份。
 */
import { deleteFiles, listDriveOnce, makeFolder, moveFiles } from './api.ts'
import { extOf, humanSize } from './index.ts'

export interface Node {
  fid: string
  name: string
  dir: boolean
  size: number
}

/** 列出目录下全部直接子项（自动翻页）。 */
export async function childrenAll(fid: string, signal?: AbortSignal): Promise<Node[]> {
  const out: Node[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= 200; page += 1) {
    const items = await listDriveOnce(fid, signal, page)
    if (!items.length) break
    let fresh = 0
    for (const item of items) {
      if (!item.fid || seen.has(item.fid)) continue
      seen.add(item.fid)
      fresh += 1
      out.push({
        fid: item.fid,
        name: item.file_name ?? '',
        dir: Number(item.dir ?? 0) === 1,
        size: Number(item.size ?? 0),
      })
    }
    if (items.length < 100 || fresh === 0) break
  }
  return out
}

/** 把 `a/b/c` 解析成节点；找不到返回 null。 */
export async function resolveNode(path: string, signal?: AbortSignal): Promise<Node | null> {
  const segments = path.split('/').map((x) => x.trim()).filter(Boolean)
  if (!segments.length) return { fid: '0', name: '/', dir: true, size: 0 }
  let parent = '0'
  let node: Node = { fid: '0', name: '/', dir: true, size: 0 }
  for (const segment of segments) {
    const hit = (await childrenAll(parent, signal)).find((x) => x.name === segment)
    if (!hit) return null
    node = hit
    parent = hit.fid
  }
  return node
}

/** 解析目录路径，不存在就逐级创建。返回目录 fid。 */
export async function ensureDir(path: string, signal?: AbortSignal): Promise<string> {
  const segments = path.split('/').map((x) => x.trim()).filter(Boolean)
  let fid = '0'
  for (const segment of segments) {
    fid = await makeFolder(fid, segment, signal)
  }
  return fid
}

export interface TreeNode {
  name: string
  path: string
  dir: boolean
  size: number
  files: number
  bytes: number
  /** 没展开也没统计（默认行为，避免每个目录都递归扫一遍） */
  unknown?: boolean
  /** 合计里含未展开的子目录，数值只是下限 */
  partial?: boolean
  children?: TreeNode[]
}

/** 递归统计某个目录（文件数 / 总字节）。budget 命中就提前结束，用于「是不是空的」这种判断。 */
export async function countUnder(
  fid: string,
  options: { signal?: AbortSignal; budget?: number } = {},
): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const stack = [fid]
  while (stack.length) {
    const current = stack.pop()!
    for (const node of await childrenAll(current, options.signal)) {
      if (node.dir) {
        stack.push(node.fid)
      } else {
        files += 1
        bytes += node.size
        if (options.budget && files >= options.budget) return { files, bytes }
      }
    }
  }
  return { files, bytes }
}

/** 渲染目录树（实时读盘，不走索引）。 */
export async function buildTree(
  fid: string,
  options: { path?: string; depth?: number; signal?: AbortSignal; full?: boolean } = {},
): Promise<TreeNode[]> {
  const depth = options.depth ?? 2
  const basePath = options.path ?? ''

  const walk = async (parentFid: string, parentPath: string, level: number): Promise<TreeNode[]> => {
    const nodes = await childrenAll(parentFid, options.signal)
    const result: TreeNode[] = []
    for (const node of nodes.sort((a, b) => Number(b.dir) - Number(a.dir) || b.size - a.size)) {
      const path = parentPath ? `${parentPath}/${node.name}` : node.name
      if (!node.dir) {
        result.push({ name: node.name, path, dir: false, size: node.size, files: 1, bytes: node.size })
        continue
      }
      let stat = { files: 0, bytes: 0 }
      let kids: TreeNode[] | undefined
      let unknown = false
      let partial = false
      if (level < depth) {
        kids = await walk(node.fid, path, level + 1)
        stat = kids.reduce(
          (sum, kid) => ({ files: sum.files + kid.files, bytes: sum.bytes + kid.bytes }),
          { files: 0, bytes: 0 },
        )
        partial = kids.some((kid) => kid.unknown || kid.partial)
      } else if (options.full) {
        // 只有显式 --full 才递归统计：大目录每个都扫一遍要几百次请求、分钟级
        stat = await countUnder(node.fid, { ...(options.signal ? { signal: options.signal } : {}) })
      } else {
        unknown = true
      }
      result.push({
        name: node.name,
        path,
        dir: true,
        size: stat.bytes,
        files: stat.files,
        bytes: stat.bytes,
        ...(unknown ? { unknown: true } : {}),
        ...(partial ? { partial: true } : {}),
        children: kids,
      })
    }
    return result
  }

  return walk(fid, basePath, 1)
}

/** 拍平成文本树，给 CLI 打印用。 */
export function renderTree(nodes: TreeNode[], level = 0): string[] {
  const lines: string[] = []
  for (const node of nodes) {
    const indent = '  '.repeat(level)
    if (node.dir) {
      const stat = node.unknown
        ? '(未展开)'
        : `${node.partial ? '≥' : ''}${humanSize(node.bytes)}  ${node.partial ? `直接 ${node.files} 个文件` : `${node.files} 个文件`}`
      lines.push(`${indent}${node.name}/  ${stat}`)
      if (node.children?.length) lines.push(...renderTree(node.children, level + 1))
    } else {
      lines.push(`${indent}${node.name}  ${humanSize(node.size)}`)
    }
  }
  return lines
}

// —— 目录级归类（关键词白名单，命中才动） ——
export const CATEGORIES = ['AI模型', '影视', '游戏', '软件', '素材', '文档'] as const
export type Category = (typeof CATEGORIES)[number]

const RULES: Array<[Category, string[]]> = [
  ['AI模型', ['qwen', 'comfyui', 'moss', 'flux', 'vae', 'lora', '模型', '整合包', '生图', '工作流', 'seedvr', 'sdxl', 'ace-step']],
  ['影视', ['影视', '番剧', '电影', '新海诚', '你的名字', '4k', '蓝光', 'remux']],
  ['游戏', ['paradox', '落幕曲', '游戏', '捕獲され', 'steam', '模拟器', 'yuzu']],
  ['软件', ['软件', 'adobe', '工具箱', '变声器', 'rvc', '浏览器', '工具', 'keil', '3dmark', 'maante', 'sunshine']],
  ['素材', ['贴图', '材质', '素材', 'vrchat', '皮肤', '壁纸']],
  ['文档', ['古籍', '电子书', 'pdf', '教程', '笔记']],
]

/** 目录名 → 分类；认不出返回 null（调用方保持原位）。 */
export function classifyDir(name: string): Category | null {
  const lower = name.toLowerCase()
  // 分类目录自身不能被归类（"软件" 会命中关键词 "软件" → 自己移动到自己）
  if ((CATEGORIES as readonly string[]).includes(name)) return null
  for (const [category, keywords] of RULES) {
    if (keywords.some((k) => lower.includes(k))) return category
  }
  return null
}

/** 把目录下的子目录按分类归位。返回每个分类的移动结果。 */
export async function tidyDirs(
  dirFid: string,
  options: { dry?: boolean; signal?: AbortSignal; onProgress?: (line: string) => void } = {},
): Promise<{ moved: Array<{ category: Category; names: string[] }>; unknown: string[]; failed: string[] }> {
  const nodes = await childrenAll(dirFid, options.signal)
  const buckets = new Map<Category, Node[]>()
  const unknown: string[] = []
  for (const node of nodes) {
    if (!node.dir) continue
    const category = classifyDir(node.name)
    if (!category) {
      unknown.push(node.name)
      continue
    }
    const list = buckets.get(category) ?? []
    list.push(node)
    buckets.set(category, list)
  }

  const moved: Array<{ category: Category; names: string[] }> = []
  const failed: string[] = []
  for (const [category, items] of buckets) {
    if (options.dry) {
      moved.push({ category, names: items.map((x) => x.name) })
      continue
    }
    const target = await makeFolder(dirFid, category, options.signal)
    const ok: string[] = []
    for (const item of items) {
      try {
        await moveFiles([item.fid], target, options.signal)
        ok.push(item.name)
      } catch (error) {
        failed.push(`${item.name}：${(error as Error).message.slice(0, 60)}`)
      }
      options.onProgress?.(`  ${category} ← ${item.name}`)
    }
    moved.push({ category, names: ok })
  }
  return { moved, unknown, failed }
}

/** 找出目录下「递归也没有任何文件」的子目录（可传 budget=1 只判断空不空）。 */
export async function findEmptyDirs(
  dirFid: string,
  options: { signal?: AbortSignal; minDepth?: number } = {},
): Promise<Node[]> {
  const empty: Node[] = []
  for (const node of await childrenAll(dirFid, options.signal)) {
    if (!node.dir) continue
    const stat = await countUnder(node.fid, { budget: 1, ...(options.signal ? { signal: options.signal } : {}) })
    if (stat.files === 0) empty.push(node)
  }
  return empty
}

export async function removeNodes(fids: string[], signal?: AbortSignal): Promise<void> {
  await deleteFiles(fids, signal)
}

/** 汇总一棵子树的扩展名分布（给 tree --by ext 用）。 */
export function extSummary(nodes: TreeNode[]): Array<{ ext: string; files: number; bytes: number }> {
  const map = new Map<string, { files: number; bytes: number }>()
  const walk = (list: TreeNode[]): void => {
    for (const node of list) {
      if (node.dir) {
        if (node.children) walk(node.children)
        continue
      }
      const key = extOf(node.name)
      const row = map.get(key) ?? { files: 0, bytes: 0 }
      row.files += 1
      row.bytes += node.size
      map.set(key, row)
    }
  }
  walk(nodes)
  return [...map.entries()]
    .map(([ext, row]) => ({ ext, ...row }))
    .sort((a, b) => b.bytes - a.bytes)
}

/**
 * 夸克网盘 → CloudDrive 适配器。
 *
 * 只是一层壳：底下还是 `quark/api.ts` + `quark/fs.ts` 那套（已经实测跑通的转存/直链逻辑），
 * 这里负责「路径 → fid」的翻译和错误归一化，不改任何网络行为。
 */
import { AstraError } from '../core/errors.ts'
import { deleteFiles, downloadUrls, makeFolder, moveFiles } from '../quark/api.ts'
import { childrenAll, resolveNode } from '../quark/fs.ts'
import { CLIENT_UA } from '../quark/api.ts'
import { baseName, joinPath, normalizePath, parentPath, type CloudDrive, type CloudNode, type DownloadTarget } from './types.ts'

async function fidOf(path: string, signal?: AbortSignal): Promise<string | null> {
  const node = await resolveNode(normalizePath(path), signal)
  return node?.fid ?? null
}

function toNode(path: string, raw: { fid: string; name: string; dir: boolean; size: number }): CloudNode {
  return {
    id: raw.fid,
    name: raw.name || baseName(path),
    dir: raw.dir,
    size: raw.size,
    path: normalizePath(path),
  }
}

export const quarkDrive: CloudDrive = {
  id: 'quark',
  label: '夸克网盘',
  capabilities: { share: true, trash: true, downloadNeedsAuth: true, asyncMove: false },

  async list(path, signal) {
    const fid = await fidOf(path, signal)
    if (fid === null) throw new AstraError('CLOUD_NOT_FOUND', `夸克里找不到目录：${path}`, { exitCode: 4 })
    const items = await childrenAll(fid, signal)
    const dir = normalizePath(path)
    return items.map((it) => toNode(joinPath(dir, it.name), it))
  },

  async stat(path, signal) {
    const node = await resolveNode(normalizePath(path), signal)
    return node ? toNode(path, node) : null
  },

  async mkdir(path, signal) {
    const target = normalizePath(path)
    if (target === '/') return '/'
    let current = '/'
    for (const segment of target.split('/').filter(Boolean)) {
      const fid = await fidOf(current, signal)
      if (fid === null) throw new AstraError('CLOUD_NOT_FOUND', `父目录不存在：${current}`, { exitCode: 4 })
      const existing = (await childrenAll(fid, signal)).find((x) => x.name === segment && x.dir)
      if (!existing) await makeFolder(fid, segment, signal)
      current = joinPath(current, segment)
    }
    return target
  },

  async move(sources, destDir, signal) {
    const destFid = await fidOf(destDir, signal)
    if (destFid === null) throw new AstraError('CLOUD_NOT_FOUND', `目标目录不存在：${destDir}`, { exitCode: 4 })
    const fids: string[] = []
    for (const s of sources) {
      const fid = await fidOf(normalizePath(s), signal)
      if (fid === null) throw new AstraError('CLOUD_NOT_FOUND', `源不存在：${s}`, { exitCode: 4 })
      fids.push(fid)
    }
    await moveFiles(fids, destFid, signal)
  },

  async remove(paths, signal) {
    const fids: string[] = []
    for (const p of paths) {
      const fid = await fidOf(normalizePath(p), signal)
      if (fid) fids.push(fid)
    }
    if (fids.length) await deleteFiles(fids, signal)
  },

  async downloadTarget(node, signal): Promise<DownloadTarget> {
    const map = await downloadUrls([node.id], signal)
    const url = map.get(node.id)
    if (!url) throw new AstraError('CLOUD_NO_URL', `拿不到直链：${node.path}`, { exitCode: 5, retryable: true })
    return { url, headers: { 'User-Agent': CLIENT_UA, Referer: 'https://pan.quark.cn/' } }
  },
}

/** 给上层用的路径工具（避免各处重复 import types）。 */
export { baseName, parentPath }

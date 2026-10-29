/**
 * 下载落盘后的「影子写入」：把 tracks 里的一条记录同步到 assets + files。
 *
 * 为什么要双写而不是直接换表：
 * - `tracks` 被十几处老代码直接查（`music have`、任务、订阅），一次性换掉风险太大
 * - 双写让 `lib` 命令能先用起来，等稳定了再下线 `tracks`
 *
 * 设计约束：
 * - **不能拖慢下载**：失败只影响资产库，不能影响下载结果，所以调用方不 await
 * - 资产库还没迁移时（表不存在）静默跳过，不要报错
 */
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { openDatabase } from './index.ts'
import { listRoots, recordDownload } from './library.ts'

export interface MirrorTrack {
  platform: string
  id: string
  title: string
  artists: string[]
  album: string | null
  durationMs: number | null
  path: string
  bytes?: number | null
  audioSha256?: string | null
}

/** 找这个绝对路径属于哪个 root，返回相对路径。找不到返回 null（不在任何存储根里）。 */
function locate(roots: { id: string; abs_path: string }[], abs: string): { rootId: string; rel: string } | null {
  for (const root of roots) {
    const base = root.abs_path.endsWith(path.sep) ? root.abs_path : root.abs_path + path.sep
    if (abs.startsWith(base)) return { rootId: root.id, rel: abs.slice(base.length) }
  }
  return null
}

export interface MirrorFile {
  platform: string
  nativeId: string
  kind: string
  title: string
  artists?: string | null
  album?: string | null
  durationMs?: number | null
  meta?: unknown
  path: string
  bytes?: number | null
  sha256?: string | null
}

/** 把任意落盘文件同步进资产库（音乐/视频/图片都走这里）。内部吞掉所有错误。 */
export async function mirrorFile(entry: MirrorFile): Promise<boolean> {
  try {
    const db = await openDatabase()
    try {
      const roots = await listRoots(db)
      if (roots.length === 0) return false
      const spot = locate(roots, path.resolve(entry.path))
      if (!spot) return false
      const size = existsSync(entry.path) ? statSync(entry.path).size : entry.bytes ?? null
      await recordDownload(
        db,
        {
          platform: entry.platform,
          nativeId: entry.nativeId,
          kind: entry.kind,
          title: entry.title,
          artists: entry.artists ?? null,
          album: entry.album ?? null,
          durationMs: entry.durationMs ?? null,
          meta: entry.meta,
        },
        { rootId: spot.rootId, relPath: spot.rel, size },
        // 注意：entry.sha256 是**下载源流**的哈希，不是落盘文件（写标签/嵌封面之后会变），
        // 所以这里不写进 files.sha256，交给 `lib verify` 实测
        { sha256: null },
      )
      return true
    } finally {
      await db.conn.close()
    }
  } catch {
    return false
  }
}

/** 把一条曲目同步进资产库。调用方不需要 await；内部吞掉所有错误。 */
export async function mirrorTrack(entry: MirrorTrack): Promise<boolean> {
  try {
    const db = await openDatabase()
    try {
      const roots = await listRoots(db)
      if (roots.length === 0) return false
      const spot = locate(roots, path.resolve(entry.path))
      if (!spot) return false
      // tracks.bytes 并不总是文件真实大小（实测 243/308 不一致），以磁盘为准
      const size = existsSync(entry.path) ? statSync(entry.path).size : entry.bytes ?? null
      await recordDownload(
        db,
        {
          platform: entry.platform,
          nativeId: entry.id,
          kind: 'music',
          title: entry.title,
          artists: entry.artists.join(', '),
          album: entry.album,
          durationMs: entry.durationMs,
        },
        { rootId: spot.rootId, relPath: spot.rel, size },
        { sha256: entry.audioSha256 ?? null },
      )
      return true
    } finally {
      await db.conn.close()
    }
  } catch {
    // 资产库没迁移 / 库文件不可写 —— 都不该让下载失败
    return false
  }
}

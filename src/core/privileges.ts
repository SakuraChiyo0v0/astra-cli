/**
 * 以 root 启动时降权成 ASTRA_HOME 的属主。
 *
 * ## 为什么需要
 *
 * astra 在 NAS 上跑在 Hermes 容器里。Hermes 自己以 hermes（uid 1000）运行，
 * 但运维和 cron 经常用 `docker exec hermes astra ...` 调用，那是 **root**。
 * root 写出的文件到了群晖的卷上会变成 `---------- root:root`：群晖的 ACL 共享目录
 * 对 root 的 mode 是 000（实测 `echo x > f` 也一样），而 hermes 写同一个目录得到的是正常权限。
 * 结果是下载完的漫画、视频、小说 SMB 打不开、Navidrome 读不到，hermes 进程自己也读不回来。
 *
 * 只靠 chmod 补救不够：mode 000 的文件连属主之外都不让改，而且新建目录也是 000，
 * 后续写进去的东西全错。所以从源头上不以 root 写：进程一启动就切到 ASTRA_HOME 的属主。
 *
 * ## 规则
 *
 * - 只在 POSIX、当前是 root、且 ASTRA_HOME 的属主不是 root 时才切
 * - `ASTRA_KEEP_ROOT=1` 关掉（真需要 root 的维护操作，比如修已有 root 文件的属主）
 * - 切完后子进程（后台 worker、ffmpeg）继承新身份
 * - 切失败（容器没给 CAP_SETUID 之类）不阻断：记一行进度，照原样继续
 */
import { statSync } from 'node:fs'
import { progress } from './output.ts'

export interface DropResult {
  dropped: boolean
  uid?: number
  gid?: number
  reason?: string
}

interface ProcLike {
  platform: string
  env: Record<string, string | undefined>
  getuid?: () => number
  setuid?: (id: number) => void
  setgid?: (id: number) => void
  setgroups?: (groups: number[]) => void
}

/** `stat` 抽出来是为了测试能换掉。 */
export function dropRootPrivileges(home: string, proc: ProcLike = process as unknown as ProcLike, stat: (p: string) => { uid: number; gid: number } = statSync): DropResult {
  if (proc.platform === 'win32' || !proc.getuid || !proc.setuid || !proc.setgid) return { dropped: false, reason: 'not-posix' }
  if (proc.getuid() !== 0) return { dropped: false, reason: 'not-root' }
  if (proc.env.ASTRA_KEEP_ROOT === '1') return { dropped: false, reason: 'keep-root' }
  let owner: { uid: number; gid: number }
  try {
    owner = stat(home)
  } catch {
    return { dropped: false, reason: 'home-missing' }
  }
  if (owner.uid === 0) return { dropped: false, reason: 'home-owned-by-root' }
  try {
    // 顺序不能反：先放掉附加组、再改 gid，最后改 uid（改完 uid 就没权限改组了）
    proc.setgroups?.([owner.gid])
    proc.setgid(owner.gid)
    proc.setuid(owner.uid)
  } catch (err) {
    progress('privileges.drop_failed', { uid: owner.uid, gid: owner.gid, error: (err as Error).message.slice(0, 120) })
    return { dropped: false, reason: 'setuid-failed' }
  }
  return { dropped: true, uid: owner.uid, gid: owner.gid }
}

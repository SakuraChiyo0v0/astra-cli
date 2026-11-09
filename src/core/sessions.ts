/**
 * 登录状态的统一视图。
 *
 * 各域的会话各存各的文件（`netease-session.json` / `bili-session.json` / `vr-session.json`）——
 * 这点不强行合并：它们的 cookie 形态、有效期、权限语义都不同，塞进一个文件只会让两边互相牵制。
 *
 * 但**用户 / AI 需要一个统一的「我现在登录了什么、哪里过期了」**。这里只做只读汇总，不写会话。
 *
 * 0.58.0：每个域在自己的 manifest 里登记 `sessions`（视图 + 清理），这里只放公共小工具，
 * core 不再 import 任何领域的 auth.ts。
 */
import { createHash } from 'node:crypto'
import { existsSync, rmSync, statSync } from 'node:fs'
import type { SessionProvider, SessionView } from './domain.ts'

export type { SessionView }

/** 会话文件存在但解析不出内容时，给出可操作的原因。 */
export function fileDiagnosis(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    const info = statSync(file)
    // 这些问题可以同时存在，全部报出来比只说一个更有用
    const issues: string[] = []
    if (info.size === 0) issues.push('文件是空的')
    if ((info.mode & 0o077) !== 0) issues.push('权限过于宽松（应 600）')
    return issues.length > 0 ? issues.join('；') : null
  } catch (err) {
    return `读不了：${(err as Error).message.slice(0, 80)}`
  }
}

/** 会话指纹：sha256 前 10 位。 */
export function digestOf(cookie: string): string {
  return createHash('sha256').update(cookie).digest('hex').slice(0, 10)
}

/** 没读到会话时的视图：区分「没登录」和「文件坏了」。 */
export function absentView(base: { domain: string; label: string; howToLogin: string }, file: string): SessionView {
  const issue = fileDiagnosis(file)
  return { ...base, state: issue ? 'stale_file' : 'not_logged_in', account: null, digest: null, savedAt: null, fileIssue: issue }
}

/** 删一个会话文件。 */
export function removeFile(file: string): void {
  if (existsSync(file)) rmSync(file, { force: true })
}

/**
 * 清掉指定域的本地会话。不传就清全部。
 *
 * 只删本地文件，**不调上游登出** —— 那由各域的 `logout` 命令负责（它们知道各自的端点和语义）。
 * 这里存在的意义是「会话文件坏了、正常 logout 都进不去」时还能收拾干净。
 */
export function clearSessions(providers: SessionProvider[], domains?: string[]): { cleared: string[]; failed: { domain: string; error: string }[] } {
  const targets = domains ? providers.filter((p) => domains.includes(p.domain)) : providers
  const cleared: string[] = []
  const failed: { domain: string; error: string }[] = []
  for (const p of targets) {
    try {
      p.clear()
      cleared.push(p.domain)
    } catch (err) {
      failed.push({ domain: p.domain, error: (err as Error).message.slice(0, 120) })
    }
  }
  return { cleared, failed }
}

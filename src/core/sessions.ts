/**
 * 登录状态的统一视图。
 *
 * 两个域的会话各存各的文件（`netease-session.json` / `bili-session.json`）——
 * 这点不强行合并：它们的 cookie 形态、有效期、权限语义都不同，塞进一个文件只会让两边互相牵制。
 *
 * 但**用户/ AI 需要一个统一的"我现在登录了什么、哪里过期了"**。这里只做只读汇总，不写会话。
 */
import { createHash } from 'node:crypto'
import { existsSync, rmSync, statSync } from 'node:fs'
import { homePath } from './paths.ts'
import { loadSession } from '../music/auth.ts'
import { biliSessionDigest, loadBiliSession } from '../bili/auth.ts'
import { loadSession as loadVrSession, clearSession as clearVrSession } from '../vr/auth.ts'

export type SessionState = 'logged_in' | 'not_logged_in' | 'stale_file'

export type Domain = 'netease' | 'bili' | 'vrchat'

export interface SessionView {
  domain: Domain
  label: string
  state: SessionState
  account: string | null
  /** 会话指纹（10 位），用来判断"是不是同一个账号"，不泄露内容。 */
  digest: string | null
  savedAt: string | null
  /** 文件存在但读不出来 —— 通常是权限或格式坏了。 */
  fileIssue: string | null
  /** 没有会话时怎么登录。 */
  howToLogin: string
}

/** 会话文件存在但解析不出内容时，给出可操作的原因。 */
function fileDiagnosis(file: string): string | null {
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

export function neteaseSessionView(): SessionView {
  const file = homePath('netease-session.json')
  const session = loadSession()
  if (!session) {
    const issue = fileDiagnosis(file)
    return {
      domain: 'netease',
      label: '网易云',
      state: issue ? 'stale_file' : 'not_logged_in',
      account: null,
      digest: null,
      savedAt: null,
      fileIssue: issue,
      howToLogin: 'astra music login start',
    }
  }
  return {
    domain: 'netease',
    label: '网易云',
    state: 'logged_in',
    account: session.nickname ?? session.userId ?? null,
    digest: digestOf(session.cookie),
    savedAt: session.savedAt,
    fileIssue: null,
    howToLogin: 'astra music login start',
  }
}

export function biliSessionView(): SessionView {
  const file = homePath('bili-session.json')
  const session = loadBiliSession()
  if (!session) {
    const issue = fileDiagnosis(file)
    return {
      domain: 'bili',
      label: 'B 站',
      state: issue ? 'stale_file' : 'not_logged_in',
      account: null,
      digest: null,
      savedAt: null,
      fileIssue: issue,
      howToLogin: 'astra bili login start',
    }
  }
  return {
    domain: 'bili',
    label: 'B 站',
    state: 'logged_in',
    account: (session.nickname ?? session.uid ?? null) ? `${session.nickname ?? session.uid}${session.vip ? '（大会员）' : ''}` : null,
    digest: biliSessionDigest(session),
    savedAt: session.savedAt,
    fileIssue: null,
    howToLogin: 'astra bili login start',
  }
}

/** 只取指纹，不复用各域的私有实现，避免把它们导出成公共 API。 */
function digestOf(cookie: string): string {
  // 与各域一致的算法（sha256 前 10 位）
  return createHash('sha256').update(cookie).digest('hex').slice(0, 10)
}

export function vrSessionView(): SessionView {
  const file = homePath('vr-session.json')
  const session = loadVrSession()
  if (!session) {
    const issue = fileDiagnosis(file)
    return {
      domain: 'vrchat',
      label: 'VRChat',
      state: issue ? 'stale_file' : 'not_logged_in',
      account: null,
      digest: null,
      savedAt: null,
      fileIssue: issue,
      howToLogin: 'astra vr login --username <账号> --password <密码>',
    }
  }
  return {
    domain: 'vrchat',
    label: 'VRChat',
    state: 'logged_in',
    account: session.displayName ?? session.userId ?? null,
    digest: digestOf(session.cookie),
    savedAt: session.savedAt,
    fileIssue: null,
    howToLogin: 'astra vr login --username <账号> --password <密码>',
  }
}

export function allSessions(): SessionView[] {
  return [neteaseSessionView(), biliSessionView(), vrSessionView()]
}

/**
 * 清掉指定域的本地会话。不传就清全部。
 *
 * 只删本地文件，**不调上游登出** —— 那由各域的 `logout` 命令负责（它们知道各自的端点和语义）。
 * 这里存在的意义是"会话文件坏了、正常 logout 都进不去"时还能收拾干净。
 */
export function clearSessions(domains?: Domain[]): { cleared: Domain[]; failed: { domain: Domain; error: string }[] } {
  const targets: Domain[] = domains ?? ['netease', 'bili', 'vrchat']
  const cleared: Domain[] = []
  const failed: { domain: Domain; error: string }[] = []
  for (const domain of targets) {
    const file =
      domain === 'netease' ? homePath('netease-session.json') : domain === 'bili' ? homePath('bili-session.json') : homePath('vr-session.json')
    try {
      if (existsSync(file)) rmSync(file, { force: true })
      cleared.push(domain)
    } catch (err) {
      failed.push({ domain, error: (err as Error).message.slice(0, 120) })
    }
  }
  // VRChat 的两步验证中间态也顺手清掉，否则下次登录可能读到过期的待确认
  if (targets.includes('vrchat')) clearVrSession()
  return { cleared, failed }
}

/**
 * 写操作审计。
 *
 * 为什么要它：红心、取消收藏、退群、删订阅这些**真的改动了用户的账号或数据**，
 * 但现在只在 stderr 打一行进度 —— 关掉终端就没了，"上周我是不是退错群了"没法回答。
 *
 * 记什么：
 * - 动作（`music.like` / `vr.groups.leave`）
 * - 结果（ok / failed）与失败原因
 * - 影响的对象的简短标识（歌名、群名），**不记 cookie、不记完整响应**
 * - 时间
 *
 * 不记什么：读操作、任务进度（那些有自己的表）。
 *
 * 存储：`<ASTRA_HOME>/astra.db` 的 `audit_log` 表，跟曲库同一个库 —— 备份时自然带上。
 */
import { db } from './db.ts'
import { progress } from './output.ts'

export interface AuditEntry {
  action: string
  /** 一句话说清改了什么，给人和 AI 看。 */
  summary: string
  ok: boolean
  /** 失败原因。 */
  error?: string
  /** 附带的结构化信息（对象 id 等），不放大段响应。 */
  detail?: Record<string, unknown>
}

export interface AuditRecord extends AuditEntry {
  id: number
  at: string
  /** 动作属于哪个域：从 action 的第一段取。 */
  domain: string
}

interface Row {
  id: number
  at: string
  action: string
  summary: string
  ok: number
  error: string | null
  detail: string | null
}

/**
 * 记一条。**失败不影响主流程** —— 审计是旁路，不能因为它没写进去就让红心失败。
 */
export function record(entry: AuditEntry): void {
  try {
    db()
      .prepare('insert into audit_log (at, action, summary, ok, error, detail) values (?, ?, ?, ?, ?, ?)')
      .run(
        new Date().toISOString(),
        entry.action,
        entry.summary.slice(0, 500),
        entry.ok ? 1 : 0,
        entry.error ? entry.error.slice(0, 500) : null,
        serializeDetail(entry.detail),
      )
  } catch (err) {
    // 写审计失败不能挡住正在做的事
    progress('audit.write_failed', { action: entry.action, error: (err as Error).message.slice(0, 120) })
  }
}

/**
 * 把 detail 序列化，但**不能对 JSON 字符串做字符截断** —— 切一半就变成非法 JSON，
 * 读的时候解析失败，整条记录都读不出来。
 * 所以：能放下就原样存；放不下就换成一句说明，而不是截断。
 */
function serializeDetail(detail: Record<string, unknown> | undefined): string | null {
  if (!detail) return null
  const json = JSON.stringify(detail)
  if (json.length <= 2000) return json
  return JSON.stringify({ truncated: true, keys: Object.keys(detail), originalLength: json.length })
}

function fromRow(row: Row): AuditRecord {
  return {
    id: row.id,
    at: row.at,
    action: row.action,
    domain: row.action.split('.')[0] ?? '',
    summary: row.summary,
    ok: row.ok === 1,
    ...(row.error ? { error: row.error } : {}),
    ...(parseDetail(row.detail) ? { detail: parseDetail(row.detail)! } : {}),
  }
}

/** detail 读不出来时不让整条记录失败（老数据可能是被截断的坏 JSON）。 */
function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { unreadable: true }
  }
}

export function listAudit(options: { limit?: number; domain?: string; failedOnly?: boolean; since?: string } = {}): AuditRecord[] {
  const rows = db()
    .prepare('select * from audit_log order by id desc limit ?')
    .all(Math.min(options.limit ?? 50, 500)) as unknown as Row[]
  return rows
    .map(fromRow)
    .filter((r) => (options.domain ? r.domain === options.domain : true))
    .filter((r) => (options.failedOnly ? !r.ok : true))
    .filter((r) => (options.since ? r.at >= options.since : true))
}

/** 清掉旧记录。默认保留最近 1000 条。 */
export function pruneAudit(keep = 1000): number {
  const total = (db().prepare('select count(*) n from audit_log').get() as { n: number }).n
  if (total <= keep) return 0
  const cutoff = db().prepare('select id from audit_log order by id desc limit 1 offset ?').get(keep) as { id: number } | undefined
  if (!cutoff) return 0
  return Number(db().prepare('delete from audit_log where id <= ?').run(cutoff.id).changes)
}

/**
 * 包一个写操作：自动记成功/失败。
 *
 * 用法：
 * ```ts
 * const result = await audited({ action: 'music.like', summary: `红心 ${title}` }, () => applyLike(...))
 * ```
 */
export async function audited<T>(entry: Omit<AuditEntry, 'ok' | 'error'>, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn()
    record({ ...entry, ok: true })
    return result
  } catch (err) {
    record({ ...entry, ok: false, error: (err as Error).message })
    throw err
  }
}

/**
 * stdout 只写一个 JSON 对象（AI 只解析这一个）；进度、诊断一律走 stderr。
 */
import { AstraError } from './errors.ts'

export interface Ok<T> {
  ok: true
  data: T
  /** 不影响成功、但 AI 应该转告用户的事（比如音质被降级、标签没写上）。 */
  warnings?: string[]
}

export interface Fail {
  ok: false
  error: { code: string; message: string; hint: string | null; retryable: boolean; details?: unknown }
}

export function okResult<T>(data: T, warnings: string[] = []): Ok<T> {
  return warnings.length > 0 ? { ok: true, data, warnings } : { ok: true, data }
}

export function failResult(err: AstraError): Fail {
  const error: Fail['error'] = { code: err.code, message: err.message, hint: err.hint, retryable: err.retryable }
  if (err.details !== undefined) error.details = err.details
  return { ok: false, error }
}

export function writeJson(value: unknown, pretty: boolean): void {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : undefined) + '\n')
}

/** 进度行。`ASTRA_QUIET=1` 时不输出。 */
export function progress(event: string, fields: Record<string, unknown> = {}): void {
  if (process.env.ASTRA_QUIET === '1') return
  process.stderr.write(JSON.stringify({ event, ...fields }) + '\n')
}

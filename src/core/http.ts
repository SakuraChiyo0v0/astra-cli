/**
 * 统一 HTTP：超时、有限重试、错误归一。
 *
 * 不默认跟随重定向之外的任何"聪明"行为；调用方拿到的状态码就是上游真实的。
 */
import { AstraError } from './errors.ts'

export interface HttpOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** 只对网络错误 / 5xx / 429 重试。 */
  retries?: number
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 15_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function httpRequest(url: string, options: HttpOptions = {}): Promise<Response> {
  const retries = options.retries ?? 1
  let lastError: unknown = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
    try {
      const init: RequestInit = { method: options.method ?? 'GET', signal }
      if (options.headers) init.headers = options.headers
      if (options.body !== undefined) init.body = options.body
      const response = await fetch(url, init)
      if ((response.status >= 500 || response.status === 429) && attempt < retries) {
        await response.body?.cancel()
        await sleep(500 * (attempt + 1))
        continue
      }
      return response
    } catch (err) {
      if (options.signal?.aborted) throw new AstraError('CANCELLED', '已取消', { exitCode: 130 })
      lastError = err
      if (attempt < retries) await sleep(500 * (attempt + 1))
    }
  }
  const host = safeHost(url)
  const reason = lastError instanceof Error ? (lastError.cause instanceof Error ? lastError.cause.message : lastError.message) : String(lastError)
  const timedOut = lastError instanceof Error && lastError.name === 'TimeoutError'
  throw new AstraError(timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', `请求 ${host} 失败：${reason}`, { exitCode: 5, retryable: true, cause: lastError })
}

export async function httpJson<T = unknown>(url: string, options: HttpOptions = {}): Promise<T> {
  const response = await httpRequest(url, options)
  const text = await response.text()
  if (response.status >= 400) {
    throw new AstraError('HTTP_ERROR', `${safeHost(url)} 返回 HTTP ${response.status}`, {
      exitCode: 5,
      retryable: response.status >= 500 || response.status === 429,
      details: { status: response.status },
    })
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new AstraError('BAD_RESPONSE', `${safeHost(url)} 返回的不是 JSON`, { exitCode: 5, details: { preview: text.slice(0, 120) } })
  }
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 40)
  }
}

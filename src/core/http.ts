/**
 * 统一 HTTP：超时、有限重试、错误归一。
 *
 * 不默认跟随重定向之外的任何"聪明"行为；调用方拿到的状态码就是上游真实的。
 *
 * 走代理与否在这里决定一次（见 core/proxy.ts），调用方完全无感：
 * 无论直连还是经代理，方法、body、重试策略、拿到的 `Response` 都一致。
 */
import { AstraError } from './errors.ts'
import { maybeProxiedRequest } from './proxy.ts'
import { progress } from './output.ts'

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

/** 该不该重试：5xx 与 429 是"过一会儿可能好"，4xx 不是。 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429
}

export async function httpRequest(url: string, options: HttpOptions = {}): Promise<Response> {
  const host = safeHost(url)
  const method = options.method ?? 'GET'
  const retries = options.retries ?? 1
  let lastError: unknown = null

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // —— 走代理 ——
    // 方法、body、重试都和直连那条路一致。早先这里只转发 headers，
    // 结果 POST 经代理会变成无 body 的 GET，而且 `retries` 被静默跳过。
    let proxied
    try {
      proxied = await maybeProxiedRequest(url, {
        method,
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.body !== undefined ? { body: options.body } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (err) {
      // 代理建不上连接要按网络错误处理：给 NETWORK_ERROR / 可重试 / exitCode 5，
      // 而不是把 "connect ECONNREFUSED" 当成 INTERNAL 漏出去。
      if (options.signal?.aborted) throw new AstraError('CANCELLED', '已取消', { exitCode: 130 })
      lastError = err
      if (attempt < retries) {
        await sleep(500 * (attempt + 1))
        continue
      }
      throw networkError(host, err, '（经代理）')
    }

    if (proxied) {
      progress('http.proxy', { host, method, status: proxied.status })
      if (isRetryableStatus(proxied.status) && attempt < retries) {
        await sleep(500 * (attempt + 1))
        continue
      }
      return new Response(proxied.body, { status: proxied.status, headers: proxied.headers })
    }

    // —— 直连 ——
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
    try {
      const init: RequestInit = { method, signal }
      if (options.headers) init.headers = options.headers
      if (options.body !== undefined) init.body = options.body
      const response = await fetch(url, init)
      if (isRetryableStatus(response.status) && attempt < retries) {
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

  throw networkError(host, lastError)
}

/** 网络层的失败统一归一：TIMEOUT / NETWORK_ERROR，都是可重试的 exitCode 5。 */
function networkError(host: string, cause: unknown, via = ''): AstraError {
  if (cause instanceof AstraError) return cause
  const reason = cause instanceof Error
    ? (cause.cause instanceof Error ? cause.cause.message : cause.message)
    : String(cause)
  const timedOut = cause instanceof Error && cause.name === 'TimeoutError'
  const code = timedOut ? 'TIMEOUT' : 'NETWORK_ERROR'
  const hint = via.includes('代理') ? '检查代理是否在运行、和目标容器在同一个 docker 网络（`astra doctor`）' : null
  return new AstraError(code, `请求 ${host} 失败${via}：${reason}`, {
    exitCode: 5,
    retryable: true,
    ...(hint ? { hint } : {}),
    cause,
  })
}

export async function httpJson<T = unknown>(url: string, options: HttpOptions = {}): Promise<T> {
  const response = await httpRequest(url, options)
  const text = await response.text()
  if (response.status >= 400) {
    throw new AstraError('HTTP_ERROR', `${safeHost(url)} 返回 HTTP ${response.status}`, {
      exitCode: 5,
      retryable: isRetryableStatus(response.status),
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

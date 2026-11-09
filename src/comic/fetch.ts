/**
 * 漫画站共用的请求：走 core/http（超时、重试、按域代理）。
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest, safeHost } from '../core/http.ts'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export interface FetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export async function fetchBytes(url: string, options: FetchOptions = {}): Promise<{ status: number; body: Buffer }> {
  const response = await httpRequest(url, {
    ...(options.method ? { method: options.method } : {}),
    headers: { 'user-agent': UA, accept: '*/*', ...options.headers },
    ...(options.body !== undefined ? { body: options.body } : {}),
    retries: 2,
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()) }
}

function httpError(url: string, status: number): AstraError {
  if (status === 404) return new AstraError('NOT_FOUND', `${safeHost(url)} 上没有这一页`, { exitCode: 4, details: { url } })
  return new AstraError('HTTP_ERROR', `${safeHost(url)} 返回 HTTP ${status}`, {
    exitCode: 5,
    retryable: status >= 500 || status === 429,
    details: { status },
  })
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const { status, body } = await fetchBytes(url, options)
  if (status >= 400) throw httpError(url, status)
  const text = body.toString('utf8')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new AstraError('BAD_RESPONSE', `${safeHost(url)} 返回的不是 JSON`, { exitCode: 5, retryable: true, details: { preview: text.slice(0, 120) } })
  }
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const { status, body } = await fetchBytes(url, options)
  if (status >= 400) throw httpError(url, status)
  return body.toString('utf8')
}

/** 认图片格式：靠魔数，不信 content-type 和扩展名。 */
export function imageExt(b: Buffer): 'jpg' | 'png' | 'webp' | 'gif' | null {
  if (b.length < 12) return null
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg'
  if (b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png'
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif'
  return null
}

/** 下一张图；不是图片（被换成错误页）时抛错，别把 HTML 当图存下来。 */
export async function fetchImage(url: string, options: FetchOptions = {}): Promise<{ status: number; body: Buffer }> {
  const r = await fetchBytes(url, { timeoutMs: 60_000, ...options })
  return r
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AstraError('CANCELLED', '已取消', { exitCode: 130 }))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new AstraError('CANCELLED', '已取消', { exitCode: 130 }))
    }, { once: true })
  })
}

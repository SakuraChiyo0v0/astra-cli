/**
 * 小说站共用的取页：走 core/http（超时、重试、按域代理），按编码解码。
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest, safeHost } from '../core/http.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export interface FetchOptions {
  referer?: string
  encoding?: string
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * 慢一档的重试：core/http 自己的重试在 1.5 秒内打完，扛不住代理几秒钟的抖动。
 * 实测：索引任务和抓章任务同时压 mihomo 时，有一阵子连续返回空响应（「找不到头部结束标记」），
 * 持续三五秒；单章失败只能等整个任务 resume。这里对可重试的错误再等 3 秒、8 秒各试一次。
 */
const BACKOFF_MS = [3_000, 8_000]

export async function fetchBytes(url: string, options: FetchOptions = {}): Promise<{ status: number; body: Buffer; type: string }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await httpRequest(url, {
        headers: { 'user-agent': UA, referer: options.referer ?? url, accept: '*/*' },
        retries: 2,
        timeoutMs: options.timeoutMs ?? 30_000,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      const body = Buffer.from(await response.arrayBuffer())
      return { status: response.status, body, type: response.headers.get('content-type') ?? '' }
    } catch (err) {
      const wait = BACKOFF_MS[attempt]
      if (!(err instanceof AstraError) || !err.retryable || wait === undefined || options.signal?.aborted) throw err
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

/** 取一页文本。404 归为 NOT_FOUND，其它 4xx/5xx 抛 HTTP_ERROR。 */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const { status, body } = await fetchBytes(url, options)
  if (status === 404) throw new AstraError('NOT_FOUND', `${safeHost(url)} 上没有这一页`, { exitCode: 4, details: { url } })
  if (status >= 400) {
    throw new AstraError('HTTP_ERROR', `${safeHost(url)} 返回 HTTP ${status}`, {
      exitCode: 5,
      retryable: status >= 500 || status === 429,
      details: { status },
    })
  }
  return new TextDecoder(options.encoding ?? 'utf-8').decode(body)
}

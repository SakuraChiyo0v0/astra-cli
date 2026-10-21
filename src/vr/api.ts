/**
 * VRChat API 传输层。
 *
 * 官方源固定为 `https://api.vrchat.cloud/api/1`，不接受任意地址（同音乐域对网易云的做法）。
 *
 * 实测/沿用自 astrahub 的已知事实：
 * - **必须带 `User-Agent`**，缺了会被 Cloudflare 直接拦成 403，看不出原因
 * - 登录是 **GET** `/auth/user` + Basic 认证；用 POST 会 405
 * - 会话是 cookie 里那条 `auth=<uuid>`
 * - 401/403 = 会话不被接受；404 = 没有该对象；429 = 频率受限
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'

const OFFICIAL = 'https://api.vrchat.cloud'
export const API_BASE = `${OFFICIAL}/api/1`
/** VRChat 要求可识别的 UA；这里带上自己的名字。 */
export const USER_AGENT = 'astra-cli/0.6 (https://github.com/SakuraChiyo0v0)'

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface ApiOptions {
  query?: Record<string, string | number | boolean | undefined>
  body?: Record<string, unknown>
  /** 会话 cookie，形如 `auth=xxxx`。登录接口自己带 Basic。 */
  cookie?: string | null
  /** Basic 认证头（登录时用），传原始 `user:pass` 串。 */
  basic?: string
  signal?: AbortSignal
  timeoutMs?: number
}

export function basicHeader(username: string, password: string): string {
  // VRChat 要求先对每一项做 URL 编码再 base64（密码里有 `@`、`:` 等符号时的实测结论）
  return `Basic ${Buffer.from(`${encodeURIComponent(username)}:${encodeURIComponent(password)}`).toString('base64')}`
}

export class VrError extends AstraError {
  readonly status: number
  constructor(code: string, message: string, status: number, options: { hint?: string; retryable?: boolean; details?: unknown } = {}) {
    super(code, message, {
      exitCode: status === 401 || status === 403 ? 3 : status === 404 ? 4 : 5,
      retryable: options.retryable ?? (status === 429 || status >= 500),
      ...(options.hint === undefined ? {} : { hint: options.hint }),
      ...(options.details === undefined ? {} : { details: options.details }),
    })
    this.status = status
  }
}

function buildUrl(path: string, query: ApiOptions['query']): string {
  const url = new URL(`${API_BASE}${path}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/** 发一次请求并解析 JSON。返回值与状态码一起给，方便调用方判断 204。 */
export async function request<T = unknown>(method: Method, path: string, options: ApiOptions = {}): Promise<{ status: number; data: T | null; setCookies: string[] }> {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: 'application/json',
  }
  if (options.cookie) headers.cookie = options.cookie
  if (options.basic) headers.authorization = options.basic
  const init: Parameters<typeof httpRequest>[1] = { method, headers, timeoutMs: options.timeoutMs ?? 20_000, retries: 1 }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  if (options.signal) init.signal = options.signal

  const response = await httpRequest(buildUrl(path, options.query), init)
  const setCookies = response.headers.getSetCookie?.() ?? []
  const text = await response.text()
  let data: T | null = null
  if (text.trim().length > 0) {
    try {
      data = JSON.parse(text) as T
    } catch {
      throw new VrError('VRCHAT_BAD_RESPONSE', `VRChat 返回的不是 JSON：${text.slice(0, 120)}`, response.status)
    }
  }

  if (response.status >= 400) {
    const detail = data as { error?: { message?: string }; message?: string } | null
    const upstream = detail?.error?.message ?? detail?.message ?? ''
    const hint =
      response.status === 401 || response.status === 403
        ? '会话失效或没有权限；`astra vr login` 重新登录'
        : response.status === 429
          ? '被限流，等一会儿再试'
          : undefined
    throw new VrError(
      response.status === 401 ? 'VRCHAT_UNAUTHORIZED' : response.status === 404 ? 'VRCHAT_NOT_FOUND' : 'VRCHAT_HTTP_ERROR',
      `VRChat ${method} ${path} 返回 HTTP ${response.status}${upstream ? `：${upstream}` : ''}`,
      response.status,
      { ...(hint === undefined ? {} : { hint }), details: { status: response.status, body: data } },
    )
  }
  return { status: response.status, data, setCookies }
}

/** 只要数据的简写。204 返回 null。 */
export async function getJson<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { data } = await request<T>('GET', path, options)
  if (data === null) throw new VrError('VRCHAT_EMPTY', `VRChat ${path} 没有返回内容`, 200, { retryable: true })
  return data
}

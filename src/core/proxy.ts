/**
 * 按域走代理。
 *
 * ## 为什么需要
 *
 * astra 跑在 NAS 的 Hermes 容器里。NAS 上 Steam 全域名不通（实测
 * `api.steampowered.com` 超时、`store.steampowered.com` 连接超时），
 * 但 B 站、网易云正常。NAS 上另有一个 mihomo 容器提供代理（`http://mihomo:7890`），
 * 走它能访问 Steam（实测四个域名全 200）。
 *
 * ## 为什么不能全局设代理
 *
 * 全局代理会让 B 站、网易云的请求也绕一圈：慢、多一跳、还可能触发风控
 * （B 站对代理 IP 更敏感）。所以**按域名决定**。
 *
 * ## 为什么不用 undici 或 NODE_USE_ENV_PROXY
 *
 * - `undici` 要额外装 2MB 依赖
 * - `NODE_USE_ENV_PROXY` 是**进程级**开关，没法按请求切换
 *
 * 这里用 `node:http` 的 CONNECT 建隧道，零依赖，且能精确控制每个请求。
 * 只支持 http/https 代理（SOCKS 需要额外协议握手，暂时不做）。
 *
 * ## 必须保留原始方法与 body
 *
 * 早先的实现把请求行硬写成 `GET`、body 直接丢掉 —— 只对"查一下"够用，
 * 但 `proxy.include` 留空表示"全部走"，那样网易云的登录轮询、红心、
 * 飞书 webhook 会全部静默变成无 body 的 GET，看起来像上游坏了。
 * 现在把 method / body / Content-Length 原样带过去（见 tests/proxy.test.ts）。
 */
import http from 'node:http'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { getConfig } from './config.ts'

export interface ProxyConfig {
  url: string
  /** 哪些域名走代理。空数组 = 全部走。 */
  include: string[]
  /** 哪些域名**不**走代理（优先级高于 include）。 */
  exclude: string[]
}

/**
 * 读取代理配置。
 *
 * 配置项：
 * - `proxy.url`：代理地址，例如 `http://mihomo:7890`。留空 = 不用代理。
 * - `proxy.include`：逗号分隔的域名后缀，例如 `steampowered.com,steamcommunity.com`
 * - `proxy.exclude`：逗号分隔的排除项，例如 `bilibili.com,music.163.com`
 *
 * 环境变量优先（方便临时覆盖）：`ASTRA_PROXY`
 */
export function proxyConfig(): ProxyConfig | null {
  const url = (process.env.ASTRA_PROXY || getConfig('proxy.url') || '').trim()
  if (!url) return null
  const split = (text: string): string[] => text.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return {
    url,
    include: split(process.env.ASTRA_PROXY_INCLUDE ?? getConfig('proxy.include') ?? ''),
    exclude: split(process.env.ASTRA_PROXY_EXCLUDE ?? getConfig('proxy.exclude') ?? ''),
  }
}

/** 这个主机名要不要走代理。 */
export function shouldProxy(host: string, config: ProxyConfig | null = proxyConfig()): boolean {
  // 没配置代理就一律直连 —— 早先默认参数写成了 `proxyConfig() ?? {...}`，
  // 但那是给"参数未传"兜底，proxyConfig() 返回 null 时照样传进来崩掉
  if (!config || !config.url) return false
  const target = host.toLowerCase()
  const matches = (suffix: string): boolean => target === suffix || target.endsWith(`.${suffix}`)
  if (config.exclude.some(matches)) return false
  if (config.include.length === 0) return true
  return config.include.some(matches)
}

/** 超时错误要带 `name = 'TimeoutError'`，上层靠这个名字区分超时和普通网络错误。 */
function timeoutError(message: string): Error {
  const err = new Error(message)
  err.name = 'TimeoutError'
  return err
}

/** 建一条到目标主机的隧道，返回裸 socket（HTTPS 还要在外面套 TLS）。 */
export function openTunnel(proxyUrl: string, host: string, port: number, timeoutMs = 20_000): Promise<import('node:net').Socket> {
  return new Promise((resolve, reject) => {
    let proxy: URL
    try {
      proxy = new URL(proxyUrl)
    } catch {
      reject(new Error(`代理地址不合法：${proxyUrl}`))
      return
    }
    if (proxy.protocol !== 'http:') {
      reject(new Error(`只支持 http:// 代理，收到 ${proxy.protocol}`))
      return
    }
    const request = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
      timeout: timeoutMs,
      ...(proxy.username ? { auth: `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}` } : {}),
    })
    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`代理拒绝建立隧道：CONNECT ${response.statusCode}`))
        return
      }
      resolve(socket)
    })
    request.on('error', reject)
    request.on('timeout', () => request.destroy(timeoutError(`代理连接超时（${Math.round(timeoutMs / 1000)} 秒）`)))
    request.end()
  })
}

export interface ProxiedResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

export interface ProxiedRequestOptions {
  /** 默认 GET。**必须原样带给上游** —— 见文件头的说明。 */
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer
  timeoutMs?: number
  /** 覆盖 `proxy.url`（测试用）。 */
  proxyUrl?: string
  signal?: AbortSignal
}

const CRLF = '\r\n'
const HEADER_END = Buffer.from(`${CRLF}${CRLF}`, 'latin1')
const CRLF_BUF = Buffer.from(CRLF, 'latin1')

/** 响应体解压后会比原始字节长，header 里的长度和编码标记要跟着改，否则调用方会误判。 */
function fixFramingHeaders(headers: Record<string, string>, body: Buffer): void {
  delete headers['transfer-encoding']
  delete headers['content-encoding']
  headers['content-length'] = String(body.length)
}

/** 按 content-encoding 兜底解压。有的服务器无视 `Accept-Encoding: identity` 照样压缩。 */
function decodeBody(body: Buffer, encoding: string): Buffer {
  const tryDecode = (fn: (input: Buffer) => Buffer): Buffer => {
    try {
      return fn(body)
    } catch {
      // 解不开就原样返回，让调用方看到原始字节而不是骗它说成功了
      return body
    }
  }
  if (encoding.includes('gzip')) return tryDecode((b) => zlib.gunzipSync(b))
  if (encoding.includes('deflate')) return tryDecode((b) => zlib.inflateSync(b))
  if (encoding.includes('br')) return tryDecode((b) => zlib.brotliDecompressSync(b))
  return body
}

/**
 * 经代理发一个请求（任意方法）。
 *
 * **直接在隧道 socket 上写 HTTP 请求，不走 `https.request`。**
 * 后者在已完成 TLS 握手的 socket 上会再握手一次，Steam 商店接口会因此返回 400（实测）。
 *
 * 同样的原因，请求行、方法、body 都是自己拼的 —— 所以也就必须自己保证
 * method / body / Content-Length 与调用方给的一致。
 */
export async function proxiedRequest(url: string, options: ProxiedRequestOptions = {}): Promise<ProxiedResponse> {
  const config = proxyConfig()
  const proxyUrl = options.proxyUrl ?? config?.url
  if (!proxyUrl) throw new Error('没有配置代理')

  const target = new URL(url)
  const isTls = target.protocol === 'https:'
  if (!isTls && target.protocol !== 'http:') {
    throw new Error(`经代理只支持 http / https，收到 ${target.protocol}`)
  }

  const port = Number(target.port || (isTls ? 443 : 80))
  const timeoutMs = options.timeoutMs ?? 20_000
  const method = (options.method ?? 'GET').toUpperCase()
  const body = options.body === undefined
    ? null
    : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body, 'utf8')

  const socket = await openTunnel(proxyUrl, target.hostname, port, timeoutMs)

  return await new Promise<ProxiedResponse>((resolve, reject) => {
    // https 在隧道上再套一层 TLS；http 直接用隧道 socket 说话
    const conn = isTls ? tls.connect({ socket, servername: target.hostname }) : socket
    let settled = false

    const finish = (): void => {
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    const timer = setTimeout(() => {
      if (settled) return
      finish()
      conn.destroy()
      reject(timeoutError(`经代理请求超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)

    const onAbort = (): void => {
      if (settled) return
      finish()
      conn.destroy()
      const err = new Error('已取消')
      err.name = 'AbortError'
      reject(err)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    conn.on('error', (err) => {
      if (settled) return
      finish()
      reject(err)
    })

    const send = (): void => {
      const headers = options.headers ?? {}
      // 这几个头由本函数自己决定，调用方的值会被覆盖或丢弃：
      // host / content-length 要按实际目标与字节数算，connection 固定 close，
      // accept-encoding 固定 identity，user-agent 单独取值后统一写。
      const extra = Object.entries(headers)
        .filter(([k]) => !/^(host|connection|content-length|accept-encoding|user-agent)$/i.test(k))
        .map(([k, v]) => `${k}: ${v}`)
      const lines = [
        `${method} ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.host}`,
        `User-Agent: ${headers['user-agent'] ?? 'astra-cli'}`,
        `Accept: ${headers.accept ?? '*/*'}`,
        'Accept-Encoding: identity',
        'Connection: close',
        ...(body ? [`Content-Length: ${body.length}`] : []),
        ...extra,
      ]
      conn.write(lines.join(CRLF) + CRLF + CRLF)
      if (body) conn.write(body)
    }

    const chunks: Buffer[] = []
    conn.on('data', (chunk: Buffer) => chunks.push(chunk))
    conn.on('end', () => {
      if (settled) return
      finish()
      const raw = Buffer.concat(chunks)
      const separator = raw.indexOf(HEADER_END)
      if (separator < 0) {
        reject(new Error('代理响应格式异常（找不到头部结束标记）'))
        return
      }
      const head = raw.subarray(0, separator).toString('latin1')
      let responseBody: Buffer = Buffer.from(raw.subarray(separator + 4))
      const [statusLine, ...headerLines] = head.split(CRLF)
      const status = Number(statusLine?.split(' ')[1] ?? Number.NaN)
      if (!Number.isFinite(status) || status < 100) {
        reject(new Error(`代理响应格式异常（状态行：${statusLine ?? '(空)'}）`))
        return
      }
      const responseHeaders: Record<string, string> = {}
      for (const line of headerLines) {
        const colon = line.indexOf(':')
        if (colon > 0) responseHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      if (responseHeaders['transfer-encoding']?.includes('chunked')) responseBody = dechunk(responseBody)
      responseBody = decodeBody(responseBody, responseHeaders['content-encoding'] ?? '')
      fixFramingHeaders(responseHeaders, responseBody)
      resolve({ status, headers: responseHeaders, body: responseBody })
    })

    if (isTls) {
      (conn as import('node:tls').TLSSocket).on('secureConnect', send)
    } else {
      send()
    }
  })
}

/** 解 chunked 编码。Steam 的响应常是 chunked。 */
function dechunk(input: Buffer): Buffer {
  const parts: Buffer[] = []
  let offset = 0
  while (offset < input.length) {
    const lineEnd = input.indexOf(CRLF_BUF, offset)
    if (lineEnd < 0) break
    const size = Number.parseInt(input.subarray(offset, lineEnd).toString('latin1'), 16)
    if (!Number.isFinite(size) || size === 0) break
    const start = lineEnd + 2
    parts.push(input.subarray(start, start + size))
    offset = start + size + 2
  }
  return parts.length > 0 ? Buffer.concat(parts) : input
}

/** 该主机走代理就经代理发，否则返回 null 让调用方走普通 fetch。 */
export async function maybeProxiedRequest(
  url: string,
  options: Omit<ProxiedRequestOptions, 'proxyUrl'> = {},
): Promise<ProxiedResponse | null> {
  const config = proxyConfig()
  if (!config) return null
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }
  if (!shouldProxy(host, config)) return null
  return await proxiedRequest(url, { ...options, proxyUrl: config.url })
}

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
 */
import http from 'node:http'
import https from 'node:https'
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
    include: split(getConfig('proxy.include') || ''),
    exclude: split(getConfig('proxy.exclude') || ''),
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
    request.on('timeout', () => request.destroy(new Error(`代理连接超时（${Math.round(timeoutMs / 1000)} 秒）`)))
    request.end()
  })
}


export interface ProxiedResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

const CRLF = String.fromCharCode(13) + String.fromCharCode(10)
const HEADER_END = Buffer.from(CRLF + CRLF, 'latin1')
const CRLF_BUF = Buffer.from(CRLF, 'latin1')

/**
 * 经代理发一个 GET。
 *
 * **直接在隧道 socket 上写 HTTP 请求，不走 `https.request`。**
 * 后者在已完成 TLS 握手的 socket 上会再握手一次，Steam 商店接口会因此返回 400（实测）。
 */
export async function proxiedGet(
  url: string,
  options: { headers?: Record<string, string>; timeoutMs?: number; proxyUrl?: string; signal?: AbortSignal } = {},
): Promise<ProxiedResponse> {
  const config = proxyConfig()
  const proxyUrl = options.proxyUrl ?? config?.url
  if (!proxyUrl) throw new Error('没有配置代理')

  const target = new URL(url)
  if (target.protocol !== 'https:') throw new Error(`经代理只支持 https，收到 ${target.protocol}`)

  const timeoutMs = options.timeoutMs ?? 20_000
  const socket = await openTunnel(proxyUrl, target.hostname, Number(target.port || 443), timeoutMs)

  return await new Promise<ProxiedResponse>((resolve, reject) => {
    const secure = tls.connect({ socket, servername: target.hostname })
    const timer = setTimeout(() => {
      secure.destroy()
      reject(new Error(`经代理请求超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      secure.destroy()
      reject(new Error('已取消'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = (): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    secure.on('error', (err) => {
      cleanup()
      reject(err)
    })

    secure.on('secureConnect', () => {
      const agent = options.headers?.['user-agent'] ?? 'astra-cli'
      const extra = Object.entries(options.headers ?? {})
        .filter(([k]) => !/^(host|connection|accept-encoding|user-agent)$/i.test(k))
        .map(([k, v]) => `${k}: ${v}`)
      const lines = [
        `GET ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.host}`,
        `User-Agent: ${agent}`,
        'Accept: application/json',
        'Accept-Encoding: identity',
        'Connection: close',
        ...extra,
      ]
      secure.write(lines.join(CRLF) + CRLF + CRLF)

      const chunks: Buffer[] = []
      secure.on('data', (chunk: Buffer) => chunks.push(chunk))
      secure.on('end', () => {
        cleanup()
        const raw = Buffer.concat(chunks)
        const separator = raw.indexOf(HEADER_END)
        if (separator < 0) {
          reject(new Error('代理响应格式异常（找不到头部结束标记）'))
          return
        }
        const head = raw.subarray(0, separator).toString('latin1')
        let body: Buffer = Buffer.from(raw.subarray(separator + 4))
        const [statusLine, ...headerLines] = head.split(CRLF)
        const status = Number(statusLine?.split(' ')[1] ?? 0)
        const headers: Record<string, string> = {}
        for (const line of headerLines) {
          const colon = line.indexOf(':')
          if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
        }
        if (headers['transfer-encoding']?.includes('chunked')) body = dechunk(body)
        // 有的服务器无视 Accept-Encoding: identity 照样 gzip（Steam 的 429 响应就是）。
        // 不在这里解开，调用方拿到的是乱码，JSON.parse 会失败，错误信息也会变得莫名其妙。
        const encoding = headers['content-encoding'] ?? ''
        if (encoding.includes('gzip')) {
          try {
            body = zlib.gunzipSync(body)
          } catch {
            // 解不开就原样返回，让调用方看到原始字节而不是骗它说成功了
          }
        } else if (encoding.includes('deflate')) {
          try {
            body = zlib.inflateSync(body)
          } catch {
            /* 同上 */
          }
        } else if (encoding.includes('br')) {
          try {
            body = zlib.brotliDecompressSync(body)
          } catch {
            /* 同上 */
          }
        }
        resolve({ status, headers, body })
      })
    })
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

/** 该主机走代理就用 proxiedGet，否则返回 null 让调用方走普通 fetch。 */
export async function maybeProxiedGet(
  url: string,
  options: { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {},
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
  return await proxiedGet(url, { ...options, proxyUrl: config.url })
}

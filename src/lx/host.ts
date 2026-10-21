/**
 * 洛雪自定义音源宿主。
 *
 * 音源脚本只是"拿播放直链"的适配器：搜索、元数据、歌词都不靠它。
 * 每个脚本在独立的 `vm` 上下文里跑，只给它洛雪约定的那几样东西。
 *
 * 实测踩到的形状（2026-10-21，qdy v9.3）：
 * - 脚本在顶层就 `const { EVENT_NAMES, request, on, send } = globalThis.lx`，所以 `lx` 必须在 globalThis 上
 * - `resp.body` 要同时支持 `JSON.parse(body)` 与 `body.code` 两种写法 —— 做成挂了字段的 String 对象
 * - 头部注释（@name/@version）有的脚本会在加载期读 `currentScriptInfo`，缺了直接抛错
 * - 返回的"直链"可能是一个 404 的 php 地址：脚本只校验 `^https?://`，所以宿主拿到后必须自己探测
 *
 * 注意：vm 不是安全边界。脚本是用户自己导入的，按"用户信任它"处理；这里只限制意外而不是恶意。
 */
import vm from 'node:vm'
import crypto from 'node:crypto'

export interface LxMusicInfo {
  source: string
  name: string
  singer: string
  albumName: string
  songmid: string
  hash: string
  id: string
  /** 秒。 */
  interval: number
}

export interface LxSourceDecl {
  name: string
  type?: string
  actions: string[]
  qualitys: string[]
}

export interface LoadedLxSource {
  name: string
  version: string
  description: string
  sources: Record<string, LxSourceDecl>
  musicUrl: (platform: string, quality: string, info: LxMusicInfo, timeoutMs?: number) => Promise<string>
}

type RequestHandler = (payload: { action: string; source: string; info: Record<string, unknown> }) => unknown

const REQUEST_TIMEOUT_CAP_MS = 45_000
const INIT_WAIT_MS = 20_000

export interface ScriptMeta { name: string; description: string; version: string; author: string; homepage: string }

export function parseScriptMeta(code: string): ScriptMeta {
  const head = code.slice(0, 2000)
  const pick = (key: string): string => head.match(new RegExp('@' + key + '\\s+([^\\r\\n*]+)'))?.[1]?.trim() ?? ''
  return {
    name: pick('name'),
    description: pick('description'),
    version: pick('version'),
    author: pick('author'),
    homepage: pick('homepage'),
  }
}

/** 洛雪宿主给 `resp.body` 的形态：String 实例，JSON 时再把字段挂上去。 */
export function makeLxBody(text: string): String {
  const boxed = new String(text)
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object') Object.assign(boxed, parsed)
  } catch {
    // 不是 JSON 就只当文本
  }
  return boxed
}

type LxCallback = (err: Error | null, resp?: { statusCode: number; headers: Record<string, string>; body: String }) => void

function makeRequest(trace?: (entry: { url: string; status?: number; error?: string; ms: number }) => void) {
  return (url: string, options: Record<string, unknown> | undefined, callback: LxCallback): { abort: () => void } => {
    const opt = options ?? {}
    const method = String(opt.method ?? 'GET').toUpperCase()
    const controller = new AbortController()
    const timeout = typeof opt.timeout === 'number' ? Math.min(Math.max(opt.timeout, 1000), REQUEST_TIMEOUT_CAP_MS) : 25_000
    const init: RequestInit = {
      method,
      headers: (opt.headers as Record<string, string> | undefined) ?? {},
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
    }
    if (opt.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      init.body = typeof opt.body === 'string' ? opt.body : JSON.stringify(opt.body)
    } else if (opt.form && typeof opt.form === 'object' && method !== 'GET') {
      init.body = new URLSearchParams(opt.form as Record<string, string>).toString()
      init.headers = { 'Content-Type': 'application/x-www-form-urlencoded', ...(init.headers as Record<string, string>) }
    }
    const started = Date.now()
    fetch(url, init)
      .then(async (res) => {
        const text = await res.text()
        const headers: Record<string, string> = {}
        for (const [key, value] of res.headers) headers[key] = value
        trace?.({ url, status: res.status, ms: Date.now() - started })
        callback(null, { statusCode: res.status, headers, body: makeLxBody(text) })
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err))
        trace?.({ url, error: error.message, ms: Date.now() - started })
        callback(error)
      })
    return { abort: () => controller.abort() }
  }
}

function aesEncrypt(buffer: unknown, mode: string, key: unknown, iv: unknown): Buffer {
  const toBuf = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? '')))
  const k = toBuf(key)
  const algorithm = `aes-${k.length * 8}-${String(mode).replace(/^aes-\d+-/i, '').toLowerCase() || 'cbc'}`
  const cipher = crypto.createCipheriv(algorithm, k, algorithm.endsWith('ecb') ? null : toBuf(iv))
  return Buffer.concat([cipher.update(toBuf(buffer)), cipher.final()])
}

function rsaEncrypt(buffer: unknown, key: string): Buffer {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer))
  const padded = Buffer.concat([Buffer.alloc(Math.max(0, 128 - data.length)), data])
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, padded)
}

export interface LoadOptions {
  /** 调试用：记录脚本发出的每个请求。 */
  trace?: (entry: { url: string; status?: number; error?: string; ms: number }) => void
  /** 把脚本的 console 输出接出来（默认丢弃）。 */
  log?: (line: string) => void
}

export async function loadLxSource(code: string, filename: string, options: LoadOptions = {}): Promise<LoadedLxSource> {
  const meta = parseScriptMeta(code)
  let inited: Record<string, LxSourceDecl> | null = null
  const handlers: RequestHandler[] = []
  const log = options.log ?? (() => {})

  const lx = {
    EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
    request: makeRequest(options.trace),
    on(event: string, handler: unknown): void {
      if (event === 'request' && typeof handler === 'function') handlers.push(handler as RequestHandler)
    },
    send(event: string, data: unknown): void {
      if (event === 'inited') {
        const sources = (data as { sources?: Record<string, LxSourceDecl> } | null)?.sources
        inited = sources ?? {}
      }
    },
    utils: {
      crypto: {
        md5: (input: unknown): string => crypto.createHash('md5').update(String(input)).digest('hex'),
        randomBytes: (n: number): Buffer => crypto.randomBytes(n),
        aesEncrypt,
        rsaEncrypt,
      },
      buffer: {
        from: (data: unknown, encoding?: BufferEncoding): Buffer =>
          Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data), encoding),
        bufToString: (buf: unknown, format?: BufferEncoding): string =>
          (Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf))).toString(format ?? 'utf8'),
      },
    },
    env: 'desktop',
    version: '2.13.0',
    currentScriptInfo: { ...meta, rawScript: code },
  }

  const sink = (...args: unknown[]): void => log(args.map(String).join(' '))
  const sandbox: Record<string, unknown> = {
    lx,
    console: { log: sink, info: sink, warn: sink, error: sink, debug: () => {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    fetch,
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    Buffer,
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox, { name: 'lx-source', codeGeneration: { strings: true, wasm: false } })
  new vm.Script(code, { filename }).runInContext(context, { timeout: 15_000 })

  const deadline = Date.now() + INIT_WAIT_MS
  while (inited === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  if (inited === null) throw new Error('音源脚本没有上报 inited（可能依赖了宿主未实现的环境）')
  const handler = handlers[0]
  if (!handler) throw new Error('音源脚本没有注册 request 处理函数')
  // 声明来自脚本的 realm，拷成宿主自己的普通对象，免得 instanceof / 深比较出怪事
  const sources = JSON.parse(JSON.stringify(inited)) as Record<string, LxSourceDecl>

  return {
    name: meta.name || filename,
    version: meta.version,
    description: meta.description,
    sources,
    async musicUrl(platform, quality, info, timeoutMs = 60_000) {
      let timer: NodeJS.Timeout | undefined
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => handler({ action: 'musicUrl', source: platform, info: { type: quality, musicInfo: info } })),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('音源取链超时')), timeoutMs)
          }),
        ])
        if (typeof result !== 'string' || !/^https?:\/\//i.test(result.trim())) {
          throw new Error('音源返回的不是 http(s) 地址')
        }
        return result.trim()
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}

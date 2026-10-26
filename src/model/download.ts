/**
 * 大文件下载：分段并发 + 断点续传 + sha256 校验。
 *
 * 为什么不走 core/http.ts：那个默认 15s 超时、整体重试，适合小 JSON；
 * 拉 6 GB 权重只会一直超时。这里按区间分片，每片一次请求，并发拉完再拼接。
 *
 * 代理：有代理配置时走 `proxiedRequest`（自己拼请求行，Steam 那套踩过的坑），
 * 没有就直连 `fetch`。两条路径对调用方无感。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { AstraError } from '../core/errors.ts'
import { proxiedRequest, proxyConfig, shouldProxy } from '../core/proxy.ts'

export interface DownloadOptions {
  url: string
  out: string
  headers?: Record<string, string>
  /** 并发分片数，默认 6。 */
  threads?: number
  /** 已知大小（省一次 HEAD）。 */
  expectedSize?: number
  /** 期望的 sha256（给了就校验，不匹配会改名 .bad 并报错）。 */
  sha256?: string | null
  /** 进度回调（字节）。 */
  onProgress?: (doneBytes: number, totalBytes: number) => void
}

export interface DownloadResult {
  path: string
  bytes: number
  seconds: number
  sha256: string | null
  /** 目标文件已存在且大小一致，没有真的下载。 */
  reused: boolean
}

/**
 * 单片最大 16 MB。
 *
 * 容器内存只有 7G：8 线程 × 64MB 尚可，但最后"把所有分片读进内存再拼"会直接 OOM
 * （13.5GB 权重就是这么被 kill -9 的）。所以分片边下边写盘，最后用流拼接。
 */
const MAX_PART = 16 << 20

function useProxy(url: string): boolean {
  try {
    return shouldProxy(new URL(url).host)
  } catch {
    return proxyConfig() !== null
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

/**
 * 发一次请求并手动跟随重定向。
 *
 * `proxiedRequest` 不跟随重定向（它只是把上游响应原样交回来），而 Civitai 的下载端点
 * 会 307 到 CDN —— 不跟随就永远拿到 307。
 */
async function requestFollowing(
  url: string,
  headers: Record<string, string>,
  method: 'GET' | 'HEAD',
): Promise<{ status: number; headers: Record<string, string>; body: Buffer; finalUrl: string }> {
  let current = url
  for (let hop = 0; hop < 4; hop += 1) {
    const res = useProxy(current)
      ? await proxiedRequest(current, { headers, method, timeoutMs: 300_000 })
      : await (async () => {
          const r = await fetch(current, { headers, method, redirect: 'manual' })
          return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: Buffer.from(await r.arrayBuffer()) }
        })()
    if (REDIRECTS.has(res.status) && res.headers.location) {
      current = new URL(res.headers.location, current).toString()
      continue
    }
    return { ...res, finalUrl: current }
  }
  throw new AstraError('TOO_MANY_REDIRECTS', '重定向超过 4 次', { exitCode: 5 })
}

async function fetchRange(
  url: string,
  headers: Record<string, string>,
  start: number,
  end: number,
): Promise<Buffer> {
  const res = await requestFollowing(url, { ...headers, Range: `bytes=${start}-${end}` }, 'GET')
  if (res.status !== 200 && res.status !== 206) {
    throw new AstraError('DOWNLOAD_HTTP', `下载失败：HTTP ${res.status}`, {
      exitCode: 5,
      hint: res.status === 401 ? 'token 无效或过期：`astra model token set <token>`' : '稍后重试',
      details: { status: res.status },
    })
  }
  // 有的 CDN 无视 Range 直接回整个文件（200）：按请求窗口切一段出来，别把整包当分片。
  if (res.status === 200 && res.body.length > end - start + 1) {
    return res.body.subarray(0, end - start + 1)
  }
  return res.body
}

async function streamSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), async function* (source) {
    for await (const chunk of source) hash.update(chunk as Buffer)
  })
  return hash.digest('hex')
}

/** 探测文件大小与文件名（HEAD；不支持就退回 Range 0-0 的 GET）。 */
export async function probe(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ size: number; filename: string | null }> {
  let res = await requestFollowing(url, headers, 'HEAD')
  let contentRange = res.headers['content-range'] ?? ''
  let size = Number(contentRange.split('/')[1] ?? res.headers['content-length'] ?? 0)
  // 有的 CDN 对 HEAD 只回 200 + 不带 content-length（chunked）：再用 Range 0-0 探一次
  if (!size || res.status >= 400) {
    res = await requestFollowing(url, { ...headers, Range: 'bytes=0-0' }, 'GET')
    contentRange = res.headers['content-range'] ?? ''
    size = Number(contentRange.split('/')[1] ?? res.headers['content-length'] ?? 0)
  }
  const disposition = res.headers['content-disposition'] ?? ''
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)
  return { size, filename: match ? decodeURIComponent(match[1]!) : null }
}

export async function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
  const started = Date.now()
  await mkdir(dirname(options.out), { recursive: true })

  const size = options.expectedSize ?? (await probe(options.url, options.headers)).size
  if (!size) {
    throw new AstraError('DOWNLOAD_SIZE', '拿不到文件大小，无法分段下载', {
      exitCode: 5,
      hint: '换成直链，或检查代理/网络',
    })
  }

  if (existsSync(options.out) && statSync(options.out).size === size) {
    const sha = options.sha256 ? await streamSha256(options.out) : null
    return { path: options.out, bytes: size, seconds: 0, sha256: sha, reused: true }
  }

  const threads = Math.max(1, Math.min(options.threads ?? 6, 16))
  const partSize = Math.ceil(size / threads)
  const parts: { path: string; start: number; end: number }[] = []
  for (let i = 0; i < threads; i += 1) {
    const start = i * partSize
    const end = Math.min(size - 1, start + partSize - 1)
    if (start > end) break
    parts.push({ path: `${options.out}.part${i}`, start, end })
  }

  let doneBytes = 0
  for (const p of parts) {
    if (existsSync(p.path)) {
      const have = statSync(p.path).size
      if (have === p.end - p.start + 1) doneBytes += have
    }
  }
  options.onProgress?.(doneBytes, size)

  await Promise.all(
    parts.map(async (p) => {
      const expected = p.end - p.start + 1
      const have = existsSync(p.path) ? statSync(p.path).size : 0
      if (have === expected) return
      // 片内续传：已有 have 字节就从 p.start+have 接着拉，不重下整片
      if (have > expected) rmSync(p.path, { force: true })
      const resumeFrom = have > expected ? 0 : have
      doneBytes += resumeFrom
      // 边下边写盘：一次只驻留 ≤16MB，不把整片攒在内存里
      for (let s = p.start + resumeFrom; s <= p.end; s += MAX_PART) {
        const e = Math.min(p.end, s + MAX_PART - 1)
        const buf = await fetchRange(options.url, options.headers ?? {}, s, e)
        if (buf.length !== e - s + 1) {
          throw new AstraError('DOWNLOAD_INCOMPLETE', `分片 ${p.path} 长度不符：${buf.length}/${e - s + 1}`, {
            exitCode: 5,
            hint: '重跑同一条命令会续传',
          })
        }
        await appendFile(p.path, buf)
        doneBytes += buf.length
        options.onProgress?.(doneBytes, size)
      }
    }),
  )

  // 流式拼接：13GB 权重不能一次性读进内存（容器 7G，必被 kill）
  const out = createWriteStream(options.out)
  // 每个分片一次 pipeline 都会挂一对 error/close 监听，片数多时触发 MaxListeners 警告
  out.setMaxListeners(0)
  for (const p of parts) {
    await pipeline(createReadStream(p.path), out, { end: false })
  }
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve())
    out.on('error', reject)
  })
  for (const p of parts) rmSync(p.path, { force: true })

  const finalSize = statSync(options.out).size
  if (finalSize !== size) {
    throw new AstraError('DOWNLOAD_INCOMPLETE', `文件不完整：${finalSize}/${size} 字节`, {
      exitCode: 5,
      hint: '重跑同一条命令会续传',
    })
  }

  let sha: string | null = null
  if (options.sha256) {
    sha = await streamSha256(options.out)
    if (sha.toLowerCase() !== options.sha256.toLowerCase()) {
      renameSync(options.out, `${options.out}.bad`)
      throw new AstraError('DOWNLOAD_HASH', 'sha256 校验失败，文件已改名为 .bad', {
        exitCode: 5,
        hint: '重新下载；反复失败说明上游文件本身有问题',
        details: { expected: options.sha256, actual: sha },
      })
    }
  }

  return {
    path: options.out,
    bytes: finalSize,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    sha256: sha,
    reused: false,
  }
}

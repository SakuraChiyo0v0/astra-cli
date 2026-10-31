/**
 * 夸克网盘（pan.quark.cn）接口：分享解析 → 转存 → 直链 → 下载。
 *
 * 实测（2026-11-01，SVIP 账号）：
 * - 分享列表**不需要登录**：`share/sharepage/token` 拿 stoken 就能列目录
 * - 但**没有分享直链接口**：`share/sharepage/download` 直接 404，要拿能跑的直链只能
 *   「转存到自己网盘 → `file/download`」，所以中间这步转存是必须的
 * - **stoken 与 share_fid_token 是同一次会话绑定的**：取 token → 列目录 → 转存必须用同一串，
 *   中途重新取 token 会报 `41020 token 校验异常`
 * - **大文件必须伪装官方 PC 客户端 UA**（`quark-cloud-drive/x.y`），浏览器 UA 会报
 *   `23018 download file size limit`（实测 321MB 就超限）
 * - 删除转存副本的参数是 `filelist` 而不是 `fids`，且不能与 `current_dir_fid` 同时出现
 */
import { createWriteStream, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import { loadQuarkCookie } from './auth.ts'

const BASE = 'https://drive-pc.quark.cn/1/clouddrive'
const REFERER = 'https://pan.quark.cn/'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 取直链 / 删文件必须用这个 UA，否则大文件被限制在 100MB 以内。 */
export const CLIENT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4 Safari/537.36 Channel/pckk_other_ch'

export interface ShareItem {
  fid: string
  name: string
  dir: boolean
  size: number
  shareToken: string | null
  /** 相对路径（walk 时补上），形如 `models/vae/flux2-vae.safetensors` */
  path: string
}

export interface QuarkShare {
  pwdId: string
  stoken: string
  title: string | null
  author: string | null
}

interface ApiBody<T> {
  code?: number
  status?: number
  message?: string
  data?: T
}

function headers(extra: Record<string, string> = {}, ua = BROWSER_UA): Record<string, string> {
  const cookie = loadQuarkCookie()
  return {
    'user-agent': ua,
    referer: REFERER,
    ...(cookie ? { cookie } : {}),
    ...extra,
  }
}

function fail(what: string, body: ApiBody<unknown>): never {
  const code = body.code ?? body.status ?? 0
  const hint =
    code === 23018
      ? '大文件取直链被限制：确认用的是客户端 UA（本 CLI 已内置），仍失败说明账号被风控'
      : code === 41020
        ? 'token 校验异常：stoken 与 share_fid_token 必须来自同一次会话'
        : code === 14001
          ? '参数格式不对（夸克对 fids/filelist 有互斥要求）'
          : null
  throw new AstraError('QUARK_API_ERROR', `夸克${what}失败（code=${code}${body.message ? `：${body.message}` : ''}）`, {
    exitCode: 5,
    ...(hint ? { hint } : {}),
    details: { code },
  })
}

async function get<T>(url: string, what: string, signal?: AbortSignal): Promise<T> {
  const options: Parameters<typeof httpRequest>[1] = { headers: headers(), timeoutMs: 20_000, retries: 1 }
  if (signal) options.signal = signal
  const response = await httpRequest(url, options)
  if (!response.ok) {
    throw new AstraError('QUARK_HTTP', `夸克${what}返回 HTTP ${response.status}`, {
      exitCode: 5,
      retryable: response.status >= 500,
    })
  }
  const body = (await response.json()) as ApiBody<T>
  if (body.code !== 0) fail(what, body)
  return body.data as T
}

async function post<T>(path: string, payload: unknown, what: string, signal?: AbortSignal): Promise<T> {
  const options: Parameters<typeof httpRequest>[1] = {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
    timeoutMs: 30_000,
    retries: 1,
  }
  if (signal) options.signal = signal
  const response = await httpRequest(`${BASE}${path}?pr=ucpro&fr=pc`, options)
  if (!response.ok) {
    throw new AstraError('QUARK_HTTP', `夸克${what}返回 HTTP ${response.status}`, {
      exitCode: 5,
      retryable: response.status >= 500,
    })
  }
  const body = (await response.json()) as ApiBody<T>
  if (body.code !== 0) fail(what, body)
  return body.data as T
}

/** 从链接 / 裸 id 里解析 pwd_id 与提取码。 */
export function parseShareUrl(input: string): { pwdId: string; passcode: string } {
  const raw = input.trim()
  const m = raw.match(/\/s\/([0-9a-zA-Z]+)/)
  const pwdId = m ? m[1]! : raw.replace(/[^0-9a-zA-Z]/g, '')
  if (!pwdId) throw new AstraError('QUARK_BAD_URL', '看不懂这个分享链接', { exitCode: 2 })
  const p = raw.match(/[?&#]pwd=([0-9a-zA-Z]{4})/)
  return { pwdId, passcode: p ? p[1]! : '' }
}

export async function openShare(pwdId: string, passcode = '', signal?: AbortSignal): Promise<QuarkShare> {
  const data = await post<{
    stoken: string
    title?: string
    author?: { nick_name?: string }
  }>('/share/sharepage/token', { pwd_id: pwdId, passcode }, '分享 token', signal)
  return {
    pwdId,
    stoken: data.stoken,
    title: data.title ?? null,
    author: data.author?.nick_name ?? null,
  }
}

async function listOnce(
  share: QuarkShare,
  pdirFid: string,
  page: number,
  signal?: AbortSignal,
): Promise<{ items: ShareItem[]; total: number }> {
  const params = new URLSearchParams({
    pr: 'ucpro',
    fr: 'pc',
    pwd_id: share.pwdId,
    stoken: share.stoken,
    pdir_fid: pdirFid,
    force: '0',
    _page: String(page),
    _size: '100',
    _fetch_total: '1',
    _sort: 'file_type:asc,updated_at:desc',
  })
  const data = await get<{
    list?: Array<Record<string, unknown>>
    total?: number
  }>(`${BASE}/share/sharepage/detail?${params}`, '分享列表', signal)
  const items = (data.list ?? []).map((raw) => ({
    fid: String(raw.fid ?? ''),
    name: String(raw.file_name ?? ''),
    dir: Number(raw.dir ?? 0) === 1,
    size: Number(raw.size ?? 0),
    shareToken: typeof raw.share_fid_token === 'string' ? raw.share_fid_token : null,
    path: String(raw.file_name ?? ''),
  }))
  return { items, total: Number(data.total ?? items.length) }
}

export async function listShare(share: QuarkShare, pdirFid = '0', signal?: AbortSignal): Promise<ShareItem[]> {
  const out: ShareItem[] = []
  for (let page = 1; page <= 50; page += 1) {
    const { items, total } = await listOnce(share, pdirFid, page, signal)
    out.push(...items)
    if (out.length >= total || items.length < 100) break
  }
  return out
}

/** 递归列出所有**文件**（目录本身不进结果），path 是相对分享根的路径。 */
export async function walkShare(
  share: QuarkShare,
  options: { signal?: AbortSignal; maxDepth?: number } = {},
): Promise<ShareItem[]> {
  const maxDepth = options.maxDepth ?? 8
  const files: ShareItem[] = []
  const visit = async (fid: string, prefix: string, depth: number): Promise<void> => {
    for (const item of await listShare(share, fid, options.signal)) {
      if (item.dir) {
        if (depth + 1 > maxDepth) continue
        await visit(item.fid, prefix ? `${prefix}/${item.name}` : item.name, depth + 1)
      } else {
        files.push({ ...item, path: prefix ? `${prefix}/${item.name}` : item.name })
      }
    }
  }
  await visit('0', '', 0)
  return files
}

interface SaveTask {
  task_id?: string
}

/** 转存到自己的网盘根目录，返回任务 id。 */
export async function saveShare(share: QuarkShare, items: ShareItem[], signal?: AbortSignal): Promise<string> {
  const data = await post<SaveTask>(
    '/share/sharepage/save',
    {
      fid_list: items.map((i) => i.fid),
      fid_token_list: items.map((i) => i.shareToken ?? ''),
      to_pdir_fid: '0',
      pwd_id: share.pwdId,
      stoken: share.stoken,
      pdir_fid: '0',
      scene: 'link',
    },
    '转存',
    signal,
  )
  if (!data.task_id) throw new AstraError('QUARK_SAVE', '转存没有返回 task_id', { exitCode: 5 })
  return data.task_id
}

/** 轮询转存任务，返回新文件的 fid（顺序与提交顺序一致）。 */
export async function waitSaveTask(taskId: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const data = await get<{
      status?: number
      save_as?: { save_as_top_fids?: string[] }
    }>(`${BASE}/task?pr=ucpro&fr=pc&task_id=${encodeURIComponent(taskId)}&retry_index=0`, '转存任务', signal)
    if (data.status === 2) return data.save_as?.save_as_top_fids ?? []
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new AstraError('QUARK_SAVE_TIMEOUT', '转存任务超时（120s）', { exitCode: 5, retryable: true })
}

/** 取直链，必须用 CLIENT_UA。转存刚完成时 fid 可能还没就绪（21001），要重试。 */
export async function downloadUrls(fids: string[], signal?: AbortSignal): Promise<Map<string, string>> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await downloadUrlsOnce(fids, signal)
    } catch (error) {
      const code = (error as { details?: { code?: number } }).details?.code
      if (code !== 21001 || attempt === 3) throw error
      await new Promise((r) => setTimeout(r, 1200))
    }
  }
  throw new AstraError('QUARK_DOWNLOAD', '取直链重试耗尽', { exitCode: 5 })
}

async function downloadUrlsOnce(fids: string[], signal?: AbortSignal): Promise<Map<string, string>> {
  const response = await httpRequest(`${BASE}/file/download?pr=ucpro&fr=pc&sys=win32`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }, CLIENT_UA),
    body: JSON.stringify({ fids }),
    timeoutMs: 30_000,
    retries: 1,
    ...(signal ? { signal } : {}),
  })
  // 404 也可能是「fid 还没就绪」（code 21001），所以先解析 body 再判
  let body: ApiBody<Array<{ fid?: string; download_url?: string }>>
  try {
    body = (await response.json()) as ApiBody<Array<{ fid?: string; download_url?: string }>>
  } catch {
    throw new AstraError('QUARK_HTTP', `夸克取直链返回非 JSON（HTTP ${response.status}）`, { exitCode: 5 })
  }
  if ((body.code ?? 0) !== 0) fail('取直链', body)
  const map = new Map<string, string>()
  for (const item of body.data ?? []) {
    if (item.fid && item.download_url) map.set(item.fid, item.download_url)
  }
  return map
}

/** 删掉网盘里的转存副本。注意参数是 filelist，不是 fids。 */
export async function deleteFiles(fids: string[], signal?: AbortSignal): Promise<void> {
  const response = await httpRequest(`${BASE}/file/delete?pr=ucpro&fr=pc`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }, CLIENT_UA),
    body: JSON.stringify({ filelist: fids }),
    timeoutMs: 20_000,
    retries: 1,
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) return
  const body = (await response.json()) as ApiBody<unknown>
  if (body.code !== 0) return // 删不掉不影响主流程
}

export interface DownloadResult {
  path: string
  bytes: number
}

/** 流式下载到 dest（先写 .part 再改名），内存恒定，能下 10GB 单文件。 */
export async function downloadToFile(
  url: string,
  dest: string,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<DownloadResult> {
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  const cookie = loadQuarkCookie()
  const response = await httpRequest(url, {
    headers: {
      'user-agent': CLIENT_UA,
      referer: REFERER,
      // CDN 会校验 cookie，缺了直接 412
      ...(cookie ? { cookie } : {}),
    },
    timeoutMs: 120_000,
    retries: 1,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!response.ok || !response.body) {
    throw new AstraError('QUARK_DOWNLOAD', `下载失败 HTTP ${response.status}`, {
      exitCode: 5,
      retryable: response.status >= 500,
    })
  }
  const total = Number(response.headers.get('content-length') ?? 0)
  const stream = createWriteStream(part)
  let done = 0
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      done += chunk.byteLength
      if (!stream.write(chunk)) await new Promise<void>((resolve) => stream.once('drain', () => resolve()))
      options.onProgress?.(done, total)
    }
  } catch (error) {
    stream.destroy()
    await rm(part, { force: true })
    throw error
  }
  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve())
    stream.on('error', reject)
  })
  const { rename } = await import('node:fs/promises')
  await rename(part, dest)
  return { path: dest, bytes: done }
}

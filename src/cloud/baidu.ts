/**
 * 百度网盘（pan.baidu.com）→ CloudDrive 适配器。
 *
 * 实测约束（2026-11-03）：
 * - **只吃 access_token**（OAuth2 换来的，30 天有效），刷新要用 refresh_token + client_id/secret；
 *   用户贴 BDUSS cookie 也能用，但接口仍要 access_token，所以登录流程固定为「贴 token」。
 * - **下载直链必须带 `User-Agent: pan.baidu.com`**，否则 403；且 dlink 要再追加
 *   `?access_token=` 才能直接下载（`filemetas&dlink=1` 返回的链接裸访问会被拒）。
 * - **非会员限速极狠**（实测几十 KB/s），所以这个域只用来「整理/搬运」，不适合做主力下载源。
 * - 移动/删除/改名都走 `/api/filemanager`，返回 taskid 是**异步任务**，这里只提交不等待，
 *   需要确认结果就再跑一次 `cloud ls`。
 * - 错误都是 `errno`：-6 凭证失效、-7 不存在、-9 文件已存在、2 参数错、31066 被限速。
 */
import { AstraError } from '../core/errors.ts'
import { httpJson, httpRequest } from '../core/http.ts'
import { loadCloudCredential } from './auth-store.ts'
import { baseName, joinPath, normalizePath, type CloudDrive, type CloudNode, type DownloadTarget } from './types.ts'

const PAN = 'https://pan.baidu.com'
// 实测：filemetas 必须打 pan.baidu.com；pcs.baidu.com 会返回"百度云升级"HTML（502）
const PCS = PAN
/** 下载直链只认这个 UA。 */
const DOWNLOAD_UA = 'pan.baidu.com'

interface BaiduEntry {
  fs_id?: number
  path?: string
  server_filename?: string
  isdir?: number
  size?: number
  server_mtime?: number
}

interface BaiduBody<T> {
  errno?: number
  list?: T
  info?: unknown
}

function credential(): { token: string | null; cookie: string | null } {
  const cred = loadCloudCredential('baidu')
  const token = cred?.accessToken?.trim() || null
  const cookie = cred?.cookie?.trim() || null
  if (!token && !cookie) {
    throw new AstraError('CLOUD_NOT_LOGGED_IN', '还没配百度网盘凭证', {
      exitCode: 3,
      hint: '两种都行：`astra cloud login baidu <access_token>`（能做下载），或 `--cookie <整段 cookie>`（只能列目录/整理）',
    })
  }
  return { token, cookie }
}

function token(): string {
  const { token: t, cookie } = credential()
  if (t) return t
  // 只有 cookie 时，接口不允许带 access_token 参数，这里返回空串，调用方要用 cookieHeaders
  return cookie ? '' : ''
}

/** 请求头：有 token 用 token，没有就带 cookie（网页版接口认 cookie）。 */
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const { cookie, token: t } = credential()
  const headers: Record<string, string> = { 'User-Agent': DOWNLOAD_UA, Referer: `${PAN}/disk/home`, ...extra }
  if (cookie) headers.Cookie = cookie
  if (t) headers.Authorization = `Bearer ${t}`
  return headers
}

function withToken(params: URLSearchParams): URLSearchParams {
  const { token: t } = credential()
  if (t) params.set('access_token', t)
  return params
}

function explain(errno: number | undefined, action: string, path?: string): AstraError {
  const where = path ? `（${path}）` : ''
  switch (errno) {
    case -6:
      return new AstraError('CLOUD_AUTH_FAILED', `百度返回 -6：access_token 失效${where}`, {
        exitCode: 3,
        hint: '重新获取 token 后 `astra cloud login baidu <token>`',
      })
    case -7:
    case -9:
      // 实测：list 一个不存在的目录返回 -9（不是文档里写的"已存在"），-7 是文件不存在
      return new AstraError('CLOUD_NOT_FOUND', `百度返回 ${errno}：文件或目录不存在${where}`, { exitCode: 4 })
    case -8:
      return new AstraError('CLOUD_EXISTS', `百度返回 -8：同名文件已存在${where}`, { exitCode: 4 })
    case 9019:
      return new AstraError('CLOUD_NEED_VERIFY', '百度要求人机校验（9019），cookie 拿不到直链', {
        exitCode: 3,
        hint: '用 OAuth access_token（`astra cloud login baidu <token>`）；只靠 cookie 时写操作与下载都会被拦',
      })
    case 31066:
      return new AstraError('CLOUD_RATE_LIMITED', '百度限速中（31066），过几分钟再试', {
        exitCode: 5,
        retryable: true,
      })
    default:
      return new AstraError('CLOUD_FAILED', `${action}失败：errno=${errno ?? '未知'}${where}`, {
        exitCode: 5,
        retryable: errno === 2 ? false : true,
      })
  }
}

function toNode(entry: BaiduEntry): CloudNode {
  const path = entry.path ?? `/${entry.server_filename ?? ''}`
  return {
    id: String(entry.fs_id ?? ''),
    name: entry.server_filename || baseName(path),
    dir: Number(entry.isdir ?? 0) === 1,
    size: Number(entry.size ?? 0),
    path: normalizePath(path),
    ...(entry.server_mtime ? { modifiedAt: new Date(Number(entry.server_mtime) * 1000).toISOString() } : {}),
  }
}

async function listOnce(dir: string, start: number, signal?: AbortSignal): Promise<BaiduEntry[]> {
  const params = withToken(new URLSearchParams({
    method: 'list',
    dir: normalizePath(dir),
    start: String(start),
    limit: '1000',
    web: '1',
    order: 'name',
  }))
  const body = await httpJson<BaiduBody<BaiduEntry[]>>(`${PAN}/api/list?${params}`, {
    headers: authHeaders(),
    timeoutMs: 20_000,
    retries: 2,
    ...(signal ? { signal } : {}),
  })
  if ((body.errno ?? 0) !== 0) throw explain(body.errno, '列目录', dir)
  return body.list ?? []
}

async function fileManager(opera: 'move' | 'delete' | 'rename', filelist: unknown[], signal?: AbortSignal): Promise<void> {
  const params = withToken(new URLSearchParams({ opera }))
  const response = await httpRequest(`${PAN}/api/filemanager?${params}`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/x-www-form-urlencoded' }),
    body: `async=1&filelist=${encodeURIComponent(JSON.stringify(filelist))}`,
    timeoutMs: 25_000,
    retries: 1,
    ...(signal ? { signal } : {}),
  })
  const body = (await response.json()) as BaiduBody<unknown>
  if ((body.errno ?? 0) !== 0) throw explain(body.errno, opera)
}

export const baiduDrive: CloudDrive = {
  id: 'baidu',
  label: '百度网盘',
  capabilities: { share: false, trash: true, downloadNeedsAuth: true, asyncMove: true },

  async list(path, signal) {
    const dir = normalizePath(path)
    const out: CloudNode[] = []
    const seen = new Set<string>()
    for (let start = 0; start < 20_000; start += 1000) {
      const page = await listOnce(dir, start, signal)
      let fresh = 0
      for (const e of page) {
        const node = toNode(e)
        if (seen.has(node.id)) continue
        seen.add(node.id)
        out.push(node)
        fresh += 1
      }
      if (page.length < 1000 || fresh === 0) break
    }
    return out
  },

  async stat(path, signal) {
    const target = normalizePath(path)
    if (target === '/') return { id: '0', name: '/', dir: true, size: 0, path: '/' }
    const parent = target.slice(0, target.lastIndexOf('/')) || '/'
    const name = baseName(target)
    const items = await this.list(parent, signal)
    return items.find((x) => x.name === name) ?? null
  },

  async mkdir(path, signal) {
    const target = normalizePath(path)
    if (target === '/') return '/'
    const params = withToken(new URLSearchParams({ a: 'commit' }))
    const response = await httpRequest(`${PAN}/api/create?${params}`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/x-www-form-urlencoded' }),
      body: `path=${encodeURIComponent(target)}&isdir=1&block_list=%5B%5D`,
      timeoutMs: 25_000,
      retries: 1,
      ...(signal ? { signal } : {}),
    })
    const body = (await response.json()) as BaiduBody<unknown>
    // -8 表示已存在，视为成功
    if ((body.errno ?? 0) !== 0 && body.errno !== -8) throw explain(body.errno, '建目录', target)
    return target
  },

  async move(sources, destDir, signal) {
    const dest = normalizePath(destDir)
    const filelist = sources.map((s) => {
      const p = normalizePath(s)
      return { path: p, dest, newname: baseName(p) }
    })
    await fileManager('move', filelist, signal)
  },

  async remove(paths, signal) {
    await fileManager('delete', paths.map((p) => ({ path: normalizePath(p) })), signal)
  },

  async downloadTarget(node, signal): Promise<DownloadTarget> {
    const params = new URLSearchParams({
      method: 'filemetas',
      access_token: token(),
      dlink: '1',
      fsids: `[${node.id}]`,
    })
    const body = await httpJson<{ errno?: number; list?: Array<{ dlink?: string }> }>(
      `${PCS}/rest/2.0/xpan/multimedia?${params}`,
      {
        headers: { 'User-Agent': DOWNLOAD_UA },
        timeoutMs: 20_000,
        retries: 2,
        ...(signal ? { signal } : {}),
      },
    )
    if ((body.errno ?? 0) !== 0) throw explain(body.errno, '取直链', node.path)
    const dlink = body.list?.[0]?.dlink
    if (!dlink) throw new AstraError('CLOUD_NO_URL', `百度没给直链：${node.path}`, { exitCode: 5, retryable: true })
    // dlink 裸访问会被拒，必须把 access_token 拼回去
    const sep = dlink.includes('?') ? '&' : '?'
    return { url: `${dlink}${sep}access_token=${encodeURIComponent(token())}`, headers: { 'User-Agent': DOWNLOAD_UA } }
  },
}

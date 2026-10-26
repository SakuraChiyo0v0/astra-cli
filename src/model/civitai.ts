/**
 * Civitai 公开 API 的最小封装：搜索、查版本、取下载地址。
 *
 * 只碰三件事：
 * - `model find` 需要的搜索（按下载量排序，带底模与文件大小）
 * - `model info` 需要的版本/文件清单
 * - 下载要用的 `downloadUrl`
 *
 * token 只用于下载（Civitai 的下载端点要 Authorization），搜索是公开的。
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'

const API = 'https://civitai.com/api/v1'

export interface CivitaiFile {
  name: string
  sizeKb: number
  downloadUrl: string
  sha256: string | null
}

export interface CivitaiVersion {
  id: number
  name: string
  baseModel: string | null
  publishedAt: string | null
  files: CivitaiFile[]
}

export interface CivitaiModelSummary {
  id: number
  name: string
  type: string
  downloads: number
  baseModel: string | null
  versions: CivitaiVersion[]
}

function toError(status: number, body: string): AstraError {
  const hint =
    status === 401
      ? '下载需要 token：`astra model token set <token>`（Civitai → Account settings → API Keys）'
      : status === 404
        ? '检查 id 是否正确；`astra model find <关键词>` 可以先搜'
        : '稍后重试，或换个关键词'
  return new AstraError('CIVITAI_HTTP', `Civitai 返回 ${status}`, { exitCode: 5, hint, details: { status, body: body.slice(0, 300) } })
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await httpRequest(url, { headers, retries: 2, timeoutMs: 30_000 })
  const text = await res.text()
  if (!res.ok) throw toError(res.status, text)
  return JSON.parse(text) as T
}

function mapVersion(v: Record<string, unknown>): CivitaiVersion {
  const files = Array.isArray(v.files) ? (v.files as Record<string, unknown>[]) : []
  return {
    id: Number(v.id ?? 0),
    name: String(v.name ?? ''),
    baseModel: typeof v.baseModel === 'string' ? v.baseModel : null,
    publishedAt: typeof v.publishedAt === 'string' ? v.publishedAt : null,
    files: files
      .filter((f) => typeof f.name === 'string' && String(f.name).endsWith('.safetensors'))
      .map((f) => ({
        name: String(f.name),
        sizeKb: Number(f.sizeKB ?? 0),
        downloadUrl: String(f.downloadUrl ?? ''),
        sha256: typeof f.hashes === 'object' && f.hashes ? String((f.hashes as Record<string, unknown>).SHA256 ?? '') || null : null,
      })),
  }
}

function mapModel(m: Record<string, unknown>): CivitaiModelSummary {
  const versions = Array.isArray(m.modelVersions) ? (m.modelVersions as Record<string, unknown>[]).map(mapVersion) : []
  const stats = (m.stats as Record<string, unknown> | undefined) ?? {}
  return {
    id: Number(m.id ?? 0),
    name: String(m.name ?? ''),
    type: String(m.type ?? ''),
    downloads: Number(stats.downloadCount ?? 0),
    baseModel: versions[0]?.baseModel ?? null,
    versions,
  }
}

/** 按下载量搜模型；`type` 可选 Checkpoint / LORA。 */
export async function searchModels(
  query: string,
  options: { limit?: number; type?: string; period?: string } = {},
): Promise<CivitaiModelSummary[]> {
  const params = new URLSearchParams({
    query,
    limit: String(Math.min(Math.max(options.limit ?? 10, 1), 50)),
    sort: 'Most Downloaded',
    period: options.period ?? 'Month',
  })
  if (options.type) params.set('types', options.type)
  const data = await getJson<{ items?: Record<string, unknown>[] }>(`${API}/models?${params.toString()}`)
  return (data.items ?? []).map(mapModel)
}

/** 按 modelId 取详情（含所有版本与文件）。 */
export async function modelInfo(modelId: number): Promise<CivitaiModelSummary> {
  const data = await getJson<Record<string, unknown>>(`${API}/models/${modelId}`)
  return mapModel(data)
}

/** 按 versionId 取单个版本（下载前用来拿文件名/大小/sha256）。 */
export async function versionInfo(versionId: number): Promise<CivitaiVersion> {
  const data = await getJson<Record<string, unknown>>(`${API}/model-versions/${versionId}`)
  return mapVersion(data)
}

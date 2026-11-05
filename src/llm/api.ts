/**
 * OpenAI 兼容接口的最小封装：chat / images / images-edits / models。
 *
 * 三条纪律：
 * 1. 只发标准字段，不猜厂商扩展；上游报错原文只截前 300 字，且 key 先打码
 * 2. 图片一律以二进制返回，落盘由命令层决定（不在这里写用户目录）
 * 3. 纯解析逻辑抽成独立函数（extractChatText / pickImageBytes），便于单测
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { AstraError, invalidInput } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'
import type { ChatMessage, LlmProvider } from './types.ts'
import { maskKey } from './store.ts'

export const SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const

export function normalizeSize(raw?: string): string {
  const value = (raw ?? '').trim().toLowerCase()
  if (!value) return SIZES[0]
  const hit = SIZES.find((s) => s === value)
  if (!hit) throw invalidInput(`不支持的 size：${raw}`, `可用：${SIZES.join(' / ')}`)
  return hit
}

/** 从上游错误体里捞出可读信息，顺便把 key 打码，避免回显凭证。 */
export function sanitizeErrorText(text: string, apiKey: string): string {
  let out = text.length > 300 ? `${text.slice(0, 300)}…` : text
  if (apiKey) out = out.split(apiKey).join(maskKey(apiKey))
  return out
}

async function failFromResponse(res: Response, provider: LlmProvider, what: string): Promise<never> {
  let body = ''
  try {
    body = await res.text()
  } catch {
    body = ''
  }
  const detail = sanitizeErrorText(body, provider.apiKey)
  const retryable = res.status === 429 || res.status >= 500
  throw new AstraError('UPSTREAM_ERROR', `${what}失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`, {
    exitCode: 3,
    retryable,
    ...(res.status === 401 || res.status === 403 ? { hint: 'key 或 base-url 可能不对，跑一次 `astra llm doctor`' } : {}),
  })
}

function jsonHeaders(provider: LlmProvider): Record<string, string> {
  return {
    Authorization: `Bearer ${provider.apiKey}`,
    'Content-Type': 'application/json',
  }
}

export interface ChatResult {
  text: string
  model: string | null
  usage: Record<string, unknown> | null
  finishReason: string | null
}

/** content 可能是字符串，也可能是 [{type:'text',text}] 数组（部分兼容层这样回）。 */
export function extractChatText(payload: unknown): string {
  const choice = (payload as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }> })?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const p = part as { text?: unknown; content?: unknown }
          if (typeof p.text === 'string') return p.text
          if (typeof p.content === 'string') return p.content
        }
        return ''
      })
      .join('')
  }
  return ''
}

export async function chat(
  provider: LlmProvider,
  opts: { messages: ChatMessage[]; model?: string; temperature?: number; maxTokens?: number; signal?: AbortSignal },
): Promise<ChatResult> {
  const model = opts.model?.trim() || provider.models.chat
  if (!model) {
    throw invalidInput('这个端点没配文本模型', `provider add ... --model <模型名>，或本次传 --model`)
  }
  const body: Record<string, unknown> = { model, messages: opts.messages }
  if (opts.temperature !== undefined) body.temperature = opts.temperature
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens

  const res = await httpRequest(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: jsonHeaders(provider),
    body: JSON.stringify(body),
    timeoutMs: 180_000,
    retries: 0,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (!res.ok) await failFromResponse(res, provider, '文本请求')

  const payload = (await res.json()) as Record<string, unknown>
  const choice = (payload.choices as Array<{ finish_reason?: string }> | undefined)?.[0]
  return {
    text: extractChatText(payload),
    model: typeof payload.model === 'string' ? payload.model : model,
    usage: (payload.usage as Record<string, unknown> | undefined) ?? null,
    finishReason: choice?.finish_reason ?? null,
  }
}

export interface ImageResult {
  bytes: Buffer
  contentType: string
  model: string | null
  /** 上游如果直接给了 URL，也带回来，便于排错 */
  sourceUrl: string | null
}

/** 从 `{data:[{b64_json|url}]}` 里挑出图片；两种形态都要认。 */
export function pickImagePayload(payload: unknown): { b64?: string; url?: string } {
  const item = (payload as { data?: Array<{ b64_json?: string; url?: string }> } | undefined)?.data?.[0]
  if (!item) return {}
  return {
    ...(typeof item.b64_json === 'string' && item.b64_json ? { b64: item.b64_json } : {}),
    ...(typeof item.url === 'string' && item.url ? { url: item.url } : {}),
  }
}

function contentTypeOf(bytes: Buffer, fallback = 'image/png'): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.length > 12 && bytes.subarray(0, 4).toString() === 'RIFF') return 'image/webp'
  return fallback
}

async function bytesFromPayload(payload: unknown, provider: LlmProvider, what: string): Promise<ImageResult> {
  const picked = pickImagePayload(payload)
  const model = typeof (payload as { model?: unknown })?.model === 'string' ? String((payload as { model: string }).model) : null
  if (picked.b64) {
    const bytes = Buffer.from(picked.b64, 'base64')
    if (bytes.length === 0) throw new AstraError('UPSTREAM_ERROR', `${what}返回了空图片`, { exitCode: 3 })
    return { bytes, contentType: contentTypeOf(bytes), model, sourceUrl: null }
  }
  if (picked.url) {
    const res = await httpRequest(picked.url, { method: 'GET', timeoutMs: 120_000, retries: 1 })
    if (!res.ok) await failFromResponse(res, provider, `${what}结果下载`)
    const bytes = Buffer.from(await res.arrayBuffer())
    return { bytes, contentType: res.headers.get('content-type') ?? contentTypeOf(bytes), model, sourceUrl: picked.url }
  }
  throw new AstraError('UPSTREAM_ERROR', `${what}没有返回图片`, { exitCode: 3 })
}

export async function generateImage(
  provider: LlmProvider,
  opts: { prompt: string; size?: string; model?: string; signal?: AbortSignal },
): Promise<ImageResult> {
  const model = opts.model?.trim() || provider.models.image
  if (!model) throw invalidInput('这个端点没配文生图模型', 'provider add ... --image-model <模型名>，或本次传 --model')
  const body = { model, prompt: opts.prompt, size: normalizeSize(opts.size) }
  const res = await httpRequest(`${provider.baseUrl}/images/generations`, {
    method: 'POST',
    headers: jsonHeaders(provider),
    body: JSON.stringify(body),
    timeoutMs: 300_000,
    retries: 0,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (!res.ok) await failFromResponse(res, provider, '文生图')
  return bytesFromPayload(await res.json(), provider, '文生图')
}

/** multipart 编码：纯函数，便于单测；不依赖 FormData（要走统一 http 层）。 */
export function buildMultipart(
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; bytes: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = `----astra${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`
  const chunks: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'),
    )
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
      'utf8',
    ),
  )
  chunks.push(file.bytes)
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

function mimeOf(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'image/png'
}

export async function editImage(
  provider: LlmProvider,
  opts: { imagePath: string; prompt: string; size?: string; model?: string; signal?: AbortSignal },
): Promise<ImageResult> {
  const model = opts.model?.trim() || provider.models.edit || provider.models.image
  if (!model) throw invalidInput('这个端点没配图生图模型', 'provider add ... --edit-model <模型名>，或本次传 --model')

  let bytes: Buffer
  try {
    bytes = await readFile(opts.imagePath)
  } catch {
    throw invalidInput(`读不到这张图：${opts.imagePath}`, '给本机文件路径；png/jpg/webp')
  }

  const form = buildMultipart(
    { model, prompt: opts.prompt, size: normalizeSize(opts.size) },
    { field: 'image', filename: path.basename(opts.imagePath), contentType: mimeOf(opts.imagePath), bytes },
  )

  // multipart 的 body 是二进制，core/http 只收字符串：这里直连 fetch（同容器/同内网为主）
  const res = await fetch(`${provider.baseUrl}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': form.contentType },
    body: new Uint8Array(form.body),
    signal: opts.signal ?? null,
  })
  if (!res.ok) await failFromResponse(res, provider, '图生图')
  return bytesFromPayload(await res.json(), provider, '图生图')
}

export async function listModels(provider: LlmProvider, signal?: AbortSignal): Promise<string[]> {
  const res = await httpRequest(`${provider.baseUrl}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    timeoutMs: 30_000,
    retries: 0,
    ...(signal ? { signal } : {}),
  })
  if (!res.ok) await failFromResponse(res, provider, '模型列表')
  const payload = (await res.json()) as { data?: Array<{ id?: string }> }
  return (payload.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean)
}

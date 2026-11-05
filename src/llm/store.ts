/**
 * 端点配置的读写：`<ASTRA_HOME>/llm-providers.json`（600）。
 *
 * 约定：
 * - key 只在文件里出现明文，回显一律 `maskKey()`
 * - 一个端点一条记录，`--base-url` 允许带或不带 `/v1`，统一归一化成带 `/v1`
 * - 删到只剩一个时自动把 default 指向它，避免「配了但没默认」
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homePath } from '../core/paths.ts'
import { invalidInput } from '../core/errors.ts'
import type { LlmProvider, LlmStore } from './types.ts'

export function storePath(): string {
  return homePath('llm-providers.json')
}

export function emptyStore(): LlmStore {
  return { version: 1, providers: {} }
}

export function loadStore(): LlmStore {
  const file = storePath()
  if (!existsSync(file)) return emptyStore()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<LlmStore>
    const providers = (raw.providers ?? {}) as Record<string, LlmProvider>
    const store: LlmStore = { version: 1, providers }
    if (raw.default && providers[raw.default]) store.default = raw.default
    return store
  } catch {
    return emptyStore()
  }
}

export function saveStore(store: LlmStore): void {
  const file = storePath()
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
}

/** `sk-abcdefghijkl` → `sk-a…kl`；太短就整体遮掉。 */
export function maskKey(key: string): string {
  const value = key.trim()
  if (!value) return '***'
  if (value.length <= 10) return '***'
  return `${value.slice(0, 4)}…${value.slice(-2)}`
}

/** 允许填 `http://host:8788` 或 `http://host:8788/v1`，统一成后者（末尾不留斜杠）。 */
export function normalizeBaseUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(value)) {
    throw invalidInput('base-url 必须以 http:// 或 https:// 开头', '例：--base-url http://model-gateway:8788/v1')
  }
  return /\/v1$/i.test(value) ? value : `${value}/v1`
}

export function upsertProvider(store: LlmStore, provider: LlmProvider, makeDefault: boolean): LlmStore {
  store.providers[provider.name] = provider
  if (makeDefault || !store.default) store.default = provider.name
  return store
}

export function removeProvider(store: LlmStore, name: string): LlmStore {
  delete store.providers[name]
  if (store.default === name) {
    const first = Object.keys(store.providers)[0]
    if (first) store.default = first
    else delete store.default
  }
  return store
}

export function resolveProvider(store: LlmStore, name?: string): LlmProvider {
  if (Object.keys(store.providers).length === 0) {
    throw invalidInput(
      '还没有配任何端点',
      '先跑：astra llm provider add <名字> --base-url https://xxx/v1 --key sk-xxx --model gpt-4o-mini',
    )
  }
  const target = name?.trim() || store.default
  if (!target) throw invalidInput('没有指定端点，也没有默认端点', '加 --provider <名字>，或先 provider add 一条')
  const provider = store.providers[target]
  if (!provider) {
    throw invalidInput(`没有这个端点：${target}`, `已配置：${Object.keys(store.providers).join(', ')}`)
  }
  return provider
}

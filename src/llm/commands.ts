/**
 * `astra llm`：一个可配置的 OpenAI 兼容端点，做文本 / 文生图 / 图生图。
 *
 * 命令形态（数字和路径一律走 flag，正文用位置参数，含空格要加引号）：
 *   llm provider add <名字> --base-url --key [--model --image-model --edit-model]
 *   llm providers | llm provider remove <名字> | llm doctor [名字]
 *   llm chat "<提示词>" [--system --model --temperature --max-tokens]
 *   llm image "<提示词>" [--size --out --model]
 *   llm edit <图片路径> "<要求>" [--size --out --model]
 *
 * key 只进配置文件；所有回显都走 maskKey()。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Command } from '../core/command.ts'
import { invalidInput } from '../core/errors.ts'
import { homePath } from '../core/paths.ts'
import { chat, editImage, generateImage, listModels, normalizeSize, sanitizeErrorText } from './api.ts'
import {
  loadStore,
  maskKey,
  normalizeBaseUrl,
  removeProvider,
  resolveProvider,
  saveStore,
  upsertProvider,
} from './store.ts'
import type { LlmProvider } from './types.ts'

function num(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) {
    throw invalidInput(`${name} 必须在 ${min}..${max} 之间`, `收到：${String(value)}`)
  }
  return n
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 输出目录：`--out` 给目录就用它，给文件路径就照用；默认 `<ASTRA_HOME>/llm-out`。 */
function resolveOut(out: string | undefined, stem: string, ext: string): string {
  const base = out?.trim()
  if (base) {
    const abs = path.resolve(base)
    if (/\/$/.test(base) || !path.extname(abs)) {
      mkdirSync(abs, { recursive: true })
      return path.join(abs, `${stem}.${ext}`)
    }
    mkdirSync(path.dirname(abs), { recursive: true })
    return abs
  }
  const dir = homePath('llm-out')
  mkdirSync(dir, { recursive: true })
  return path.join(dir, `${stem}.${ext}`)
}

function stemOf(prompt: string): string {
  const d = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  const slug = prompt.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/[^\w\u4e00-\u9fff_-]/g, '').slice(0, 24)
  return `${stamp}_${slug || 'image'}`
}

function extOf(contentType: string): string {
  if (contentType.includes('jpeg')) return 'jpg'
  if (contentType.includes('webp')) return 'webp'
  return 'png'
}

function saveImage(bytes: Buffer, contentType: string, out: string | undefined, prompt: string): string {
  const file = resolveOut(out, stemOf(prompt), extOf(contentType))
  writeFileSync(file, bytes)
  return file
}

function tableOfProviders(providers: LlmProvider[], def: string | undefined) {
  return {
    headers: ['名字', '默认', 'base-url', '文本模型', '文生图', '图生图', 'key'],
    rows: providers.map((p) => [
      p.name,
      p.name === def ? '✓' : '',
      p.baseUrl,
      p.models.chat ?? '—',
      p.models.image ?? '—',
      p.models.edit ?? p.models.image ?? '—',
      maskKey(p.apiKey),
    ]),
  }
}

const providerAdd: Command = {
  name: 'llm provider add',
  summary: '添加/更新一个 OpenAI 兼容端点（base-url + key + 模型名）',
  usage:
    'astra llm provider add <名字> --base-url <url> --key <key> [--model <文本模型>] [--image-model <生图模型>] [--edit-model <改图模型>] [--default] [--force]',
  notes: [
    'base-url 可以带 /v1 也可以不带，统一存成 …/v1。',
    'key 只写进 <ASTRA_HOME>/llm-providers.json（600），输出里只显示前 4 位。',
    '同名已存在要加 --force 才覆盖。第一条自动成为默认端点。',
  ],
  options: {
    'base-url': { type: 'string', description: '端点地址，如 https://api.openai.com/v1', valueName: 'url' },
    key: { type: 'string', description: 'API key（只落盘，不打日志）', valueName: 'key' },
    model: { type: 'string', description: '默认文本模型，如 gpt-4o-mini', valueName: 'name' },
    'image-model': { type: 'string', description: '默认文生图模型，如 gpt-image-1', valueName: 'name' },
    'edit-model': { type: 'string', description: '默认图生图模型（缺省用 image-model）', valueName: 'name' },
    default: { type: 'boolean', description: '设为默认端点' },
    force: { type: 'boolean', description: '覆盖同名端点' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    const name = (positionals[0] ?? '').trim()
    if (!name) throw invalidInput('缺少端点名字', '例：astra llm provider add gateway --base-url … --key …')
    const baseUrl = str(values['base-url'])
    const key = str(values.key)
    if (!baseUrl) throw invalidInput('缺少 --base-url', '例：--base-url http://model-gateway:8788/v1')
    if (!key) throw invalidInput('缺少 --key', 'key 会写进 600 权限的配置文件，不会回显')

    const store = loadStore()
    if (store.providers[name] && values.force !== true) {
      throw invalidInput(`端点已存在：${name}`, '改配置加 --force，或换个名字')
    }
    const provider: LlmProvider = {
      name,
      baseUrl: normalizeBaseUrl(baseUrl),
      apiKey: key,
      models: {
        ...(str(values.model) ? { chat: str(values.model) } : {}),
        ...(str(values['image-model']) ? { image: str(values['image-model']) } : {}),
        ...(str(values['edit-model']) ? { edit: str(values['edit-model']) } : {}),
      },
      addedAt: new Date().toISOString(),
    }
    upsertProvider(store, provider, values.default === true)
    saveStore(store)

    return {
      data: {
        action: store.default === name ? 'added (default)' : 'added',
        name,
        baseUrl: provider.baseUrl,
        key: maskKey(provider.apiKey),
        models: provider.models,
        configFile: 'llm-providers.json',
      },
    }
  },
}

const providersList: Command = {
  name: 'llm providers',
  summary: '列出已配置的端点（key 打码）',
  usage: 'astra llm providers [--table]',
  notes: ['不给 --table 时是 JSON；--table 直接看对照表。'],
  maxArgs: 0,
  async run() {
    const store = loadStore()
    const list = Object.values(store.providers).sort((a, b) => a.name.localeCompare(b.name))
    return {
      data: {
        ...(store.default ? { default: store.default } : {}),
        count: list.length,
        providers: list.map((p) => ({
          name: p.name,
          baseUrl: p.baseUrl,
          models: p.models,
          key: maskKey(p.apiKey),
          addedAt: p.addedAt,
        })),
      },
      ...(list.length > 0 ? { table: tableOfProviders(list, store.default) } : {}),
    }
  },
}

const providerRemove: Command = {
  name: 'llm provider remove',
  summary: '删掉一个端点配置',
  usage: 'astra llm provider remove <名字>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const name = (positionals[0] ?? '').trim()
    const store = loadStore()
    if (!store.providers[name]) throw invalidInput(`没有这个端点：${name}`, `已配置：${Object.keys(store.providers).join(', ') || '（空）'}`)
    const removedDefault = store.default === name
    removeProvider(store, name)
    saveStore(store)
    return {
      data: {
        action: 'removed',
        name,
        ...(removedDefault && store.default ? { newDefault: store.default } : {}),
        remaining: Object.keys(store.providers),
      },
    }
  },
}

const doctor: Command = {
  name: 'llm doctor',
  summary: '探活：打 /models，看端点通不通、配的模型在不在列表里',
  usage: 'astra llm doctor [端点名字]',
  notes: [
    '不通时返回 reachable=false 并把上游错误（已打码）带回来，不抛异常，便于一次看全部。',
    '有些兼容层不实现 /models：列表为空不代表端点坏了，用 llm chat 再确认一次。',
  ],
  maxArgs: 1,
  async run({ positionals, signal }) {
    const store = loadStore()
    const targets = positionals[0]
      ? [resolveProvider(store, positionals[0])]
      : Object.values(store.providers)
    if (targets.length === 0) throw invalidInput('还没有配任何端点', '先跑 astra llm provider add …')

    const rows: (string | number | null)[][] = []
    const results = []
    for (const provider of targets) {
      try {
        const models = await listModels(provider, signal)
        const wanted = [provider.models.chat, provider.models.image, provider.models.edit].filter(
          (m): m is string => Boolean(m),
        )
        const missing = models.length > 0 ? wanted.filter((m) => !models.includes(m)) : []
        results.push({
          name: provider.name,
          baseUrl: provider.baseUrl,
          reachable: true,
          modelCount: models.length,
          missing,
          models,
        })
        rows.push([provider.name, provider.baseUrl, '✓', models.length, missing.join(', ') || '—'])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        results.push({
          name: provider.name,
          baseUrl: provider.baseUrl,
          reachable: false,
          error: sanitizeErrorText(message, provider.apiKey),
        })
        rows.push([provider.name, provider.baseUrl, '✗', 0, sanitizeErrorText(message, provider.apiKey).slice(0, 60)])
      }
    }
    return {
      data: { count: results.length, results },
      table: { headers: ['名字', 'base-url', '可达', '模型数', '缺失/错误'], rows },
    }
  },
}

const chatCommand: Command = {
  name: 'llm chat',
  summary: '调用文本模型，返回回答',
  usage:
    'astra llm chat "<提示词>" [--system <系统提示>] [--provider <名字>] [--model <模型>] [--temperature 0..2] [--max-tokens n]',
  notes: [
    '多段提示词直接当位置参数连写，记得整体加引号。',
    '返回 text / model / usage / finishReason；长文不要用 --table。',
  ],
  options: {
    system: { type: 'string', description: '系统提示词', valueName: 'text' },
    provider: { type: 'string', description: '端点名字，默认用 default', valueName: 'name' },
    model: { type: 'string', description: '覆盖文本模型', valueName: 'name' },
    temperature: { type: 'string', description: '0..2，缺省不传（用上游默认）', valueName: 'n' },
    'max-tokens': { type: 'string', description: '最大输出 token', valueName: 'n' },
  },
  minArgs: 1,
  maxArgs: 40,
  async run({ positionals, values, signal }) {
    const prompt = positionals.join(' ').trim()
    if (!prompt) throw invalidInput('提示词是空的', '例：astra llm chat "用三句话解释 GPQA"')
    const store = loadStore()
    const provider = resolveProvider(store, str(values.provider))

    const messages = [
      ...(str(values.system) ? [{ role: 'system' as const, content: str(values.system) }] : []),
      { role: 'user' as const, content: prompt },
    ]
    const temperature = values.temperature === undefined ? undefined : num(values.temperature, 0.7, 0, 2, '--temperature')
    const maxTokens = values['max-tokens'] === undefined ? undefined : num(values['max-tokens'], 1024, 1, 128_000, '--max-tokens')

    const result = await chat(provider, {
      messages,
      ...(str(values.model) ? { model: str(values.model) } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      signal,
    })
    const warnings: string[] = []
    if (!result.text) {
      warnings.push(
        result.finishReason === 'length'
          ? '没有输出文本且 finishReason=length：推理型模型会先消耗 reasoning token，调大 --max-tokens'
          : '上游没有返回文本内容，确认模型名是否支持 chat/completions',
      )
    }
    return {
      data: {
        provider: provider.name,
        model: result.model,
        text: result.text,
        finishReason: result.finishReason,
        ...(result.usage ? { usage: result.usage } : {}),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  },
}

const imageCommand: Command = {
  name: 'llm image',
  summary: '文生图：给提示词，落一张 PNG 到磁盘',
  usage: 'astra llm image "<画什么>" [--size 1024x1024|1536x1024|1024x1536] [--out 路径或目录] [--provider <名字>] [--model <模型>]',
  notes: [
    '默认落在 <ASTRA_HOME>/llm-out/，文件名带时间戳和提示词摘要。',
    '--out 给目录（或以 / 结尾）就自动起名；给 .png 路径就照用。',
    '返回 path / bytes / contentType / size；要发到聊天里用 MEDIA:<path>。',
  ],
  options: {
    size: { type: 'string', description: '1024x1024（默认）/ 1536x1024 / 1024x1536', valueName: 'WxH' },
    out: { type: 'string', description: '输出文件或目录', valueName: 'path' },
    provider: { type: 'string', description: '端点名字，默认用 default', valueName: 'name' },
    model: { type: 'string', description: '覆盖生图模型', valueName: 'name' },
  },
  minArgs: 1,
  maxArgs: 40,
  async run({ positionals, values, signal }) {
    const prompt = positionals.join(' ').trim()
    if (!prompt) throw invalidInput('提示词是空的', '例：astra llm image "雨夜霓虹街头，赛博朋克，电影感"')
    const store = loadStore()
    const provider = resolveProvider(store, str(values.provider))
    const size = normalizeSize(str(values.size) || undefined)

    const result = await generateImage(provider, {
      prompt,
      size,
      ...(str(values.model) ? { model: str(values.model) } : {}),
      signal,
    })
    const file = saveImage(result.bytes, result.contentType, str(values.out), prompt)
    return {
      data: {
        provider: provider.name,
        model: result.model,
        path: file,
        bytes: result.bytes.length,
        contentType: result.contentType,
        size,
      },
    }
  },
}

const editCommand: Command = {
  name: 'llm edit',
  summary: '图生图：给一张图和修改要求，返回改好的图',
  usage: 'astra llm edit <图片路径> "<怎么改>" [--size …] [--out 路径或目录] [--provider <名字>] [--model <模型>]',
  notes: [
    '走 /v1/images/edits（multipart），需要端点支持该接口。',
    '不是所有兼容层都实现 edits；报 404 就说明这个端点只做了 generations。',
  ],
  options: {
    size: { type: 'string', description: '1024x1024（默认）/ 1536x1024 / 1024x1536', valueName: 'WxH' },
    out: { type: 'string', description: '输出文件或目录', valueName: 'path' },
    provider: { type: 'string', description: '端点名字，默认用 default', valueName: 'name' },
    model: { type: 'string', description: '覆盖改图模型', valueName: 'name' },
  },
  minArgs: 2,
  maxArgs: 41,
  async run({ positionals, values, signal }) {
    const imagePath = path.resolve(positionals[0] ?? '')
    const prompt = positionals.slice(1).join(' ').trim()
    if (!prompt) throw invalidInput('缺少修改要求', '例：astra llm edit a.png "改成雨夜，霓虹反光"')
    const store = loadStore()
    const provider = resolveProvider(store, str(values.provider))
    const size = normalizeSize(str(values.size) || undefined)

    const result = await editImage(provider, {
      imagePath,
      prompt,
      size,
      ...(str(values.model) ? { model: str(values.model) } : {}),
      signal,
    })
    const file = saveImage(result.bytes, result.contentType, str(values.out), `${path.basename(imagePath)}_${prompt}`)
    return {
      data: {
        provider: provider.name,
        model: result.model,
        source: imagePath,
        path: file,
        bytes: result.bytes.length,
        contentType: result.contentType,
        size,
      },
    }
  },
}

export const llmCommands: Command[] = [
  providerAdd,
  providersList,
  providerRemove,
  doctor,
  chatCommand,
  imageCommand,
  editCommand,
]

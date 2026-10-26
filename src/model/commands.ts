/**
 * `astra model ...`：模型资产的查找与下载（Civitai / HuggingFace / 直链）。
 *
 * 只做「找到 → 拉下来 → 落到指定目录」这一段。为什么不带上 ComfyUI 安装：
 * 模型目录因整合包而异，用户自己指定 `--out` 最稳，写死路径只会错。
 */
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { AstraError, invalidInput } from '../core/errors.ts'
import type { Command } from '../core/command.ts'
import { ensureDir, homePath } from '../core/paths.ts'
import { progress } from '../core/output.ts'
import { modelInfo, searchModels, versionInfo } from './civitai.ts'
import { downloadFile, probe } from './download.ts'

const TOKEN_FILE = () => homePath('civitai.json')

interface StoredToken {
  token: string
  savedAt: string
}

function loadToken(): StoredToken | null {
  const file = TOKEN_FILE()
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredToken>
    if (typeof raw.token === 'string' && raw.token) {
      return { token: raw.token, savedAt: String(raw.savedAt ?? '') }
    }
    return null
  } catch {
    return null
  }
}

/** 环境变量优先，其次文件。 */
function resolveToken(): string | null {
  const env = process.env.CIVITAI_TOKEN?.trim()
  if (env) return env
  return loadToken()?.token ?? null
}

function digest(token: string): string {
  // 只留前后各 4 位，够判断"是不是同一个 key"
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

function requireToken(): string {
  const token = resolveToken()
  if (!token) {
    throw new AstraError('NO_TOKEN', '没有 Civitai token，下载会被拒绝（401）', {
      exitCode: 3,
      hint: '`astra model token set <token>`；token 在 Civitai → Account settings → API Keys 生成',
    })
  }
  return token
}

/** `civitai:<versionId>` / `hf:<org>/<repo>/<path>` / http(s) 直链 → 实际 URL + 元信息。 */
async function resolveSpec(spec: string): Promise<{ url: string; filename: string | null; size: number; sha256: string | null }> {
  if (spec.startsWith('civitai:')) {
    const versionId = Number(spec.slice('civitai:'.length))
    if (!Number.isFinite(versionId) || versionId <= 0) throw invalidInput('civitai: 后面要跟版本号', '`astra model info <modelId>` 能看到各版本的 id')
    const version = await versionInfo(versionId)
    const file = version.files[0]
    if (!file) throw new AstraError('NO_FILE', '这个版本没有 safetensors 文件', { exitCode: 4 })
    return { url: file.downloadUrl, filename: file.name, size: file.sizeKb * 1024, sha256: file.sha256 }
  }
  if (spec.startsWith('hf:')) {
    const rest = spec.slice(3).split('/')
    if (rest.length < 3) throw invalidInput('hf 格式：hf:<org>/<repo>/<文件路径>', '例如 hf:city96/FLUX.1-dev-gguf/flux1-dev-Q4_K_S.gguf')
    const repo = rest.slice(0, 2).join('/')
    const path = rest.slice(2).join('/')
    const url = `https://huggingface.co/${repo}/resolve/main/${path}`
    const { size, filename } = await probe(url, process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {})
    return { url, filename: filename ?? basename(path), size, sha256: null }
  }
  if (/^https?:\/\//i.test(spec)) {
    const { size, filename } = await probe(spec)
    return { url: spec, filename, size, sha256: null }
  }
  throw invalidInput(
    '不认识的来源',
    '三种写法：civitai:<versionId> / hf:<org>/<repo>/<文件> / https://...',
  )
}

const tokenSet: Command = {
  name: 'model token set',
  summary: '保存 Civitai API token（下载用）',
  usage: 'astra model token set <token>',
  notes: ['token 存在 <ASTRA_HOME>/civitai.json，权限 600；环境变量 CIVITAI_TOKEN 优先', '只显示前后各 4 位，不会回显完整 token'],
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const token = positionals[0]!.trim()
    if (token.length < 16) throw invalidInput('token 看起来太短', 'Civitai 的 key 一般 32 位十六进制')
    ensureDir(homePath())
    const file = TOKEN_FILE()
    writeFileSync(file, JSON.stringify({ token, savedAt: new Date().toISOString() }, null, 2))
    try {
      chmodSync(file, 0o600)
    } catch {
      // Windows 上 chmod 无效，忽略
    }
    return { data: { saved: true, digest: digest(token) } }
  },
}

const tokenShow: Command = {
  name: 'model token show',
  summary: '看 token 状态（不回显完整值）',
  usage: 'astra model token show',
  maxArgs: 0,
  async run() {
    const envToken = process.env.CIVITAI_TOKEN?.trim()
    const stored = loadToken()
    return {
      data: {
        source: envToken ? 'env' : stored ? 'file' : null,
        digest: envToken ? digest(envToken) : stored ? digest(stored.token) : null,
        savedAt: stored?.savedAt ?? null,
        configured: Boolean(envToken || stored),
      },
    }
  },
}

const tokenClear: Command = {
  name: 'model token clear',
  summary: '删掉保存的 token',
  usage: 'astra model token clear',
  maxArgs: 0,
  async run() {
    const file = TOKEN_FILE()
    const existed = existsSync(file)
    if (existed) rmSync(file, { force: true })
    return { data: { removed: existed } }
  },
}

const find: Command = {
  name: 'model find',
  summary: '按关键词搜 Civitai 模型（按下载量排序）',
  usage: 'astra model find <关键词> [--type Checkpoint|LORA] [--limit 10] [--period Month|AllTime]',
  options: {
    type: { type: 'string', description: 'Checkpoint 或 LORA', valueName: 'kind' },
    limit: { type: 'string', description: '返回条数，默认 10，最多 50', valueName: 'n' },
    period: { type: 'string', description: 'Month / Week / AllTime，默认 Month', valueName: 'p' },
  },
  minArgs: 1,
  async run({ positionals, values }) {
    const keyword = positionals.join(' ')
    const limit = values.limit ? Number(values.limit) : 10
    const items = await searchModels(keyword, {
      limit,
      ...(typeof values.type === 'string' ? { type: values.type } : {}),
      ...(typeof values.period === 'string' ? { period: values.period } : {}),
    })
    return {
      data: {
        keyword,
        total: items.length,
        items: items.map((m) => ({
          modelId: m.id,
          name: m.name,
          type: m.type,
          baseModel: m.baseModel,
          downloads: m.downloads,
          latestVersionId: m.versions[0]?.id ?? null,
          files: m.versions[0]?.files.map((f) => ({ name: f.name, sizeMb: Math.round(f.sizeKb / 1024) })) ?? [],
        })),
      },
      table: {
        headers: ['modelId', '名称', '底模', '下载', '最新版本'],
        rows: items.map((m) => [m.id, m.name.slice(0, 42), m.baseModel ?? '-', m.downloads, m.versions[0]?.id ?? '-']),
      },
    }
  },
}

const info: Command = {
  name: 'model info',
  summary: '看某个模型的全部版本与文件（下载前先确认）',
  usage: 'astra model info <modelId>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const modelId = Number(positionals[0])
    if (!Number.isFinite(modelId)) throw invalidInput('modelId 要是数字', '`astra model find <关键词>` 里能拿到')
    const model = await modelInfo(modelId)
    return {
      data: {
        modelId: model.id,
        name: model.name,
        type: model.type,
        downloads: model.downloads,
        versions: model.versions.map((v) => ({
          versionId: v.id,
          name: v.name,
          baseModel: v.baseModel,
          publishedAt: v.publishedAt,
          files: v.files.map((f) => ({
            name: f.name,
            sizeMb: Math.round(f.sizeKb / 1024),
            sha256: f.sha256,
            pull: `astra model pull civitai:${v.id} --out <目录>/${f.name}`,
          })),
        })),
      },
    }
  },
}

const pull: Command = {
  name: 'model pull',
  summary: '下载模型文件（Civitai / HuggingFace / 直链），分段并发 + 断点续传',
  usage: 'astra model pull <civitai:版本号|hf:org/repo/文件|url> --out <路径> [--threads 6] [--sha256 <值>]',
  notes: [
    '`--out` 给目录时自动用上游文件名；给文件路径则按路径落盘',
    '中断后重跑同一条命令会续传（分片文件 .partN 留在原地）',
    'Civitai 下载需要 token：`astra model token set <token>`',
  ],
  options: {
    out: { type: 'string', description: '输出路径（目录或文件名）', valueName: 'path' },
    threads: { type: 'string', description: '并发分片数，默认 6，最大 16', valueName: 'n' },
    sha256: { type: 'string', description: '校验值（不给则用上游提供的）', valueName: 'hex' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    const spec = positionals[0]!
    const out = typeof values.out === 'string' ? values.out : ''
    if (!out) throw invalidInput('缺少 --out', '例如 --out /opt/data/cache/models/xxx.safetensors')
    if (spec.startsWith('civitai:')) requireToken()

    const resolved = await resolveSpec(spec)
    const looksLikeDir = out.endsWith('/') || out.endsWith('\\') || !/\.[A-Za-z0-9]{1,8}$/.test(out)
    const isDir = (existsSync(out) && statSync(out).isDirectory()) || looksLikeDir
    const target = isDir
      ? join(out, resolved.filename ?? basename(new URL(resolved.url).pathname) ?? 'model.safetensors')
      : out

    const headers: Record<string, string> = {}
    if (spec.startsWith('civitai:')) headers.Authorization = `Bearer ${requireToken()}`
    if (spec.startsWith('hf:') && process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`

    const threads = values.threads ? Number(values.threads) : 6
    let lastLog = 0
    const result = await downloadFile({
      url: resolved.url,
      out: target,
      headers,
      threads,
      expectedSize: resolved.size || undefined,
      sha256: (typeof values.sha256 === 'string' ? values.sha256 : resolved.sha256) ?? null,
      onProgress: (done, total) => {
        const now = Date.now()
        if (now - lastLog < 2000) return
        lastLog = now
        progress('model.download', {
          doneMb: Math.round(done / 1e6),
          totalMb: Math.round(total / 1e6),
          percent: total ? Math.round((done / total) * 100) : null,
        })
      },
    })

    return {
      data: {
        status: result.reused ? 'already_have' : 'downloaded',
        path: result.path,
        sizeMb: Math.round(result.bytes / 1e6),
        seconds: result.seconds,
        mbPerSecond: result.seconds > 0 ? Math.round((result.bytes / 1e6 / result.seconds) * 10) / 10 : null,
        sha256: result.sha256,
      },
    }
  },
}

const list: Command = {
  name: 'model list',
  summary: '列某个模型目录里有什么（按大小排序）',
  usage: 'astra model list <目录> [--limit 50]',
  options: {
    limit: { type: 'string', description: '最多列多少个，默认 50', valueName: 'n' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    const dir = positionals[0]!
    if (!existsSync(dir)) throw invalidInput(`目录不存在：${dir}`, '给 ComfyUI 的 models/<子目录> 绝对路径')
    const limit = values.limit ? Number(values.limit) : 50
    const entries = await readdir(dir, { withFileTypes: true })
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => {
        const st = statSync(join(dir, e.name))
        return { name: e.name, sizeMb: Math.round(st.size / 1e6), modified: st.mtime.toISOString().slice(0, 16) }
      })
      .sort((a, b) => b.sizeMb - a.sizeMb)
      .slice(0, limit)
    const total = files.reduce((sum, f) => sum + f.sizeMb, 0)
    return {
      data: { dir, count: files.length, totalMb: total, files },
      table: {
        headers: ['文件', 'MB', '修改时间'],
        rows: files.map((f) => [f.name, f.sizeMb, f.modified]),
      },
    }
  },
}

export const modelCommands: Command[] = [tokenSet, tokenShow, tokenClear, find, info, pull, list]

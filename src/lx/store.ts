/**
 * 音源脚本的管理：导入、列出、删除、按顺序加载。
 *
 * 脚本存在 `<ASTRA_HOME>/lx/<id>.js`，顺序记在 `<ASTRA_HOME>/lx/index.json`。
 * 脚本不进仓库：用户自己导入，自己负责来源。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { ensureDir, homePath } from '../core/paths.ts'
import { AstraError, invalidInput } from '../core/errors.ts'
import { loadLxSource, parseScriptMeta, type LoadedLxSource } from './host.ts'

export interface LxSourceRecord {
  id: string
  name: string
  version: string
  file: string
  sha256: string
  enabled: boolean
  addedAt: string
}

function lxDir(): string {
  return ensureDir(homePath('lx'))
}

function indexFile(): string {
  return path.join(lxDir(), 'index.json')
}

function readIndex(): LxSourceRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(indexFile(), 'utf8')) as unknown
    return Array.isArray(parsed) ? (parsed as LxSourceRecord[]) : []
  } catch {
    return []
  }
}

function writeIndex(records: LxSourceRecord[]): void {
  writeFileSync(indexFile(), JSON.stringify(records, null, 2) + '\n', 'utf8')
}

export function listSources(): LxSourceRecord[] {
  return readIndex()
}

function slug(text: string): string {
  const ascii = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return ascii || 'source'
}

/** 导入前先试加载一次：加载不起来的脚本不收。 */
export async function addSource(filePath: string, id?: string): Promise<{ record: LxSourceRecord; platforms: string[] }> {
  const absolute = path.resolve(filePath)
  if (!existsSync(absolute)) throw invalidInput(`文件不存在：${absolute}`)
  const code = readFileSync(absolute, 'utf8')
  let loaded: LoadedLxSource
  try {
    loaded = await loadLxSource(code, path.basename(absolute))
  } catch (err) {
    throw new AstraError('LX_LOAD_FAILED', `音源脚本加载失败：${(err as Error).message}`, { exitCode: 2 })
  }
  const meta = parseScriptMeta(code)
  const sha256 = createHash('sha256').update(code).digest('hex')
  const records = readIndex()
  const duplicate = records.find((r) => r.sha256 === sha256)
  if (duplicate) return { record: duplicate, platforms: Object.keys(loaded.sources) }
  const baseId = id ? slug(id) : slug(path.basename(absolute, path.extname(absolute)))
  let finalId = baseId
  for (let n = 2; records.some((r) => r.id === finalId); n += 1) finalId = `${baseId}-${n}`
  const file = `${finalId}.js`
  writeFileSync(path.join(lxDir(), file), code, 'utf8')
  const record: LxSourceRecord = {
    id: finalId,
    name: meta.name || finalId,
    version: meta.version,
    file,
    sha256,
    enabled: true,
    addedAt: new Date().toISOString(),
  }
  records.push(record)
  writeIndex(records)
  return { record, platforms: Object.keys(loaded.sources) }
}

export function removeSource(id: string): LxSourceRecord {
  const records = readIndex()
  const record = records.find((r) => r.id === id)
  if (!record) throw new AstraError('NOT_FOUND', `没有音源 ${id}`, { exitCode: 4, hint: '先用 `astra music source list` 看已导入的音源' })
  rmSync(path.join(lxDir(), record.file), { force: true })
  writeIndex(records.filter((r) => r.id !== id))
  return record
}

export function setSourceEnabled(id: string, enabled: boolean): LxSourceRecord {
  const records = readIndex()
  const record = records.find((r) => r.id === id)
  if (!record) throw new AstraError('NOT_FOUND', `没有音源 ${id}`, { exitCode: 4 })
  record.enabled = enabled
  writeIndex(records)
  return record
}

const cache = new Map<string, Promise<LoadedLxSource>>()

/** 按导入顺序加载所有启用的音源。单个加载失败只跳过它，失败原因一并返回。 */
export async function loadEnabledSources(): Promise<{ loaded: { record: LxSourceRecord; source: LoadedLxSource }[]; failed: { id: string; error: string }[] }> {
  const loaded: { record: LxSourceRecord; source: LoadedLxSource }[] = []
  const failed: { id: string; error: string }[] = []
  for (const record of readIndex().filter((r) => r.enabled)) {
    const file = path.join(lxDir(), record.file)
    let pending = cache.get(record.sha256)
    if (!pending) {
      pending = (async () => loadLxSource(readFileSync(file, 'utf8'), record.file))()
      cache.set(record.sha256, pending)
    }
    try {
      loaded.push({ record, source: await pending })
    } catch (err) {
      cache.delete(record.sha256)
      failed.push({ id: record.id, error: (err as Error).message })
    }
  }
  return { loaded, failed }
}

/** 数据目录里存在但没登记的脚本（手工拷进去的），提示用户。 */
export function orphanScripts(): string[] {
  const known = new Set(readIndex().map((r) => r.file))
  return readdirSync(lxDir()).filter((f) => f.endsWith('.js') && !known.has(f))
}

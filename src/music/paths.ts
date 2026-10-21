/**
 * 落盘路径模板。
 *
 * 顺序：先净化每个变量值，再套模板 —— 反过来，歌手名 `AC/DC` 会凭空多出一层目录。
 */
import path from 'node:path'

export interface PathVars {
  artist: string
  albumartist: string
  album: string
  title: string
  year: string
  track: string
  disc: string
  ext: string
}

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

export function sanitizeSegment(segment: string, maxLength = 100): string {
  let cleaned = segment.replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim()
  // Windows 会静默剥掉末尾的点和空格
  cleaned = cleaned.replace(/[. ]+$/, '')
  if (RESERVED.test(cleaned)) cleaned = `_${cleaned}`
  if (cleaned.length > maxLength) cleaned = cleaned.slice(0, maxLength).trim()
  return cleaned || '_'
}

export function renderTemplate(template: string, vars: PathVars): string {
  const safe = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v === '' ? '' : sanitizeSegment(v)])) as unknown as PathVars
  const rendered = template.replace(/\{(\w+)(?::(\d+))?\}/g, (whole, name: string, pad: string | undefined) => {
    const value = (safe as unknown as Record<string, string | undefined>)[name]
    if (value === undefined) return whole
    return pad === undefined || value === '' ? value : value.padStart(Number(pad), '0')
  })
  return rendered
    .split(/[\\/]+/)
    .map((segment) => segment.replace(/^\s*-\s*|\s*-\s*$/g, '').trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => sanitizeSegment(segment))
    .join('/')
}

export function resolveInside(root: string, relative: string): string {
  const base = path.resolve(root)
  const absolute = path.resolve(base, relative)
  if (absolute !== base && !absolute.startsWith(base + path.sep)) throw new Error(`路径逃出了音乐目录：${relative}`)
  return absolute
}

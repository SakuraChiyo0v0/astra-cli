/**
 * 落盘路径模板（音乐与视频共用）。
 *
 * 顺序：先净化每个变量值，再套模板 —— 反过来，歌手名 `AC/DC` 会凭空多出一层目录。
 * 模板本身的 `/` 是作者写的层级分隔符，要保留。
 */
import path from 'node:path'

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

/** 变量表是开放的：音乐传 artist/album，视频传 uploader/bvid，互不干扰。 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const safe: Record<string, string> = {}
  for (const [k, v] of Object.entries(vars)) safe[k] = v === '' ? '' : sanitizeSegment(v)
  const rendered = template.replace(/\{(\w+)(?::(\d+))?\}/g, (whole, name: string, pad: string | undefined) => {
    const value = safe[name]
    if (value === undefined) return whole
    return pad === undefined || value === '' ? value : value.padStart(Number(pad), '0')
  })
  return rendered
    .split(/[\\/]+/)
    // 变量为空时会留下模板里的字面分隔符（如 `{page} {part}.mp4` → `01 .mp4`），
    // 去掉段内多余空格和孤立的连接符，别在文件名里留 ` .` 这种脏东西
    .map((segment) => segment.replace(/\s+/g, ' ').replace(/\s+([.．])/g, '$1').replace(/^\s*-\s*|\s*-\s*$/g, '').trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => sanitizeSegment(segment))
    .join('/')
}

export function resolveInside(root: string, relative: string): string {
  const base = path.resolve(root)
  const absolute = path.resolve(base, relative)
  if (absolute !== base && !absolute.startsWith(base + path.sep)) throw new Error(`路径逃出了根目录：${relative}`)
  return absolute
}

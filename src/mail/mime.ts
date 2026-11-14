/**
 * MIME 解码：只解「读验证码」需要的部分。
 *
 * 处理：头部折行、`=?UTF-8?B?…?=` 编码字、base64 / quoted-printable 正文、
 * multipart 递归（优先 text/plain，退到 text/html 去标签）、GBK/GB18030 等中文编码。
 *
 * 不处理附件（验证码邮件几乎不带附件，带了也不影响抽码）。
 */

/** 把一个头字段值里的编码字（RFC 2047）解成普通字符串。 */
export function decodeWords(value: string): string {
  return value
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset: string, enc: string, text: string) => {
      try {
        if (enc.toUpperCase() === 'B') {
          return decodeCharset(Buffer.from(text, 'base64'), charset)
        }
        const bytes = Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) =>
          String.fromCharCode(parseInt(hex, 16))), 'latin1')
        return decodeCharset(bytes, charset)
      } catch {
        return text
      }
    })
    // 相邻编码字之间常有折行空格，解完要去掉
    .replace(/\?=\s+=\?/g, '?==?')
}

export function decodeCharset(bytes: Buffer, charset: string): string {
  const name = (charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '')
  const candidates = name === 'gb2312' || name === 'gbk' ? ['gb18030', 'gbk'] : [name]
  for (const label of candidates) {
    try {
      return new TextDecoder(label, { fatal: false }).decode(bytes)
    } catch {
      /* 试下一个 */
    }
  }
  return bytes.toString('utf8')
}

export function decodeQuotedPrintable(input: string): string {
  // `=` 后跟换行是软换行；`=XX` 是字节
  const withoutSoftBreak = input.replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < withoutSoftBreak.length; i += 1) {
    const ch = withoutSoftBreak[i]
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(withoutSoftBreak.slice(i + 1, i + 3))) {
      bytes.push(parseInt(withoutSoftBreak.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(withoutSoftBreak.charCodeAt(i))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** 头部解析：支持折行（续行以空格/Tab 开头），键一律小写。 */
export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  let lastKey = ''
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    if (/^[ \t]/.test(line) && lastKey) {
      out[lastKey] += ` ${line.trim()}`
      continue
    }
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    out[key] = line.slice(idx + 1).trim()
    lastKey = key
  }
  return out
}

interface Part {
  headers: Record<string, string>
  body: string
  /** 拆分时正文被当作二进制传的（base64/qp 在文本层解，这里保持字符串）。 */
}

function splitPart(raw: Buffer): Part {
  const text = raw.toString('latin1')
  const match = /\r?\n\r?\n/.exec(text)
  if (!match) return { headers: {}, body: '' }
  const headerText = text.slice(0, match.index)
  const bodyText = text.slice(match.index + match[0].length)
  return { headers: parseHeaders(headerText), body: bodyText }
}

/** 按 Content-Transfer-Encoding 把「latin1 字符串」还原成真实字节。 */
function decodeTransfer(body: string, encoding: string, charset: string): string {
  const enc = (encoding || '').toLowerCase()
  if (enc === 'base64') {
    const compact = body.replace(/\s+/g, '')
    return decodeCharset(Buffer.from(compact, 'base64'), charset)
  }
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body)
  return decodeCharset(Buffer.from(body, 'latin1'), charset)
}

function contentTypeOf(headers: Record<string, string>): { type: string; params: Record<string, string> } {
  const raw = headers['content-type'] ?? 'text/plain'
  const [type = 'text/plain', ...rest] = raw.split(';')
  const params: Record<string, string> = {}
  for (const piece of rest) {
    const idx = piece.indexOf('=')
    if (idx < 0) continue
    const key = piece.slice(0, idx).trim().toLowerCase()
    const value = piece.slice(idx + 1).trim().replace(/^"|"$/g, '')
    params[key] = value
  }
  return { type: type.trim().toLowerCase(), params }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t\r\f\v]+/g, ' ')
}

function collect(part: Part, plain: string[], html: string[], depth = 0): void {
  if (depth > 6) return
  const { type, params } = contentTypeOf(part.headers)
  if (type.startsWith('multipart/') && params.boundary) {
    const marker = `--${params.boundary}`
    const segments = part.body.split(marker)
    for (const segment of segments.slice(1)) {
      if (/^--/.test(segment)) break // 结束标记
      const trimmed = segment.replace(/^\r?\n/, '')
      collect(splitPart(Buffer.from(trimmed, 'latin1')), plain, html, depth + 1)
    }
    return
  }
  const charset = params.charset ?? 'utf-8'
  const text = decodeTransfer(part.body, part.headers['content-transfer-encoding'] ?? '', charset)
  if (type === 'text/plain') plain.push(text)
  else if (type === 'text/html') html.push(stripHtml(text))
}

/** 抽出可读正文：优先 text/plain，没有就用去标签的 HTML。 */
export function extractText(raw: Buffer, limit = 20_000): string {
  const root = splitPart(raw)
  const plain: string[] = []
  const html: string[] = []
  collect(root, plain, html)
  const text = plain.length > 0 ? plain.join('\n') : html.join('\n')
  return text.replace(/\u0000/g, '').slice(0, limit)
}

/** 顶部头字段（from / subject / date / content-type），值已解编码字。 */
export function readHeaders(raw: Buffer): Record<string, string> {
  const root = splitPart(raw)
  const out: Record<string, string> = {}
  for (const key of ['from', 'subject', 'date', 'to', 'content-type']) {
    if (root.headers[key] !== undefined) out[key] = decodeWords(root.headers[key])
  }
  return out
}

/** `Date` 头 → Date；解析不了就 null。 */
export function parseMailDate(value: string | undefined): Date | null {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : new Date(t)
}

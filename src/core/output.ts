/**
 * stdout 只写一个 JSON 对象（AI 只解析这一个）；进度、诊断一律走 stderr。
 */
import { AstraError } from './errors.ts'

export interface Ok<T> {
  ok: true
  data: T
  /** 不影响成功、但 AI 应该转告用户的事（比如音质被降级、标签没写上）。 */
  warnings?: string[]
}

export interface Fail {
  ok: false
  error: { code: string; message: string; hint: string | null; retryable: boolean; details?: unknown }
}

export function okResult<T>(data: T, warnings: string[] = []): Ok<T> {
  return warnings.length > 0 ? { ok: true, data, warnings } : { ok: true, data }
}

export function failResult(err: AstraError): Fail {
  const error: Fail['error'] = { code: err.code, message: err.message, hint: err.hint, retryable: err.retryable }
  if (err.details !== undefined) error.details = err.details
  return { ok: false, error }
}

// 读端提前关闭（`astra ... | head`）时 stdout 会报 EPIPE；结果已经没人要了，安静退出而不是崩出一屏堆栈
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(process.exitCode ?? 0)
  throw err
})

export function writeJson(value: unknown, pretty: boolean): void {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : undefined) + '\n')
}

/** 一条命令的表格视图：`--table` 时输出它，默认仍走 JSON。 */
export interface TableView {
  headers: string[]
  rows: (string | number | null)[][]
}

/**
 * 把 `data.table` 渲染成对齐的文本。
 *
 * 设计：命令自己决定表格长什么样（哪些列、怎么拼接），这里只管排版。
 * 这样每个命令能选出"人看一眼最想知道的几列"，而不是把整个 JSON 摊平。
 *
 * 宽度按**字符显示宽度**算，不是 `length` —— 中文占两格，
 * 用 `length` 的话列会对不齐（`missing` / 歌名里全是中文）。
 */
export function renderTable(view: TableView): string {
  const width = (s: string): number => [...s].reduce((n, c) => n + (isWide(c) ? 2 : 1), 0)
  const cell = (v: string | number | null): string => (v === null ? '-' : String(v))

  const cols = view.headers.length
  const widths = view.headers.map((h) => width(h))
  for (const row of view.rows) {
    for (let i = 0; i < cols; i += 1) widths[i] = Math.max(widths[i]!, width(cell(row[i] ?? null)))
  }
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - width(s)))
  const line = (cells: string[]): string => cells.map((c, i) => pad(c, widths[i]!)).join('  ').trimEnd()

  return [
    line(view.headers),
    // 分隔线用 ASCII 的 `-`，不用 `─`：后者是宽字符（占 2 格），
    // 按列宽重复 N 次会变成 2N 格，整行比数据行宽一倍。
    line(widths.map((w) => '-'.repeat(w))),
    ...view.rows.map((row) => line(Array.from({ length: cols }, (_, i) => cell(row[i] ?? null)))),
  ].join('\n')
}

/** 粗略判断是不是宽字符（CJK / 全角标点）。够用就行，不追求 Unicode 完整分类。 */
function isWide(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  )
}

/** 进度行。`ASTRA_QUIET=1` 时不输出。 */
export function progress(event: string, fields: Record<string, unknown> = {}): void {
  if (process.env.ASTRA_QUIET === '1') return
  process.stderr.write(JSON.stringify({ event, ...fields }) + '\n')
}

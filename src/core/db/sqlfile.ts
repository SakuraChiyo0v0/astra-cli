/**
 * 把 .sql 文件切成一条条语句（给 `db exec` / `db schema apply` 用）。
 *
 * 为什么不能简单按 `;` split：
 * - 字符串里的分号（`'a;b'`）、引号标识符（`"col;x"`）
 * - `--` 行注释、`/* *\/` 块注释
 * - PG 的 `$$ ... $$` / `$tag$ ... $tag$`（函数体里整段都是分号）
 *
 * 这些全被下面的状态机跳过，只有「正常态」的分号才算语句分隔。
 */

export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let buf = ''
  let i = 0
  const len = sql.length

  const push = () => {
    const text = buf.trim()
    buf = ''
    if (text && !/^(--.*|\/\*[\s\S]*?\*\/)$/.test(text)) out.push(text)
  }

  while (i < len) {
    const ch = sql[i]!
    const next = i + 1 < len ? sql[i + 1]! : ''

    // 行注释
    if (ch === '-' && next === '-') {
      while (i < len && sql[i] !== '\n') {
        buf += sql[i]
        i += 1
      }
      continue
    }

    // 块注释
    if (ch === '/' && next === '*') {
      buf += '/*'
      i += 2
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) {
        buf += sql[i]
        i += 1
      }
      buf += '*/'
      i += 2
      continue
    }

    // 单引号字符串：'' 是转义
    if (ch === "'") {
      buf += ch
      i += 1
      while (i < len) {
        buf += sql[i]
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            buf += sql[i + 1]
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }

    // 双引号标识符
    if (ch === '"') {
      buf += ch
      i += 1
      while (i < len) {
        buf += sql[i]
        if (sql[i] === '"') {
          i += 1
          break
        }
        i += 1
      }
      continue
    }

    // PG 美元引用：$$ 或 $tag$
    if (ch === '$') {
      const rest = sql.slice(i)
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(rest)
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        if (end >= 0) {
          buf += sql.slice(i, end + tag.length)
          i = end + tag.length
          continue
        }
      }
    }

    if (ch === ';') {
      push()
      i += 1
      continue
    }

    buf += ch
    i += 1
  }

  push()
  return out
}

/** 语句类型（用于判断是不是写操作、以及输出里的 statement 字段）。 */
export function statementKind(sql: string): string {
  const cleaned = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/g, '')
  const m = /^([A-Za-z]+)/.exec(cleaned)
  return m ? m[1]!.toLowerCase() : 'unknown'
}

const READONLY = new Set(['select', 'with', 'show', 'explain', 'values', 'table', 'pragma'])

export function isReadonly(sql: string): boolean {
  return READONLY.has(statementKind(sql))
}

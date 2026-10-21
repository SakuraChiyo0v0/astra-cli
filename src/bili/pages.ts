/**
 * `--pages` 的解析：把 `1,3-5` 这种写法变成 0-based 的分 P 下标。
 *
 * 用户看到的是 P1 / P2（1-based），内部 `pageIndex` 是 0-based。
 * 差一位的地方最容易写错，所以拆成纯函数单独测。
 */

export interface PageSelection {
  /** 0-based 下标，已排序去重。 */
  indexes: number[]
  /** 越界的部分（用户写了但视频里没有），用来提示，不当作错误。 */
  outOfRange: number[]
}

/**
 * 解析分 P 选择器。
 *
 * - `2` → [2]（P2）
 * - `2,3` → [2,3]
 * - `1,3-5` → [1,3,4,5]
 * - `3-1` → [1,3]（写成倒序也接受，不报错）
 * - 非法写法（`a`、`1-`、`0`、负数）抛错 —— 静默忽略会让人以为已经下过了
 *
 * @param total 视频总 P 数；给了就会把越界的单列出来
 */
export function parsePageSelection(input: string, total?: number): PageSelection {
  const text = input.trim()
  if (text === '') throw new Error('--pages 不能为空')

  const wanted = new Set<number>()
  for (const piece of text.split(',')) {
    const part = piece.trim()
    if (part === '') continue
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from < 1 || to < 1) throw new Error(`--pages 里的 P 号从 1 开始，收到「${part}」`)
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      for (let p = lo; p <= hi; p += 1) wanted.add(p)
      continue
    }
    if (!/^\d+$/.test(part)) throw new Error(`--pages 里认不出「${part}」，写法是 1,3-5`)
    const one = Number(part)
    if (one < 1) throw new Error(`--pages 里的 P 号从 1 开始，收到「${part}」`)
    wanted.add(one)
  }
  if (wanted.size === 0) throw new Error('--pages 里没有有效的 P 号')

  const sorted = [...wanted].sort((a, b) => a - b)
  if (total === undefined) return { indexes: sorted.map((p) => p - 1), outOfRange: [] }

  const inRange = sorted.filter((p) => p <= total)
  return {
    indexes: inRange.map((p) => p - 1),
    outOfRange: sorted.filter((p) => p > total),
  }
}

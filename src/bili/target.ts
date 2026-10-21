/**
 * 把用户/AI 给的输入解析成 B 站目标。
 *
 * 接受：
 * - `BV17x411w7KC` / `bv17x411w7kc`（大小写不敏感）
 * - `av170001`
 * - `bilibili.com/video/BV...`、带 `?p=3` 的分 P 参数
 * - `b23.tv/xxxx` 短链（需要联网展开）
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'

export interface BiliTarget {
  kind: 'video'
  bvid: string
  /** 链接里带的 p 参数（1 起）。 */
  page: number | null
}

// 前缀大小写不敏感（用户常手打成 bv），后面的 10 位**保留原样**：
// BV 号里的数字字母是大小写敏感的，改了就是另一个视频。
const BV_PATTERN = /bV([0-9A-Za-z]{10})/i

function normalizeBv(text: string): string | null {
  const match = text.match(BV_PATTERN)
  return match ? `BV${match[1]!}` : null
}

export function parseBiliInput(input: string): BiliTarget | { kind: 'unknown'; raw: string } {
  const text = input.trim()
  const direct = normalizeBv(text)
  if (direct) return { kind: 'video', bvid: direct, page: pageFromUrl(text) }

  const av = text.match(/^av(\d+)$/i)
  if (av) return { kind: 'video', bvid: `av${av[1]}`, page: null }

  const fromUrl = normalizeBv(text)
  if (fromUrl) return { kind: 'video', bvid: fromUrl, page: pageFromUrl(text) }

  return { kind: 'unknown', raw: text }
}

function pageFromUrl(text: string): number | null {
  const match = text.match(/[?&]p=(\d+)/)
  return match ? Number(match[1]) : null
}

/** 展开 b23.tv 短链。返回最终 URL。 */
export async function expandShortLink(url: string, signal?: AbortSignal): Promise<string> {
  const options: Parameters<typeof httpRequest>[1] = {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0' },
    timeoutMs: 10_000,
    retries: 1,
  }
  if (signal) options.signal = signal
  const response = await httpRequest(url, options)
  await response.body?.cancel()
  return response.url || url
}

export async function parseBiliTarget(input: string, signal?: AbortSignal): Promise<BiliTarget> {
  const parsed = parseBiliInput(input)
  if (parsed.kind === 'video') return parsed

  // 可能是短链：展开后再解析
  if (/b23\.tv\//i.test(input)) {
    const expanded = await expandShortLink(input.match(/https?:\/\/[^\s]+/)![0], signal)
    const again = parseBiliInput(expanded)
    if (again.kind === 'video') return again
  }
  throw new AstraError('BILI_BAD_TARGET', `认不出这是什么：${input.slice(0, 60)}`, {
    exitCode: 2,
    hint: '给 BV 号、av 号，或 bilibili.com / b23.tv 的视频链接',
  })
}

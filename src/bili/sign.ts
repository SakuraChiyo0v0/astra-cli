/**
 * B 站的 wbi 签名。
 *
 * 2023 年后大部分 web 接口都要求 `w_rid`（md5）与 `wts`（时间戳）：
 *   1. `/x/web-interface/nav` 的 `wbi_img.img_url` / `sub_url` 各取文件名（去掉扩展名），拼成 64 字符
 *   2. 用固定的 64 位混淆表重排，取前 32 位作为 mixin key
 *   3. 参数按 key 升序拼成 query，再拼上 mixin key，取 md5
 *
 * 实测（2026-10-21）：不带签名调 `x/player/playurl` 也能通，但**画质封顶 360P**；
 * 带签名且登录后才可能拿到高画质。签名本身不会提升画质，登录才会。
 */
import { createHash } from 'node:crypto'

/** 官方前端的混淆表（固定值）。 */
const MIXIN_KEY_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
]

function keyFromUrl(url: string): string {
  return url.split('/').pop()?.split('.')[0] ?? ''
}

export function mixinKey(imgUrl: string, subUrl: string): string {
  const raw = keyFromUrl(imgUrl) + keyFromUrl(subUrl)
  return MIXIN_KEY_TAB.map((i) => raw[i] ?? '').join('').slice(0, 32)
}

export interface WbiKeys {
  imgUrl: string
  subUrl: string
  /** 拿到的 unix 秒；官方 key 每天轮换。 */
  fetchedAt: number
}

/** 给参数加上 wts / w_rid。返回完整的 query 串（不含 `?`）。 */
export function signParams(params: Record<string, string | number>, keys: WbiKeys, now = Date.now()): string {
  const withWts: Record<string, string> = { ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), wts: String(Math.floor(now / 1000)) }
  const query = Object.keys(withWts)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(withWts[k]!)}`)
    .join('&')
  const wRid = createHash('md5').update(query + mixinKey(keys.imgUrl, keys.subUrl)).digest('hex')
  return `${query}&w_rid=${wRid}`
}

/**
 * 画质常量。B 站用 qn 编号，DASH 下 `dash.video[].id` 也是这一套。
 * 未登录封顶 360P（实测），登录后才可能拿到 1080P / 4K / HDR。
 */
export const QUALITY_NAMES: Record<number, string> = {
  127: '8K',
  126: '杜比视界',
  125: 'HDR',
  120: '4K',
  116: '1080P60',
  112: '1080P+',
  80: '1080P',
  74: '720P60',
  64: '720P',
  32: '480P',
  16: '360P',
  6: '240P',
}

/** 从高到低的可请求档位（登录后才有意义）。 */
export const QUALITY_ORDER = [127, 126, 125, 120, 116, 112, 80, 74, 64, 32, 16, 6]

export function qualityName(id: number): string {
  return QUALITY_NAMES[id] ?? `${id}P`
}

/**
 * 抖音 Web 端的 `x-secsdk-web-signature`。
 *
 * 抖音只对一小撮路径做签名保护，其中就包括详情与收藏：不带签名会回
 * `403 Blocked by ArgusSecurityPlugin Uifid Not Found`，与 cookie 对不对无关。
 *
 * 算法纯函数，没有 nonce、没有会话状态：
 *
 *     query = URLSearchParams(除签名外的全部参数).toString()
 *     sig   = md5(`${uifid}_${timestamp}_${SALT}_${query}`)
 *
 * `uifid` 是官方页面里由 secsdk 生成的访客 id（`UIFID_TEMP`）。实测服务端只校验
 * 签名与 uifid 自洽，**随机 76 位 hex 也能过**（10/10 成功），所以我们自己编一个，
 * 不必依赖浏览器。
 *
 * SALT 是字节 `@byted/secsdk-strategy` 里 per-project 的常量（project 34 = douyin_web）。
 * **这个值会随 SDK 升级变化**，变了就是全站 403 —— 出错时先怀疑它。
 */
import { createHash, randomBytes } from 'node:crypto'

/** 与浏览器一致的 UA：签名里也会掺 UA 指纹，换 UA 请连同这里一起换。 */
export const DOUYIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 从 runtime_bundler_34.js 的字符串表取的盐；变化即签名全失效。 */
export const WEB_SIGN_SALT = 'A96D855A08C0A9707F8BEF0D9A527E4E'

export const SIGNATURE_PARAM = 'x-secsdk-web-signature'
export const EXPIRE_HEADER = 'x-secsdk-web-expire'

export type Pair = [string, string]

/** 随机访客 id：76 位小写 hex，形状与官方 `UIFID_TEMP` 一致。 */
export function randomUifid(): string {
  return randomBytes(38).toString('hex')
}

/**
 * 生成带签名的 query（已含 uifid / timestamp / 签名本身）。
 *
 * 编码必须与 JS `URLSearchParams.toString()` 完全一致：同一串既参与哈希又要发出去，
 * 两处编码不同就等于对着一串平台没见过的字节签名。这里直接用 URLSearchParams 本身。
 */
export function signQuery(pairs: Pair[], uifid: string, timestamp: number): { query: string; signature: string } {
  const covered: Pair[] = [...pairs]
  if (!covered.some(([k]) => k === 'uifid')) covered.push(['uifid', uifid])
  covered.push(['timestamp', String(timestamp)])
  const query = new URLSearchParams(covered).toString()
  const signature = createHash('md5').update(`${uifid}_${timestamp}_${WEB_SIGN_SALT}_${query}`).digest('hex')
  return { query, signature }
}

/** 签名后要一起发的请求头（平台自己页面就是这么发的）。 */
export function signHeaders(uifid: string, signature: string, timestamp: number): Record<string, string> {
  return {
    uifid,
    [SIGNATURE_PARAM]: signature,
    [EXPIRE_HEADER]: String(timestamp),
  }
}

/** 把 cookie 串拆成键值对（同名后者覆盖前者）。 */
export function parseCookies(raw: string): Record<string, string> {
  const jar: Record<string, string> = {}
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) jar[key] = value
  }
  return jar
}

export function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
}

/** 从 cookie / cURL 文本里取出访客 id（签名要绑它，登录态越久越稳）。 */
export function uifidFromCookie(raw: string): string | null {
  const jar = parseCookies(raw)
  for (const name of ['uifid', 'uifid_temp', 'uifidtemp', 'UIFID', 'UIFID_TEMP', 'UIFIDTEMP']) {
    if (jar[name]) return jar[name]!
  }
  return null
}

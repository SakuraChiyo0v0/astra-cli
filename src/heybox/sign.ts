/**
 * 小黑盒（heybox / xiaoheihe）请求签名。
 *
 * 每个请求都要带 `hkey` / `_time` / `nonce`；写接口（评论、发帖）走 workshop 域名时再加 `_rnd`。
 *
 * 算法来源：MIT 许可的 Insect-rippler/XIAOHEIHE_MCP（`src/signing/hkey.ts`），
 * 这里按协议事实重写并保留下游测试向量，用来锁行为。上游改动时先跑单测，再怀疑接口。
 */
import { createHash, createHmac } from 'node:crypto'

/** 客户端混淆用的字符表。 */
const ALPHABET = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89'

/** workshop `_rnd` 的版本前缀。 */
export const WORKSHOP_RND_VERSION = '15'

/** workshop `_rnd` 的 HMAC 密钥；平台轮换它会让所有写接口失效。 */
export const WORKSHOP_RND_SECRET = 'Z7mFG4tQp9Ws2LxB8H'

export interface HkeyParams {
  hkey: string
  _time: number
  nonce: string
}

export interface HkeyOptions {
  /** 毫秒时间戳，默认 `Date.now()`。 */
  nowMs?: number
  /** 参与 nonce 的随机数，默认 `Math.random()`。 */
  random?: number
  /** 直接指定 nonce（给了就忽略 `random`）。 */
  nonce?: string
}

function md5Hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex')
}

/** 逐字符按 `charCode % table.length` 映射到字符表。 */
function projectChars(value: string, table: string): string {
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    out += table[value.charCodeAt(i) % table.length]
  }
  return out
}

/** 轮转交织：a0 b0 c0 a1 b1 c1 … */
function interleave(parts: string[]): string {
  const maxLength = Math.max(...parts.map((part) => part.length))
  let out = ''
  for (let i = 0; i < maxLength; i += 1) {
    for (const part of parts) {
      if (i < part.length) out += part[i]
    }
  }
  return out
}

/** GF(2^8) 上的倍乘（AES 多项式）。 */
function xtime(value: number): number {
  return value & 0x80 ? ((value << 1) ^ 0x1b) & 0xff : (value << 1) & 0xff
}

function q(value: number): number {
  return xtime(value) ^ value
}

function r(value: number): number {
  return q(xtime(value))
}

function y(value: number): number {
  return r(q(xtime(value)))
}

function g(value: number): number {
  return y(value) ^ r(value) ^ q(value)
}

/** 四字节一列的混淆。 */
function mixColumns(values: [number, number, number, number]): [number, number, number, number] {
  const [a, b, c, d] = values
  return [
    g(a) ^ y(b) ^ r(c) ^ q(d),
    q(a) ^ g(b) ^ y(c) ^ r(d),
    r(a) ^ q(b) ^ g(c) ^ y(d),
    y(a) ^ r(b) ^ q(c) ^ g(d),
  ]
}

/** 归一化成 `/a/b/`：去重复斜杠、补首尾斜杠。 */
export function normalizePath(path: string): string {
  return `/${path.split('/').filter(Boolean).join('/')}/`
}

/** 给一条路径生成 `hkey` / `_time` / `nonce`。 */
export function signPath(path: string, options: HkeyOptions = {}): HkeyParams {
  const nowMs = options.nowMs ?? Date.now()
  const time = Math.floor(nowMs / 1000)
  const nonce = options.nonce ?? md5Hex(`${time}${options.random ?? Math.random()}`).toUpperCase()

  const stem = interleave([
    projectChars(String(time + 1), ALPHABET.slice(0, -2)),
    projectChars(normalizePath(path), ALPHABET),
    projectChars(nonce, ALPHABET),
  ]).slice(0, 20)

  const hash = md5Hex(stem)
  const tail = [...hash.slice(-6)].map((char) => char.charCodeAt(0))
  const mixed = mixColumns([tail[0]!, tail[1]!, tail[2]!, tail[3]!])
  const checksumSum = mixed.reduce((sum, value) => sum + value, 0) + tail[4]! + tail[5]!
  const checksum = String(checksumSum % 100).padStart(2, '0')

  return {
    hkey: projectChars(hash.slice(0, 5), ALPHABET.slice(0, -4)) + checksum,
    _time: time,
    nonce,
  }
}

/** workshop 专用签名：`15:<hmac-sha256 hex>`。 */
export function workshopRnd(params: Pick<HkeyParams, 'nonce' | '_time'>): string {
  const { nonce, _time: time } = params
  const message = `${WORKSHOP_RND_SECRET}${nonce}${time}:${nonce}`
  const hex = createHmac('sha256', WORKSHOP_RND_SECRET).update(message, 'utf8').digest('hex')
  return `${WORKSHOP_RND_VERSION}:${hex}`
}

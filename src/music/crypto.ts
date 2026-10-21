/**
 * 网易云的两条加密通道。登录、私人歌单这类带账号的端点必须走加密，匿名明文端点拿不到。
 *
 * - **weapi**：AES-CBC 两层 + RSA（NO_PADDING）。扫码登录的 unikey / 轮询用它。
 *   实测 2026-10-21 仍可用：unikey 返回 code 200，轮询未扫码时返回 801。
 * - **eapi**：AES-ECB，`params` 和响应体都是大写 hex。带账号的播放地址、日推一类用它。
 *
 * 常量是协议固定值（公开生态通用），不是密钥材料。
 */
import { createCipheriv, createDecipheriv, createHash, createPublicKey, publicEncrypt, constants, randomBytes } from 'node:crypto'

const AES_IV = '0102030405060708'
const PRESET_KEY = '0CoJUm6Qyw8W8jud'
const RSA_MODULUS_HEX =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'
const RSA_EXPONENT_HEX = '010001'
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const KEY_LENGTH = 16

const EAPI_KEY = 'e82ckenh8dichen8'
const EAPI_SALT = '36cd479b6b5'

function aesCbcBase64(plain: string, key: string): string {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(AES_IV, 'utf8'))
  return Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]).toString('base64')
}

export function randomSecretKey(): string {
  const bytes = randomBytes(KEY_LENGTH)
  let key = ''
  for (let i = 0; i < KEY_LENGTH; i += 1) key += BASE62[bytes[i]! % BASE62.length]
  return key
}

function rsaPublicKey() {
  const der = (tag: number, body: Buffer): Buffer => {
    const length = body.length < 128 ? Buffer.from([body.length]) : Buffer.from([0x81, body.length])
    return Buffer.concat([Buffer.from([tag]), length, body])
  }
  const integer = (v: Buffer): Buffer => der(0x02, v[0]! >= 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v)
  return createPublicKey({
    key: der(0x30, Buffer.concat([integer(Buffer.from(RSA_MODULUS_HEX, 'hex')), integer(Buffer.from(RSA_EXPONENT_HEX, 'hex'))])),
    format: 'der',
    type: 'pkcs1',
  })
}

export function rsaEncryptHex(plain: string): string {
  const buffer = Buffer.from(plain, 'utf8')
  const padded = Buffer.concat([Buffer.alloc(Math.max(0, 128 - buffer.length)), buffer]).subarray(-128)
  return publicEncrypt({ key: rsaPublicKey(), padding: constants.RSA_NO_PADDING }, padded).toString('hex')
}

/** 注入 secretKey 时输出可复现（测试用）。 */
export function weapiEncrypt(payload: Record<string, unknown>, options: { secretKey?: string } = {}): { params: string; encSecKey: string } {
  const secretKey = options.secretKey ?? randomSecretKey()
  if (secretKey.length !== KEY_LENGTH) throw new Error('secretKey 必须是 16 个字符')
  const first = aesCbcBase64(JSON.stringify(payload), PRESET_KEY)
  const params = aesCbcBase64(first, secretKey)
  return { params, encSecKey: rsaEncryptHex(secretKey.split('').reverse().join('')) }
}

function aesEcbEncryptHex(text: string): string {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(EAPI_KEY, 'utf8'), null)
  return Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]).toString('hex').toUpperCase()
}

export function aesEcbDecryptHex(hex: string): string {
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(EAPI_KEY, 'utf8'), null)
  return Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('utf8')
}

export function eapiEncrypt(apiPath: string, payload: Record<string, unknown>): { params: string } {
  const text = JSON.stringify(payload)
  const digest = createHash('md5').update(`nobody${apiPath}use${text}md5forencrypt`).digest('hex')
  return { params: aesEcbEncryptHex(`${apiPath}-${EAPI_SALT}-${text}-${EAPI_SALT}-${digest}`) }
}

/** 响应体常是密文，但**风控错误是明文 JSON**（例如 8821），两种都要接住。 */
export function eapiDecryptBody(raw: string): { json: string; encrypted: boolean } {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) return { json: trimmed, encrypted: false }
  return { json: aesEcbDecryptHex(trimmed), encrypted: true }
}

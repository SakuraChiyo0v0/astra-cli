/**
 * 漫画 APP 接口的 token 与响应解密。
 *
 * token = md5(ts + secret)；响应 data 是 Base64(AES-256-ECB(md5hex(ts+secret) 的 ASCII 作密钥))。
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { APP_DATA_SECRET, APP_TOKEN_SECRET, APP_VERSION } from './constants.ts'

export function md5hex(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex')
}

/** 返回请求头要用的 token / tokenparam。 */
export function tokenAndParam(ts: string | number, secret = APP_TOKEN_SECRET, ver = APP_VERSION): { token: string; tokenparam: string } {
  const tsText = String(ts)
  return {
    token: md5hex(`${tsText}${secret}`),
    tokenparam: `${tsText},${ver}`,
  }
}

/**
 * 解密接口 `data` 字段。
 *
 * 密钥是 md5 hex 的 **ASCII 字节**（32 字节）→ AES-256-ECB，不是 hex 解码后的 16 字节。
 */
export function decodeRespData(encoded: string, ts: string | number, secret = APP_DATA_SECRET): string {
  const key = Buffer.from(md5hex(`${ts}${secret}`), 'utf8')
  const decipher = createDecipheriv('aes-256-ecb', key, null)
  const plain = Buffer.concat([decipher.update(Buffer.from(encoded, 'base64')), decipher.final()])
  return plain.toString('utf8')
}

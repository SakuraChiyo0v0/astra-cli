/**
 * 图片完整性校验：**下载截断必须在这里拦住，不能等发送端发现**。
 *
 * 2026-10-29 事故：`astra pixiv pull` 存下一个截断的 PNG（header 完好、解码失败），
 * 日报把它发给 Telegram，整组 10 张被 `IMAGE_PROCESS_FAILED` 顶掉。
 * 上游不管，下游就得兜底；最省事的做法是写盘前就验。
 *
 * 判据只用「容器结构」而不是完整解码（Node 里没有 PIL）：
 * - PNG 以 IEND 块结尾，截断的 PNG 一定没有
 * - JPEG 以 FF D9 结尾
 * - GIF 以 0x3B 结尾
 * - WebP 的 RIFF 长度字段必须等于实际长度 - 8
 * 这些检查是 O(1) 的，只读头尾几十字节，不会拖慢批量下载。
 */

export interface VerifyResult {
  ok: boolean
  reason?: string
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** PNG 尾部固定是 length(4)=0 + 'IEND' + CRC(4)。 */
function pngOk(buf: Buffer): VerifyResult {
  if (buf.byteLength < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    return { ok: false, reason: '不是 PNG（签名不对）' }
  }
  if (buf.byteLength < 20) return { ok: false, reason: 'PNG 太短，疑似截断' }
  const tail = buf.subarray(buf.byteLength - 12)
  if (tail.subarray(4, 8).toString('ascii') !== 'IEND') {
    return { ok: false, reason: 'PNG 缺 IEND 块（下载被截断）' }
  }
  return { ok: true }
}

function jpegOk(buf: Buffer): VerifyResult {
  if (buf.byteLength < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return { ok: false, reason: '不是 JPEG（缺 SOI）' }
  }
  const n = buf.byteLength
  if (buf[n - 2] !== 0xff || buf[n - 1] !== 0xd9) {
    return { ok: false, reason: 'JPEG 缺 EOI 标记（下载被截断）' }
  }
  return { ok: true }
}

function gifOk(buf: Buffer): VerifyResult {
  const sig = buf.subarray(0, 6).toString('ascii')
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return { ok: false, reason: '不是 GIF' }
  if (buf[buf.byteLength - 1] !== 0x3b) return { ok: false, reason: 'GIF 缺结束符（下载被截断）' }
  return { ok: true }
}

function webpOk(buf: Buffer): VerifyResult {
  if (buf.byteLength < 12 || buf.subarray(0, 4).toString('ascii') !== 'RIFF') {
    return { ok: false, reason: '不是 WebP' }
  }
  if (buf.subarray(8, 12).toString('ascii') !== 'WEBP') {
    return { ok: false, reason: 'RIFF 容器不是 WebP' }
  }
  const declared = buf.readUInt32LE(4) + 8
  if (declared !== buf.byteLength) {
    return { ok: false, reason: `WebP 声明 ${declared} 字节、实际 ${buf.byteLength} 字节（下载被截断）` }
  }
  return { ok: true }
}

/** 按扩展名（或嗅探到的魔数）校验。未知格式一律放行，不要凭空拦人。 */
export function verifyImage(buf: Buffer, ext?: string): VerifyResult {
  if (buf.byteLength === 0) return { ok: false, reason: '内容为空' }
  const e = (ext ?? '').toLowerCase().replace(/^\./, '')
  const byExt: Record<string, (b: Buffer) => VerifyResult> = {
    png: pngOk, jpg: jpegOk, jpeg: jpegOk, jfif: jpegOk, gif: gifOk, webp: webpOk,
  }
  const fn = byExt[e]
  if (fn) return fn(buf)
  // 没有扩展名或扩展名不认识：按魔数嗅探一次
  if (buf.subarray(0, 8).equals(PNG_SIG)) return pngOk(buf)
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpegOk(buf)
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF') return webpOk(buf)
  const sig = buf.subarray(0, 6).toString('ascii')
  if (sig === 'GIF87a' || sig === 'GIF89a') return gifOk(buf)
  return { ok: true }
}

/**
 * 最小 PNG 编码器：只为了把二维码画成图，不引图片库。
 *
 * PNG 的结构很固定：签名 + IHDR + IDAT（zlib 压缩的扫描线）+ IEND，
 * 每段都是「长度 + 类型 + 数据 + CRC32」。zlib 用 node:zlib 就够。
 */
import { deflateSync } from 'node:zlib'

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * 单色位图 → PNG（8 位灰度，0 = 黑，255 = 白）。
 * `pixels[row][col]` 为 true 表示黑点。
 */
export function encodeMonoPng(pixels: boolean[][], scale: number, margin: number): Buffer {
  const modules = pixels.length
  const side = (modules + margin * 2) * scale
  const width = side
  const height = side

  // 每行：1 字节滤波类型（0 = None）+ 每像素 1 字节灰度
  const raw = Buffer.alloc(height * (width + 1))
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width + 1)
    raw[rowStart] = 0
    const moduleY = Math.floor(y / scale) - margin
    const row = pixels[moduleY]
    for (let x = 0; x < width; x += 1) {
      const moduleX = Math.floor(x / scale) - margin
      const dark = row !== undefined && moduleX >= 0 && moduleX < modules ? row[moduleX] === true : false
      raw[rowStart + 1 + x] = dark ? 0 : 255
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 0 // 灰度
  ihdr[10] = 0 // 压缩
  ihdr[11] = 0 // 滤波
  ihdr[12] = 0 // 非隔行

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

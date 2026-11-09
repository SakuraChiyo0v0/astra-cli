/**
 * 最小 zip 写入器：只为 EPUB 服务（store + deflate，UTF-8 文件名，不支持 zip64）。
 *
 * EPUB 对 zip 的要求只有一条特别的：`mimetype` 必须是**第一个**条目、**不压缩**、没有额外字段 ——
 * 阅读器靠偏移 30 处直接读到 `application/epub+zip` 来认格式。`entries` 的顺序就是写入顺序。
 */
import { crc32, deflateRawSync } from 'node:zlib'

export interface ZipEntry {
  name: string
  data: Buffer
  /** 默认 deflate；mimetype 必须 store。 */
  store?: boolean
}

/** DOS 日期时间（zip 头里的格式）。固定写 2000-01-01，产物可复现。 */
const DOS_TIME = 0
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data) >>> 0
    const body = entry.store ? entry.data : deflateRawSync(entry.data, { level: 9 })
    const method = entry.store ? 0 : 8
    if (body.length > 0xffffffff || offset > 0xffffffff) throw new Error('EPUB 太大（超过 4 GB），这个 zip 写入器不支持 zip64')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // bit 11：文件名是 UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra 长度：mimetype 条目必须为 0
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

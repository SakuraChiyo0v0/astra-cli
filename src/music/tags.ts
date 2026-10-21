/**
 * 标签写入：纯 TS，不依赖 ffmpeg / mutagen。
 *
 * - MP3：去掉原有 ID3v2 头，写一个新的 ID3v2.4（UTF-8）。音频帧字节一律不动
 * - FLAC：保留 STREAMINFO 与 SEEKTABLE 等音频相关块，替换 VORBIS_COMMENT / PICTURE，去掉 PADDING 后补一块新的
 * - 其他格式（m4a / ogg）：不写，返回 warning
 *
 * 写到临时文件再 rename；音频数据部分逐字节复制，调用方可以比对哈希确认没被改。
 */
import { readFile, writeFile, rename } from 'node:fs/promises'
import type { AudioFormat } from './audio.ts'

export interface TagData {
  title: string
  artists: string[]
  album: string | null
  albumArtists: string[]
  /** YYYY-MM-DD 或 YYYY。 */
  date: string | null
  trackNo: number | null
  trackTotal: number | null
  discNo: number | null
  publisher: string | null
  lyrics: string | null
  cover: { mime: string; data: Buffer } | null
  /** 来源标记，写进自定义字段，日后能追溯。 */
  source: { platform: string; id: string }
}

// ---------- ID3v2.4 ----------

function syncsafe(n: number): Buffer {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
}

function readSyncsafe(b: Buffer, offset: number): number {
  return ((b[offset]! & 0x7f) << 21) | ((b[offset + 1]! & 0x7f) << 14) | ((b[offset + 2]! & 0x7f) << 7) | (b[offset + 3]! & 0x7f)
}

function id3Frame(id: string, body: Buffer): Buffer {
  const header = Buffer.alloc(10)
  header.write(id, 0, 'latin1')
  syncsafe(body.length).copy(header, 4)
  return Buffer.concat([header, body])
}

/** 文本帧：编码 3 = UTF-8；多值用 \0 分隔（v2.4 规范）。 */
function textFrame(id: string, values: string[]): Buffer | null {
  const clean = values.map((v) => v.trim()).filter(Boolean)
  if (clean.length === 0) return null
  return id3Frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(clean.join('\0'), 'utf8')]))
}

function txxxFrame(description: string, value: string): Buffer {
  return id3Frame('TXXX', Buffer.concat([Buffer.from([3]), Buffer.from(description, 'utf8'), Buffer.from([0]), Buffer.from(value, 'utf8')]))
}

function usltFrame(lyrics: string): Buffer {
  return id3Frame('USLT', Buffer.concat([Buffer.from([3]), Buffer.from('und', 'latin1'), Buffer.from([0]), Buffer.from(lyrics, 'utf8')]))
}

function apicFrame(mime: string, data: Buffer): Buffer {
  return id3Frame('APIC', Buffer.concat([Buffer.from([3]), Buffer.from(mime, 'latin1'), Buffer.from([0, 3, 0]), data]))
}

/** 跳过文件开头所有 ID3v2 标签（有的文件叠了不止一个），返回音频起点。 */
export function id3v2End(file: Buffer): number {
  let offset = 0
  while (file.length >= offset + 10 && file.subarray(offset, offset + 3).toString('latin1') === 'ID3') {
    const flags = file[offset + 5]!
    const size = readSyncsafe(file, offset + 6)
    offset += 10 + size + (flags & 0x10 ? 10 : 0)
  }
  return offset
}

export function buildId3(tags: TagData): Buffer {
  const frames: (Buffer | null)[] = [
    textFrame('TIT2', [tags.title]),
    textFrame('TPE1', tags.artists),
    textFrame('TALB', tags.album ? [tags.album] : []),
    textFrame('TPE2', tags.albumArtists),
    textFrame('TDRC', tags.date ? [tags.date] : []),
    textFrame('TRCK', tags.trackNo ? [tags.trackTotal ? `${tags.trackNo}/${tags.trackTotal}` : String(tags.trackNo)] : []),
    textFrame('TPOS', tags.discNo ? [String(tags.discNo)] : []),
    textFrame('TPUB', tags.publisher ? [tags.publisher] : []),
    tags.lyrics ? usltFrame(tags.lyrics) : null,
    txxxFrame('SOURCE', tags.source.platform),
    txxxFrame('SOURCE_ID', tags.source.id),
    tags.cover ? apicFrame(tags.cover.mime, tags.cover.data) : null,
  ]
  const body = Buffer.concat(frames.filter((f): f is Buffer => f !== null))
  const padding = Buffer.alloc(1024)
  const header = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0]), syncsafe(body.length + padding.length)])
  return Buffer.concat([header, body, padding])
}

export function retagMp3(file: Buffer, tags: TagData): Buffer {
  return Buffer.concat([buildId3(tags), file.subarray(id3v2End(file))])
}

// ---------- FLAC ----------

interface FlacBlock { type: number; data: Buffer }

const FLAC_STREAMINFO = 0
const FLAC_PADDING = 1
const FLAC_VORBIS_COMMENT = 4
const FLAC_PICTURE = 6

/** 文件里有没有封面（FLAC 看 PICTURE 块，MP3 看 APIC 帧）。 */
export function hasCoverArt(file: Buffer): boolean {
  const format = file.subarray(0, 4).toString('latin1') === 'fLaC' ? 'flac' : file.subarray(0, 3).toString('latin1') === 'ID3' ? 'mp3' : null
  try {
    if (format === 'flac') return parseFlacBlocks(file).blocks.some((b) => b.type === FLAC_PICTURE)
    if (format === 'mp3') {
      const end = id3v2End(file)
      return file.subarray(0, end).includes('APIC')
    }
  } catch {
    return false
  }
  return false
}


/**
 * 把文件里的内嵌封面抠出来。
 *
 * 比联网下封面可靠：文件已经有了，不依赖网络、不会因为平台换图而对不上。
 * FLAC 取 PICTURE 块，MP3 取 APIC 帧。取不到返回 null。
 */
export function extractCoverArt(file: Buffer): { mime: string; data: Buffer } | null {
  const format = file.subarray(0, 4).toString('latin1') === 'fLaC' ? 'flac' : file.subarray(0, 3).toString('latin1') === 'ID3' ? 'mp3' : null
  try {
    if (format === 'flac') {
      for (const block of parseFlacBlocks(file).blocks) {
        if (block.type !== FLAC_PICTURE) continue
        const d = block.data
        // FLAC PICTURE 结构（规范 §8）：
        //   picture type(4) | mime len(4) | mime | desc len(4) | desc | width(4) height(4)
        //   depth(4) colors(4) | data len(4) | data
        // 第一版漏掉的正是 desc len/desc 与宽高等字段，指针停在 mime 后面，
        // 读到的是描述长度当成了图片长度 —— 结果永远是 null。
        let p = 0
        p += 4 // picture type
        const mimeLen = d.readUInt32BE(p)
        p += 4
        const mime = d.subarray(p, p + mimeLen).toString('latin1')
        p += mimeLen
        const descLen = d.readUInt32BE(p)
        p += 4 + descLen
        p += 16 // width/height/depth/colors 各 4 字节
        const dataLen = d.readUInt32BE(p)
        p += 4
        const data = d.subarray(p, p + dataLen)
        if (data.length === dataLen && data.length > 0) return { mime: mime || 'image/jpeg', data }
      }
      return null
    }
    if (format === 'mp3') {
      const end = id3v2End(file)
      let p = 10
      while (p + 10 <= end) {
        const id = file.subarray(p, p + 4).toString('latin1')
        if (!/^[A-Z0-9]{4}$/.test(id)) break
        const version = file[3]!
        const size = version >= 4
          ? ((file[p + 4]! & 0x7f) << 21) | ((file[p + 5]! & 0x7f) << 14) | ((file[p + 6]! & 0x7f) << 7) | (file[p + 7]! & 0x7f)
          : file.readUInt32BE(p + 4)
        if (id === 'APIC') {
          const body = file.subarray(p + 10, p + 10 + size)
          // 编码(1) mime( 结尾) type(1) desc( 结尾) data
          let q = 1
          const mimeEnd = body.indexOf(0, q)
          if (mimeEnd < 0) return null
          const mime = body.subarray(q, mimeEnd).toString('latin1') || 'image/jpeg'
          q = mimeEnd + 1
          q += 1 // picture type
          const descEnd = body.indexOf(0, q)
          if (descEnd < 0) return null
          q = descEnd + 1
          const data = body.subarray(q)
          if (data.length > 0) return { mime, data }
        }
        p += 10 + size
      }
      return null
    }
  } catch {
    return null
  }
  return null
}

export function parseFlacBlocks(file: Buffer): { blocks: FlacBlock[]; audioStart: number; prefix: number } {
  const prefix = file.indexOf('fLaC', 0, 'latin1')
  if (prefix < 0 || prefix > 0 && prefix !== id3v2End(file)) throw new Error('不是 FLAC 文件')
  let offset = prefix + 4
  const blocks: FlacBlock[] = []
  for (;;) {
    if (offset + 4 > file.length) throw new Error('FLAC 元数据块被截断')
    const header = file[offset]!
    const last = (header & 0x80) !== 0
    const type = header & 0x7f
    const length = (file[offset + 1]! << 16) | (file[offset + 2]! << 8) | file[offset + 3]!
    const data = file.subarray(offset + 4, offset + 4 + length)
    if (data.length !== length) throw new Error('FLAC 元数据块被截断')
    blocks.push({ type, data })
    offset += 4 + length
    if (last) break
  }
  if (blocks[0]?.type !== FLAC_STREAMINFO) throw new Error('FLAC 第一个元数据块不是 STREAMINFO')
  return { blocks, audioStart: offset, prefix }
}

function vorbisComment(tags: TagData): Buffer {
  const entries: string[] = []
  const add = (key: string, value: string | null | undefined): void => {
    if (value && value.trim()) entries.push(`${key}=${value.trim()}`)
  }
  add('TITLE', tags.title)
  for (const a of tags.artists) add('ARTIST', a)
  add('ALBUM', tags.album)
  for (const a of tags.albumArtists) add('ALBUMARTIST', a)
  add('DATE', tags.date)
  if (tags.trackNo) add('TRACKNUMBER', String(tags.trackNo))
  if (tags.trackTotal) add('TRACKTOTAL', String(tags.trackTotal))
  if (tags.discNo) add('DISCNUMBER', String(tags.discNo))
  add('ORGANIZATION', tags.publisher)
  add('LYRICS', tags.lyrics)
  add('SOURCE', tags.source.platform)
  add('SOURCE_ID', tags.source.id)
  const vendor = Buffer.from('astra-cli', 'utf8')
  const parts: Buffer[] = [u32le(vendor.length), vendor, u32le(entries.length)]
  for (const entry of entries) {
    const bytes = Buffer.from(entry, 'utf8')
    parts.push(u32le(bytes.length), bytes)
  }
  return Buffer.concat(parts)
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

function pictureBlock(mime: string, data: Buffer): Buffer {
  const mimeBytes = Buffer.from(mime, 'latin1')
  // 类型 3 = 封面；宽高 / 色深 / 调色板填 0，播放器都按图片本身解析
  return Buffer.concat([u32be(3), u32be(mimeBytes.length), mimeBytes, u32be(0), u32be(0), u32be(0), u32be(0), u32be(0), u32be(data.length), data])
}

function blockHeader(type: number, length: number, last: boolean): Buffer {
  if (length > 0xffffff) throw new Error('FLAC 元数据块过大（封面超过 16MB？）')
  return Buffer.from([(last ? 0x80 : 0) | type, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff])
}

export function retagFlac(file: Buffer, tags: TagData): Buffer {
  const { blocks, audioStart } = parseFlacBlocks(file)
  const kept = blocks.filter((b) => b.type !== FLAC_VORBIS_COMMENT && b.type !== FLAC_PICTURE && b.type !== FLAC_PADDING)
  const fresh: FlacBlock[] = [...kept, { type: FLAC_VORBIS_COMMENT, data: vorbisComment(tags) }]
  if (tags.cover) fresh.push({ type: FLAC_PICTURE, data: pictureBlock(tags.cover.mime, tags.cover.data) })
  fresh.push({ type: FLAC_PADDING, data: Buffer.alloc(4096) })
  const parts: Buffer[] = [Buffer.from('fLaC', 'latin1')]
  fresh.forEach((block, i) => parts.push(blockHeader(block.type, block.data.length, i === fresh.length - 1), block.data))
  // 前置的 ID3（有的 FLAC 被塞了 ID3 头）一并丢掉，它不是标准的一部分
  parts.push(file.subarray(audioStart))
  return Buffer.concat(parts)
}

/** 音频数据在文件里的起点（用于"写标签前后音频字节一致"的校验）。 */
export function audioPayload(file: Buffer, format: AudioFormat): Buffer {
  if (format === 'mp3') return file.subarray(id3v2End(file))
  if (format === 'flac') return file.subarray(parseFlacBlocks(file).audioStart)
  return file
}

export async function writeTags(path: string, format: AudioFormat, tags: TagData): Promise<{ written: boolean; reason: string | null }> {
  if (format !== 'mp3' && format !== 'flac') return { written: false, reason: `${format} 格式暂不支持写标签` }
  const original = await readFile(path)
  const updated = format === 'mp3' ? retagMp3(original, tags) : retagFlac(original, tags)
  const tmp = path + '.tagging'
  await writeFile(tmp, updated)
  await rename(tmp, path)
  return { written: true, reason: null }
}

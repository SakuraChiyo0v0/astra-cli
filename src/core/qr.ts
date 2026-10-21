/**
 * 二维码：出 PNG 文件，也保留一份终端文本（没有图的环境下兜底）。
 *
 * 为什么默认出图：终端半块字符在聊天窗口里既扫不了、又会因为字体宽度错位。
 * AI 拿到 PNG 路径后交给 Hermes 直接发图，用户用手机扫就行。
 */
import { writeFileSync } from 'node:fs'
import qrcode from 'qrcode-generator'
import { encodeMonoPng } from './png.ts'

export interface QrImage {
  /** PNG 文件的绝对路径。 */
  path: string
  /** 图片边长（像素）。 */
  size: number
  /** PNG 的 base64，方便调用方不读文件也能直接发。 */
  base64: string
  /** 二维码编码的原始内容，文字里必须同时给出。 */
  content: string
}

export interface QrText {
  /** 终端里可直接打印的多行文本。 */
  art: string
  content: string
}

function build(content: string): ReturnType<typeof qrcode> {
  const qr = qrcode(0, 'M')
  qr.addData(content)
  qr.make()
  return qr
}

function matrix(content: string): boolean[][] {
  const qr = build(content)
  const size = qr.getModuleCount()
  const rows: boolean[][] = []
  for (let row = 0; row < size; row += 1) {
    const out: boolean[] = []
    for (let col = 0; col < size; col += 1) out.push(qr.isDark(row, col))
    rows.push(out)
  }
  return rows
}

/** 写一张 PNG 到指定路径。scale 是每个模块放大多少像素，8 在手机上扫很轻松。 */
export function writeQrPng(content: string, filePath: string, options: { scale?: number; margin?: number } = {}): QrImage {
  const scale = options.scale ?? 8
  const margin = options.margin ?? 4
  const pixels = matrix(content)
  const png = encodeMonoPng(pixels, scale, margin)
  writeFileSync(filePath, png)
  return {
    path: filePath,
    size: (pixels.length + margin * 2) * scale,
    base64: png.toString('base64'),
    content,
  }
}

/** 终端文本版：一个字符格画两行模块。图片发不出去时兜底用。 */
export function renderQrText(content: string, options: { margin?: number } = {}): QrText {
  const pixels = matrix(content)
  const size = pixels.length
  const margin = options.margin ?? 2
  const dark = (row: number, col: number): boolean => {
    if (row < 0 || col < 0 || row >= size || col >= size) return false
    return pixels[row]![col] === true
  }
  const lines: string[] = []
  for (let row = -margin; row < size + margin; row += 2) {
    let line = ''
    for (let col = -margin; col < size + margin; col += 1) {
      const upper = dark(row, col)
      const lower = dark(row + 1, col)
      line += upper && lower ? '█' : upper ? '▀' : lower ? '▄' : ' '
    }
    lines.push(line)
  }
  return { art: lines.join('\n'), content }
}

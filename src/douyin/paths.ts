/**
 * 抖音落盘路径。
 *
 * 命名口径（跟用户定的规矩一致）：**不可变 id 打头 + 能看出内容的标题**，
 * 不放时长 / 播放量这类会过期的字段。标题截到 40 字并去掉话题 tag，
 * 因为抖音的 desc 常常是「正文 #话题1 #话题2」这种一长串。
 *
 *     /视频/7686766114847673634 日常幻想指南.mp4
 *     /视频/7688662293581013915 时隔多日清空相册4.0来了/01.jpg …
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { getConfig } from '../core/config.ts'
import { AstraError } from '../core/errors.ts'
import type { DouyinItem } from './model.ts'

export function douyinRoot(override?: string): string {
  const explicit = override?.trim()
  if (explicit) {
    mkdirSync(explicit, { recursive: true })
    return path.resolve(explicit)
  }
  const configured = getConfig('douyin.dir')?.trim()
  if (!configured) {
    throw new AstraError('DOUYIN_NO_DIR', '没有设置抖音下载目录', {
      exitCode: 3,
      hint: '`astra config set douyin.dir /host-root/volume1/视频/抖音`，或本次用 `--out <目录>`',
    })
  }
  mkdirSync(configured, { recursive: true })
  return path.resolve(configured)
}

/** 文件名安全化：去控制字符、表情与路径分隔符、去掉 #话题、压空白、截断。 */
export function sanitizeTitle(raw: string, max = 24): string {
  let text = (raw ?? '')
    .replace(/#[^\s#]+/g, ' ')
    // 表情 / 变体选择符 / 零宽连接符：SMB 和部分播放器上会显示成方块，直接去掉
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  text = text.replace(/[.。\s]+$/, '')
  if (!text) return '无标题'
  const chars = [...text]
  if (chars.length > max) text = chars.slice(0, max).join('').trim()
  return text || '无标题'
}

export function baseName(item: DouyinItem): string {
  return `${item.id} ${sanitizeTitle(item.title)}`
}

export function videoPath(root: string, item: DouyinItem): string {
  return path.join(root, `${baseName(item)}.mp4`)
}

export function imageDir(root: string, item: DouyinItem): string {
  return path.join(root, baseName(item))
}

export function imagePath(dir: string, index: number, url: string): string {
  const ext = imageExt(url)
  return path.join(dir, `${String(index + 1).padStart(2, '0')}.${ext}`)
}

function imageExt(url: string): string {
  const fromPath = /\.(jpe?g|png|webp|heic)(?:\?|$)/i.exec(url)?.[1]?.toLowerCase()
  if (fromPath === 'jpeg') return 'jpg'
  if (fromPath) return fromPath
  // 抖音的 `~tplv-dy-aweme-images:q75.webp` 是缩略；原图是 `image/jpeg`
  return 'jpg'
}

/**
 * 同一个作品换个标题再下会重复。按「id + 空格」前缀在目录里找一遍，
 * 命中就当已存在 —— 只扫一层，目录里文件数量级是几百，够便宜。
 */
export function findExisting(root: string, awemeId: string): string | null {
  if (!existsSync(root)) return null
  const prefix = `${awemeId} `
  try {
    for (const name of readdirSync(root, { withFileTypes: true })) {
      if (!name.isFile()) continue
      if (!name.name.startsWith(prefix)) continue
      if (/\.part$/.test(name.name)) continue
      return path.join(root, name.name)
    }
  } catch {
    return null
  }
  return null
}

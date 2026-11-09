/**
 * 漫画落盘：`<manga.dir>/<作品名>/<分组>/<章节名>/001.jpg`，可选同级 `<章节名>.cbz`。
 */
import path from 'node:path'
import { getConfig } from '../core/config.ts'
import { homePath } from '../core/paths.ts'
import { resolveInside, sanitizeSegment } from '../core/template.ts'
import type { ChapterRef, Group } from './sources/types.ts'

export function mangaRoot(): string {
  const fromEnv = process.env.ASTRA_MANGA_DIR
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv)
  const configured = getConfig('manga.dir')
  if (configured) return configured
  return homePath('manga', 'library')
}

/**
 * 目录名：单行本统一成「第01卷」；站上只给纯编号（Komiic 的 `01`）的单话补成「第01话」；
 * 其它（`第01话` / `第09话试看` / `番外`）用站上原名。
 */
export function chapterDirName(group: Pick<Group, 'volumes'>, chapter: Pick<ChapterRef, 'name'>): string {
  if (group.volumes) {
    const m = /(\d+)/.exec(chapter.name)
    if (m) return `第${m[1]!.padStart(2, '0')}卷`
  }
  const bare = /^(\d+(?:\.\d+)?)$/.exec(chapter.name.trim())
  if (bare) return `第${bare[1]!.padStart(2, '0')}话`
  return chapter.name
}

export function chapterDir(title: string, groupName: string, dirName: string): string {
  return resolveInside(mangaRoot(), path.join(sanitizeSegment(title), sanitizeSegment(groupName), sanitizeSegment(dirName)))
}

export function comicDir(title: string): string {
  return resolveInside(mangaRoot(), sanitizeSegment(title))
}

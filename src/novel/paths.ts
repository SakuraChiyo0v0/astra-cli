/**
 * 小说落盘路径与章节缓存位置。
 */
import path from 'node:path'
import { getConfig } from '../core/config.ts'
import { homePath } from '../core/paths.ts'
import { renderTemplate, resolveInside, sanitizeSegment } from '../core/template.ts'

export function novelRoot(): string {
  const fromEnv = process.env.ASTRA_NOVEL_DIR
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv)
  const configured = getConfig('novel.dir')
  if (configured) return configured
  return homePath('novel', 'books')
}

export function novelTemplate(): string {
  return getConfig('novel.template') || '{title}/{title}.epub'
}

export function epubPath(vars: { title: string; author: string | null; source: string }): string {
  const relative = renderTemplate(novelTemplate(), { title: vars.title, author: vars.author ?? '佚名', source: vars.source })
  return resolveInside(novelRoot(), relative)
}

/** 章节缓存：`<ASTRA_HOME>/novel/cache/<书源>/<书 id>/<章 id>.json`。中断后 resume 只补缺的章。 */
export function chapterCacheDir(source: string, bookId: string): string {
  return homePath('novel', 'cache', sanitizeSegment(source), sanitizeSegment(bookId.replace(/\//g, '_'), 120))
}

export function chapterCacheFile(source: string, bookId: string, chapterId: string): string {
  return path.join(chapterCacheDir(source, bookId), `${sanitizeSegment(chapterId.replace(/\//g, '_'), 120)}.json`)
}

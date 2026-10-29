/**
 * 漫画落盘路径。
 */
import path from 'node:path'
import { getConfig } from '../core/config.ts'
import { homePath } from '../core/paths.ts'
import { renderTemplate, resolveInside } from '../core/template.ts'
import type { AlbumDetail, ChapterDetail } from './client.ts'

export function comicRoot(): string {
  const fromEnv = process.env.ASTRA_COMIC_DIR
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv)
  const configured = getConfig('comic.dir')
  if (configured) return configured
  return homePath('comic')
}

export function comicTemplate(): string {
  return getConfig('comic.template') || '{id} {title}/{chapter:02}/{page:03}.{ext}'
}

export function chapterDir(album: AlbumDetail, chapter: ChapterDetail): string {
  const firstImage = chapter.images[0] ?? '00001.jpg'
  const ext = path.extname(firstImage).replace(/^\./, '') || 'jpg'
  const relative = renderTemplate(comicTemplate(), {
    id: album.id,
    title: album.title,
    author: album.authors[0] ?? 'unknown',
    chapter: String(chapter.sort),
    chapter_title: chapter.title,
    page: '1',
    ext,
  })
  // 模板指向文件；章节目录是它的父目录
  const filePath = resolveInside(comicRoot(), relative)
  return path.dirname(filePath)
}

export function pageFile(album: AlbumDetail, chapter: ChapterDetail, pageIndex: number, imgName: string): string {
  const ext = (path.extname(imgName).split('?')[0] || '.jpg').replace(/^\./, '')
  const relative = renderTemplate(comicTemplate(), {
    id: album.id,
    title: album.title,
    author: album.authors[0] ?? 'unknown',
    chapter: String(chapter.sort),
    chapter_title: chapter.title,
    page: String(pageIndex + 1),
    ext,
  })
  return resolveInside(comicRoot(), relative)
}

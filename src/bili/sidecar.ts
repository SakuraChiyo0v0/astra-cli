/**
 * 视频的伴生文件：`.Metadata.nfo` / `.jpg` / `.Danmaku.ass`。
 *
 * 为什么需要：`bili get` 原来只给一个裸 mp4 —— 播放器里没有标题、没有简介、
 * 没有封面、没有弹幕，按剧集浏览时一片空白。Emby / Jellyfin / Kodi 都会
 * 自动刮削**同名**的这几份文件，所以只要跟视频放在一起、文件名一致就行。
 *
 * 命名沿用库里已有的那批（`视频/Bilibili/食贫道/` 那 59 套是别的工具留下的）：
 *
 *   《xxx》…​.mp4
 *   《xxx》…​.Metadata.nfo
 *   《xxx》…​.jpg
 *   《xxx》…​.Danmaku.ass
 *
 * 也就是**替换**最后一个扩展名：`a.mp4` → `a.Metadata.nfo` / `a.jpg` / `a.Danmaku.ass`。
 *
 * 这条我一开始写反了 —— 注释里理直气壮地写着"扩展名追加，不是替换"，
 * 于是产出 `暗香.mp3.jpg`。刮削器的规则是 `<stem>.<ext>`（同目录同名、不同扩展），
 * `暗香.mp3.jpg` 不会被当成 `暗香.mp3` 的封面，它是个孤儿文件。
 * 实测被 Hermes 抓出来。**注释写得太肯定，反而掩盖了错误。**
 *
 * 默认不生成（`bili.sidecar` 默认为空）：多数视频不需要弹幕，而弹幕要额外请求接口。
 */
import { writeFile } from 'node:fs/promises'
import { getConfig } from '../core/config.ts'
import { fetchDanmaku, danmakuToAss } from './danmaku.ts'
import type { VideoInfo, VideoPage } from './api.ts'
import type { SidecarKind } from './download.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

/** 配置 `bili.sidecar` 解析成列表。空字符串 = 全不生成。 */
export function sidecarKinds(raw: string | null | undefined): SidecarKind[] {
  if (!raw) return []
  const want = new Set(raw.split(/[,，\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))
  const all: SidecarKind[] = ['nfo', 'cover', 'danmaku']
  // `all` 是方便的写法；不认识的词直接忽略（配置里写错不该让下载失败）
  if (want.has('all')) return all
  return all.filter((k) => want.has(k))
}

/** 给视频路径算出伴生文件的路径：扩展名追加，不替换。 */
export function sidecarPath(videoPath: string, kind: SidecarKind): string {
  const suffix = kind === 'nfo' ? '.Metadata.nfo' : kind === 'cover' ? '.jpg' : '.Danmaku.ass'
  // **替换**最后一个扩展名，不是追加。
  //
  // Emby / Jellyfin / Kodi 的刮削规则是 `<stem>.<ext>`：同目录下同名、
  // 不同扩展名的文件才被认成同一条。`暗香.mp3.jpg` 不会被当成 `暗香.mp3` 的封面，
  // 它是个孤儿文件 —— 刮削器根本不去看它。
  //
  // 一开始我写成了追加（`${videoPath}${suffix}`），注释还理直气壮地写着
  // "扩展名追加，不是替换" —— 那条注释是**错的**，实测被 Hermes 抓出来。
  const stem = videoPath.replace(/\.[^.\\/]+$/, '')
  return `${stem}${suffix}`
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!)
}

function nfoRuntime(seconds: number): string {
  if (!seconds || seconds <= 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

/**
 * 生成 Kodi / Emby / Jellyfin 通用的 movie nfo。
 *
 * 字段都取 B 站**能给的原始值**，不推测：标题、简介（plot）、UP 主（director /
 * studio）、发布日期（premiered）、时长、封面、以及 `<uniqueid type="bvid">`。
 * 多分 P 时标题用分 P 名（播放器里那才是"这一集"的名字）。
 */
export function buildNfo(info: VideoInfo, page: VideoPage): string {
  const multi = info.pages.length > 1
  // 分 P 名和视频标题相同时不要拼成「绿色 - 绿色」——
  // B 站里单 P 视频的分 P 名经常就是视频标题本身
  const title = multi && page.part && page.part !== info.title ? `${info.title} - ${page.part}` : info.title
  const date = info.pubdate ? new Date(info.pubdate * 1000).toISOString().slice(0, 10) : ''
  const lines = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<movie>',
    `  <title>${escapeXml(title)}</title>`,
    multi ? `  <originaltitle>${escapeXml(info.title)}</originaltitle>` : '',
    `  <plot>${escapeXml(info.desc || '')}</plot>`,
    date ? `  <premiered>${date}</premiered>` : '',
    info.pubdate ? `  <year>${new Date(info.pubdate * 1000).getUTCFullYear()}</year>` : '',
    page.duration ? `  <runtime>${Math.round(page.duration / 60)}</runtime>` : '',
    page.duration ? `  <fileinfo><streamdetails><video><durationinseconds>${Math.round(page.duration)}</durationinseconds></video></streamdetails></fileinfo>` : '',
    info.owner.name ? `  <director>${escapeXml(info.owner.name)}</director>` : '',
    info.owner.name ? `  <studio>${escapeXml(info.owner.name)}</studio>` : '',
    info.owner.name ? `  <actor><name>${escapeXml(info.owner.name)}</name></actor>` : '',
    '  <genre>动画</genre>',
    info.pic ? `  <thumb aspect="poster">${escapeXml(info.pic)}</thumb>` : '',
    `  <uniqueid type="bvid" default="true">${escapeXml(info.bvid)}</uniqueid>`,
    `  <uniqueid type="cid">${page.cid}</uniqueid>`,
    `  <id>${escapeXml(info.bvid)}</id>`,
    '  <source>bilibili</source>',
    `  <website>https://www.bilibili.com/video/${escapeXml(info.bvid)}</website>`,
    '</movie>',
    '',
  ]
  return lines.filter((l) => l !== '').join('\n')
}

async function fetchCover(url: string, signal?: AbortSignal): Promise<Buffer | null> {
  try {
    const response = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, ...(signal ? { signal } : {}) })
    if (!response.ok) return null
    const data = Buffer.from(await response.arrayBuffer())
    return data.length > 0 && data.length < 16 * 1024 * 1024 ? data : null
  } catch {
    return null
  }
}

export interface SidecarResult {
  written: SidecarKind[]
  warnings: string[]
}

/**
 * 生成伴生文件。**任何一项失败都不算下载失败** —— 视频已经下好了，
 * 少一张图不该让整条任务变红，但要如实说一句。
 */
export async function writeSidecars(
  videoPath: string,
  info: VideoInfo,
  page: VideoPage,
  kinds: SidecarKind[],
  signal?: AbortSignal,
): Promise<SidecarResult> {
  const written: SidecarKind[] = []
  const warnings: string[] = []
  if (kinds.length === 0) return { written, warnings }

  for (const kind of kinds) {
    const dest = sidecarPath(videoPath, kind)
    try {
      if (kind === 'nfo') {
        await writeFile(dest, buildNfo(info, page), 'utf8')
        written.push(kind)
      } else if (kind === 'cover') {
        if (!info.pic) {
          warnings.push('没有封面地址，跳过 .jpg')
          continue
        }
        const data = await fetchCover(info.pic, signal)
        if (!data) {
          warnings.push('封面下载失败，跳过 .jpg')
          continue
        }
        await writeFile(dest, data)
        written.push(kind)
      } else {
        const items = await fetchDanmaku(page.cid, { signal })
        if (items.length === 0) {
          warnings.push(`P${page.page} 没有弹幕，跳过 .Danmaku.ass`)
          continue
        }
        // 视频宽高在下载前还不知道（DASH 里才有），弹幕画布按 1920x1080 给，
        // 播放器多数按视频尺寸缩放，不影响可读性。
        await writeFile(dest, danmakuToAss(items, { width: 1920, height: 1080 }), 'utf8')
        written.push(kind)
      }
    } catch (err) {
      warnings.push(`${kind} 生成失败：${(err as Error).message.slice(0, 120)}`)
    }
  }
  return { written, warnings }
}

/** 配置里要求的伴生文件；命令行给了就优先用命令行的。 */
export function resolveSidecars(fromOption: SidecarKind[] | undefined): SidecarKind[] {
  return fromOption ?? sidecarKinds(getConfig('bili.sidecar'))
}

/**
 * `astra comic ...`：按车号 / 关键词找漫画并下载到本地。
 *
 * 纯 TypeScript 实现移动端 API，不依赖本机其它下载容器。
 */
import { AstraError, invalidInput } from '../core/errors.ts'
import type { Command } from '../core/command.ts'
import { checkWritable } from '../core/doctor.ts'
import { getConfig } from '../core/config.ts'
import { mkdirSync } from 'node:fs'
import { comicClient } from './client.ts'
import { downloadAlbum } from './download.ts'
import { comicRoot } from './paths.ts'
import { parseComicTarget } from './target.ts'
import { ffmpegPath, runBinary } from '../media/run.ts'

function albumView(album: Awaited<ReturnType<ReturnType<typeof comicClient>['getAlbum']>>) {
  return {
    id: album.id,
    title: album.title,
    authors: album.authors,
    tags: album.tags,
    description: album.description,
    pageCount: album.pageCount,
    pubDate: album.pubDate,
    episodes: album.episodes.map((e) => ({ id: e.id, sort: e.sort, title: e.title })),
  }
}

const get: Command = {
  name: 'comic get',
  summary: '下载一本漫画：车号、JM 号或链接都行',
  usage: 'astra comic get <车号|链接> [--chapter <n>] [--force] [--concurrency 3]',
  notes: [
    'data.status：downloaded / already_have',
    '多话本默认全下；只要某一话加 `--chapter 3`',
    '落盘目录看 `comic.dir` / `ASTRA_COMIC_DIR`，模板看 `comic.template`',
    '解混淆需要 ffmpeg（和 B 站共用 `music.ffmpeg`）',
  ],
  options: {
    chapter: { type: 'string', description: '只下一话（从 1 开始的 sort）', valueName: 'n' },
    force: { type: 'boolean', description: '已有也重新下' },
    concurrency: { type: 'string', description: '单话内图片并发 1..6，默认 3', valueName: 'n' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const target = parseComicTarget(positionals[0]!)
    let chapter: number | 'all' = 'all'
    if (typeof values.chapter === 'string') {
      const n = Number(values.chapter)
      if (!Number.isInteger(n) || n < 1) throw invalidInput('--chapter 必须是从 1 开始的整数')
      chapter = n
    }
    const concurrency = Math.max(1, Math.min(6, Number(values.concurrency ?? '3') || 3))

    // /photo/ 链接：解析成所属本子，并只下这一话（除非用户另指定了 --chapter）
    let albumId = target.id
    if (target.kind === 'photo') {
      const ch = await comicClient().getChapter(target.id, undefined, signal)
      albumId = ch.albumId
      if (chapter === 'all') chapter = ch.sort
    }

    const result = await downloadAlbum(albumId, {
      force: values.force === true,
      chapter,
      concurrency,
      signal,
    })
    return { data: result }
  },
}

const info: Command = {
  name: 'comic info',
  summary: '看漫画信息与章节列表，不下载',
  usage: 'astra comic info <车号|链接>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, signal }) {
    const target = parseComicTarget(positionals[0]!)
    const client = comicClient()
    const albumId = target.kind === 'photo' ? (await client.getChapter(target.id, undefined, signal)).albumId : target.id
    const album = await client.getAlbum(albumId, signal)
    return { data: albumView(album) }
  },
}

const search: Command = {
  name: 'comic search',
  summary: '按关键词搜漫画',
  usage: 'astra comic search <关键词> [--page 1] [--limit 20]',
  notes: [
    '搜到车号会直接 redirect 到那一本',
    '拿不准时把 items 列给用户，让用户选 id 再 `comic get <id>`',
  ],
  options: {
    page: { type: 'string', description: '页码，从 1 开始', valueName: 'n' },
    limit: { type: 'string', description: '最多返回几条，默认 20', valueName: 'n' },
  },
  minArgs: 1,
  async run({ positionals, values, signal }) {
    const query = positionals.join(' ').trim()
    if (!query) throw invalidInput('缺少关键词')
    const page = Math.max(1, Number(values.page ?? '1') || 1)
    const limit = Math.max(1, Math.min(80, Number(values.limit ?? '20') || 20))
    const result = await comicClient().search(query, page, signal)
    return {
      data: {
        query: result.query,
        total: result.total,
        page: result.page,
        redirectId: result.redirectId,
        items: result.items.slice(0, limit),
        next: result.redirectId
          ? `可直接 \`astra comic get ${result.redirectId}\``
          : '让用户从 items 里选一个 id，再 `astra comic get <id>`',
      },
      table: {
        headers: ['id', 'title', 'author'],
        rows: result.items.slice(0, limit).map((i) => [i.id, i.title, i.author || null]),
      },
    }
  },
}

const doctor: Command = {
  name: 'comic doctor',
  summary: '漫画能力自检：目录、ffmpeg、上游连通',
  usage: 'astra comic doctor',
  maxArgs: 0,
  async run({ signal }) {
    const checks: { name: string; ok: boolean; detail: string }[] = []
    const root = comicRoot()
    try {
      mkdirSync(root, { recursive: true })
      const write = checkWritable(root)
      checks.push({ name: 'comic_dir', ok: write.ok, detail: write.detail })
    } catch (err) {
      checks.push({ name: 'comic_dir', ok: false, detail: (err as Error).message.slice(0, 120) })
    }

    const ffmpegConfigured = getConfig('music.ffmpeg')
    const bin = ffmpegPath(ffmpegConfigured)
    try {
      const result = await runBinary(bin, ['-version'], undefined, 10_000)
      checks.push({
        name: 'ffmpeg',
        ok: result.code === 0,
        detail: result.code === 0 ? (result.stdout.split('\n')[0] ?? bin).slice(0, 80) : 'ffmpeg 不可用',
      })
    } catch (err) {
      checks.push({ name: 'ffmpeg', ok: false, detail: (err as Error).message.slice(0, 120) })
    }

    try {
      await comicClient().ensure()
      // 用 setting 已经打通过；再探一次搜索空词会失败，改探一个已知可能存在的接口形状
      const probe = await comicClient().search('1', 1, signal)
      checks.push({
        name: 'api',
        ok: true,
        detail: `接口可达（search total=${probe.total}${probe.redirectId ? `, redirect=${probe.redirectId}` : ''}）`,
      })
    } catch (err) {
      checks.push({
        name: 'api',
        ok: false,
        detail: err instanceof AstraError ? err.message : (err as Error).message.slice(0, 120),
      })
    }

    return {
      data: { ok: checks.every((c) => c.ok), dir: root, checks },
      warnings: checks.filter((c) => !c.ok).map((c) => `${c.name}：${c.detail}`),
    }
  },
}

export const comicCommands: Command[] = [get, info, search, doctor]

/**
 * `astra manga ...`：按作品名找漫画，按话 / 卷下到 NAS。
 *
 * 源在 `sources/`；这里只做参数、候选与任务编排。本子类在 `astra comic`（JM），两边不混。
 */
import { mkdirSync } from 'node:fs'
import type { Command } from '../core/command.ts'
import { checkWritable } from '../core/doctor.ts'
import { AstraError, invalidInput } from '../core/errors.ts'
import { cancelJob, createJob, getJob, listJobs, resumeJob, runWorker, spawnWorker, statusLabel, type JobView } from '../core/jobs.ts'
import { MANGA_DOMAIN, type ChapterItemMeta, type ComicJobMeta } from './jobs.ts'
import { chapterDirName, comicDir, mangaRoot } from './paths.ts'
import { resolveComic, searchAll, sourceByName, SOURCES } from './registry.ts'
import type { ComicInfo, Group } from './sources/types.ts'

const SOURCE_NAMES = SOURCES.map((s) => s.name).join(' / ')

function pickOption(raw: unknown): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw invalidInput('--pick 必须是从 1 开始的序号')
  return n
}

/** `1-3,5` → 从 0 开始的下标；越界的忽略，一个都不剩就报错。 */
export function parseRange(spec: string | undefined, total: number): number[] {
  if (!spec) return Array.from({ length: total }, (_, i) => i)
  const out = new Set<number>()
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) throw invalidInput(`--range 写法不对：${part}`, '例：1-3,5（从 1 开始）')
    const lo = Number(m[1])
    const hi = Number(m[2] ?? m[1])
    for (let i = lo; i <= hi; i += 1) if (i >= 1 && i <= total) out.add(i - 1)
  }
  if (out.size === 0) throw invalidInput(`--range ${spec} 不在 1-${total} 之内`)
  return [...out].sort((a, b) => a - b)
}

export function pickGroup(comic: ComicInfo, name: string | undefined): Group {
  if (comic.groups.length === 0) throw new AstraError('NOT_FOUND', `《${comic.title}》没有可下的章节`, { exitCode: 4 })
  if (!name) return comic.groups[0]!
  const group = comic.groups.find((g) => g.name === name)
  if (!group) throw invalidInput(`没有分组「${name}」`, `可选：${comic.groups.map((g) => g.name).join(' / ')}`)
  return group
}

function groupsView(comic: ComicInfo): Record<string, unknown>[] {
  return comic.groups.map((g) => ({
    name: g.name,
    volumes: g.volumes,
    count: g.chapters.length,
    pages: g.chapters.reduce((n, c) => n + (c.pages ?? 0), 0),
    first: g.chapters.slice(0, 3).map((c) => c.name),
    last: g.chapters.slice(-3).map((c) => c.name),
  }))
}

function jobView(job: JobView): Record<string, unknown> {
  return {
    id: job.id, kind: job.kind, title: job.title, status: job.status, statusLabel: statusLabel(job.status),
    total: job.total, done: job.done, skipped: job.skipped, failed: job.failed, error: job.error,
    output: (job.meta?.output ?? null) as Record<string, unknown> | null,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
  }
}

async function waitJob(id: string, seconds: number, signal: AbortSignal): Promise<JobView> {
  const deadline = Date.now() + seconds * 1000
  let snapshot = getJob(id, false, MANGA_DOMAIN).job
  while (Date.now() < deadline && !signal.aborted && ['queued', 'running'].includes(snapshot.status)) {
    await new Promise((r) => setTimeout(r, 2000))
    snapshot = getJob(id, false, MANGA_DOMAIN).job
  }
  return snapshot
}

const resolveOpts = (values: Record<string, unknown>, signal: AbortSignal): { source?: string; pick?: number; signal: AbortSignal } => ({
  ...(typeof values.source === 'string' ? { source: values.source } : {}),
  ...(pickOption(values.pick) !== undefined ? { pick: pickOption(values.pick)! } : {}),
  signal,
})

const search: Command = {
  name: 'manga search',
  summary: '按作品名搜漫画（各源一起搜）',
  usage: `astra manga search <作品名> [--source ${SOURCE_NAMES}] [--limit 20]`,
  notes: [
    '排序：完全同名 > 以关键词开头 > 包含；繁简体互通',
    '把 items 列给用户选，再 `astra manga get <作品名> --pick <n>` 或直接给链接',
    '本子类（JM 车号）在 `astra comic`，不在这里',
  ],
  options: {
    source: { type: 'string', description: `只搜一个源：${SOURCE_NAMES}`, valueName: 'name' },
    limit: { type: 'string', description: '最多返回几条，默认 20', valueName: 'n' },
  },
  minArgs: 1,
  async run({ positionals, values, signal }) {
    const keyword = positionals.join(' ').trim()
    const only = typeof values.source === 'string' ? sourceByName(values.source) : undefined
    const limit = Math.max(1, Math.min(100, Number(values.limit ?? '20') || 20))
    const { hits, perSource } = await searchAll(keyword, only, signal)
    const items = hits.slice(0, limit).map((h, i) => ({ n: i + 1, source: h.source, id: h.id, title: h.title, author: h.author }))
    return {
      data: { query: keyword, total: hits.length, perSource, items },
      table: { headers: ['n', 'source', 'title', 'author'], rows: items.map((i) => [i.n, i.source, i.title, i.author]) },
    }
  },
}

const info: Command = {
  name: 'manga info',
  summary: '看一部漫画的分组（单行本 / 单话 / 连载…）与章节，不下载',
  usage: 'astra manga info <作品名|链接> [--pick n] [--source s]',
  options: {
    pick: { type: 'string', description: '有多个候选时选第几个', valueName: 'n' },
    source: { type: 'string', description: `只在一个源里找：${SOURCE_NAMES}`, valueName: 'name' },
  },
  minArgs: 1,
  async run({ positionals, values, signal }) {
    const ref = await resolveComic(positionals.join(' '), resolveOpts(values, signal))
    const comic = await ref.source.comic(ref.id, signal)
    return {
      data: {
        source: ref.source.name, id: comic.id, title: comic.title, author: comic.author, status: comic.status,
        tags: comic.tags, url: comic.url, cover: comic.cover, groups: groupsView(comic),
        next: `\`astra manga get <链接> --group ${comic.groups[0]?.name ?? '<分组>'} [--range 1-3]\``,
      },
    }
  },
}

const get: Command = {
  name: 'manga get',
  summary: '下载漫画（后台任务）：一话 / 一卷一个目录，可选打 CBZ',
  usage: 'astra manga get <作品名|链接> [--group 单行本] [--range 1-3,5] [--pick n] [--source s] [--cbz] [--wait 300]',
  notes: [
    '作品名只在「完全同名」时自动选（多个源都有就取 komiic 优先）；否则报 AMBIGUOUS，details.candidates 是候选',
    '--group 不给就取第一个分组（拷贝漫画是单行本优先）；分组名看 `astra manga info`',
    '落盘 manga.dir / ASTRA_MANGA_DIR：<作品>/<分组>/<第01卷>/001.jpg；已下完整的页会跳过',
    'Komiic 匿名每天约 300 张；拷贝漫画请求太密会被限流约 1 小时。遇到时该项记失败、错误里写何时可以 resume',
    '立刻返回任务 id；`--wait 300` 等它跑完（最多 600 秒）',
  ],
  options: {
    group: { type: 'string', description: '分组名：单行本 / 单话 / 连载 …', valueName: 'name' },
    range: { type: 'string', description: '第几话 / 卷，从 1 开始：1-3,5', valueName: 'spec' },
    pick: { type: 'string', description: '有多个候选时选第几个', valueName: 'n' },
    source: { type: 'string', description: `只在一个源里找：${SOURCE_NAMES}`, valueName: 'name' },
    cbz: { type: 'boolean', description: '每话 / 卷下完再打一个 CBZ（原图目录保留）' },
    wait: { type: 'string', description: '等任务结束的最长秒数（≤600）', valueName: 's' },
  },
  minArgs: 1,
  async run({ positionals, values, signal }) {
    const ref = await resolveComic(positionals.join(' '), resolveOpts(values, signal))
    const comic = await ref.source.comic(ref.id, signal)
    const group = pickGroup(comic, typeof values.group === 'string' ? values.group : undefined)
    const picked = parseRange(typeof values.range === 'string' ? values.range : undefined, group.chapters.length).map((i) => group.chapters[i]!)
    const cbz = values.cbz === true
    const meta: ComicJobMeta = { source: ref.source.name, comicId: comic.id, title: comic.title, group: group.name, cbz }
    const job = createJob({
      domain: MANGA_DOMAIN,
      kind: 'comic',
      title: `《${comic.title}》${group.name}`,
      items: picked.map((c) => {
        const dir = chapterDirName(group, c)
        const m: ChapterItemMeta = { source: ref.source.name, comicId: comic.id, title: comic.title, group: group.name, dir, name: c.name, pages: c.pages, cbz }
        return { id: c.id, title: dir, meta: { ...m } }
      }),
      meta: { ...meta },
    })
    spawnWorker(MANGA_DOMAIN, job.id)
    const waitSeconds = Math.min(600, Math.max(0, Number(values.wait ?? '0') || 0))
    const final = waitSeconds > 0 ? await waitJob(job.id, waitSeconds, signal) : job
    return {
      data: {
        job: jobView(final),
        comic: { source: ref.source.name, id: comic.id, title: comic.title, group: group.name, chapters: picked.length, pages: picked.reduce((n, c) => n + (c.pages ?? 0), 0) },
        dir: comicDir(comic.title),
        next: ['done', 'partial', 'failed'].includes(final.status) ? null : `\`astra manga job ${job.id} --wait 300\` 等它跑完`,
      },
    }
  },
}

const jobCmd: Command = {
  name: 'manga job',
  summary: '看漫画任务进度',
  usage: 'astra manga job <id> [--failed] [--wait 60]',
  options: {
    failed: { type: 'boolean', description: '列出失败的话 / 卷' },
    wait: { type: 'string', description: '最多等待秒数（≤600）', valueName: 's' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const id = positionals[0]!
    const seconds = Math.min(600, Math.max(0, Number(values.wait ?? '0') || 0))
    if (seconds > 0) await waitJob(id, seconds, signal)
    const full = getJob(id, true, MANGA_DOMAIN)
    const failed = (full.items ?? []).filter((i) => i.status === 'failed')
    return {
      data: {
        ...jobView(full.job),
        ...(values.failed === true ? { failedItems: failed.map((i) => ({ seq: i.seq, title: i.title, error: i.error })) } : {}),
      },
      warnings: failed.length > 0 && values.failed !== true
        ? [`${failed.length} 项失败（${failed[0]!.error?.slice(0, 80) ?? ''}），\`astra manga job resume ${full.job.id}\` 只补缺的页`]
        : [],
    }
  },
}

const jobsCmd: Command = {
  name: 'manga jobs',
  summary: '最近的漫画任务',
  usage: 'astra manga jobs [--active] [--limit 20]',
  options: {
    active: { type: 'boolean', description: '只看还在跑的' },
    limit: { type: 'string', description: '条数，默认 20', valueName: 'n' },
  },
  maxArgs: 0,
  async run({ values }) {
    const limit = Math.max(1, Math.min(200, Number(values.limit ?? '20') || 20))
    return { data: { jobs: listJobs(limit, values.active === true, MANGA_DOMAIN).map(jobView) } }
  },
}

const jobCancel: Command = {
  name: 'manga job cancel',
  summary: '取消漫画任务（已下的页不动）',
  usage: 'astra manga job cancel <id>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    return { data: jobView(cancelJob(positionals[0]!, MANGA_DOMAIN)) }
  },
}

const jobResume: Command = {
  name: 'manga job resume',
  summary: '重试漫画任务里失败 / 没跑完的话，只补缺的页',
  usage: 'astra manga job resume <id>',
  notes: ['额度 / 限流失败时，错误里写了大约几点可以 resume；早了会再失败一次，不会重下已有的页'],
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    return { data: jobView(resumeJob(positionals[0]!, MANGA_DOMAIN)) }
  },
}

const worker: Command = {
  name: 'manga _worker',
  summary: '（内部）漫画任务执行体',
  usage: 'astra manga _worker <id>',
  hidden: true,
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    await runWorker(MANGA_DOMAIN, positionals[0]!)
    return { data: jobView(getJob(positionals[0]!, false, MANGA_DOMAIN).job) }
  },
}

const doctor: Command = {
  name: 'manga doctor',
  summary: '漫画能力自检：目录、各源连通与额度',
  usage: 'astra manga doctor',
  maxArgs: 0,
  async run({ signal }) {
    const checks: { name: string; ok: boolean; detail: string }[] = []
    const root = mangaRoot()
    try {
      mkdirSync(root, { recursive: true })
      const w = checkWritable(root)
      checks.push({ name: 'manga_dir', ok: w.ok, detail: `${root}：${w.detail}` })
    } catch (err) {
      checks.push({ name: 'manga_dir', ok: false, detail: `${root}：${(err as Error).message.slice(0, 120)}` })
    }
    for (const source of SOURCES) {
      try {
        checks.push({ name: `source:${source.name}`, ok: true, detail: await source.probe(signal) })
      } catch (err) {
        checks.push({ name: `source:${source.name}`, ok: false, detail: (err as Error).message.slice(0, 120) })
      }
    }
    return { data: { ok: checks.every((c) => c.ok), dir: root, checks }, warnings: checks.filter((c) => !c.ok).map((c) => `${c.name}：${c.detail}`) }
  },
}

export const mangaCommands: Command[] = [search, info, get, jobCmd, jobsCmd, jobCancel, jobResume, worker, doctor]

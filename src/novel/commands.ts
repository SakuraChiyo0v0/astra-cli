/**
 * `astra novel ...`：按书名找书，抓成 EPUB 落到 NAS，可追更连载。
 *
 * 书源在 `sources/`；这里只做参数、候选与任务编排。
 */
import { existsSync, mkdirSync } from 'node:fs'
import type { Command } from '../core/command.ts'
import { checkWritable } from '../core/doctor.ts'
import { AstraError, invalidInput } from '../core/errors.ts'
import { cancelJob, createJob, getJob, listJobs, resumeJob, runWorker, spawnWorker, statusLabel, type JobView } from '../core/jobs.ts'
import { notify } from '../core/notify.ts'
import { getConfig } from '../core/config.ts'
import { ffmpegPath, runBinary } from '../media/run.ts'
import { NOVEL_DOMAIN, type BookJobMeta, type ChapterItemMeta } from './jobs.ts'
import { epubPath, novelRoot } from './paths.ts'
import { describeVolumes, makePlan, parseVolumeOption } from './plan.ts'
import { displaySource, resolveBook, searchAll, sourceByName, sourceId, SOURCES } from './registry.ts'
import { INDEX_TTL_MS, indexPages, loadIndex } from './sources/kanunu.ts'
import {
  addNovelSubscription, dueNovelSubscriptions, findNovelSubscription, listNovelSubscriptions,
  removeNovelSubscription, runNovelSubscription, type NovelSubscription,
} from './subscribe.ts'
import { toSimplified } from './text.ts'

const SOURCE_NAMES = SOURCES.map((s) => s.name).join(' / ')

function pickOption(raw: unknown): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw invalidInput('--pick 必须是从 1 开始的序号')
  return n
}

function indexWarnings(): string[] {
  const index = loadIndex()
  if (!index) return ['努努书坊的书名索引还没建，出版读物可能搜不到：`astra novel index --rebuild`（后台，约 10 分钟）']
  if (Date.now() - Date.parse(index.builtAt) > INDEX_TTL_MS) return [`努努书坊索引是 ${index.builtAt.slice(0, 10)} 建的，可以 \`astra novel index --rebuild\` 刷新`]
  return []
}

function jobView(job: JobView): Record<string, unknown> {
  const output = (job.meta?.output ?? null) as Record<string, unknown> | null
  return {
    id: job.id,
    kind: job.kind,
    title: job.title,
    status: job.status,
    statusLabel: statusLabel(job.status),
    total: job.total,
    done: job.done,
    skipped: job.skipped,
    failed: job.failed,
    error: job.error,
    output,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

async function waitJob(id: string, seconds: number, signal: AbortSignal): Promise<JobView> {
  const deadline = Date.now() + seconds * 1000
  let snapshot = getJob(id, false, NOVEL_DOMAIN).job
  while (Date.now() < deadline && !signal.aborted && ['queued', 'running'].includes(snapshot.status)) {
    await new Promise((r) => setTimeout(r, 2000))
    snapshot = getJob(id, false, NOVEL_DOMAIN).job
  }
  return snapshot
}

const search: Command = {
  name: 'novel search',
  summary: '按书名搜小说（三个书源一起搜）',
  usage: `astra novel search <书名> [--source ${SOURCE_NAMES}] [--limit 20]`,
  notes: [
    '排序：书名完全一致 > 以关键词开头 > 包含；繁简体互通（「活著」能搜到「活着」）',
    '8novel / lnovel 是日轻（繁体），kanunu（努努书坊）是出版读物（简体，靠本地索引）',
    'lnovel 不支持搜索，要给书号或链接',
    '把 items 列给用户选，再 `astra novel get <书名> --pick <n>` 或直接给链接',
  ],
  options: {
    source: { type: 'string', description: `只搜一个书源：${SOURCE_NAMES}`, valueName: 'name' },
    limit: { type: 'string', description: '最多返回几条，默认 20', valueName: 'n' },
  },
  minArgs: 1,
  async run({ positionals, values, signal }) {
    const keyword = positionals.join(' ').trim()
    const only = typeof values.source === 'string' ? sourceByName(values.source) : undefined
    const limit = Math.max(1, Math.min(100, Number(values.limit ?? '20') || 20))
    const { hits, perSource } = await searchAll(keyword, only, signal)
    const items = hits.slice(0, limit).map((h, i) => ({ n: i + 1, source: displaySource(h.source), id: h.id, title: h.title, author: h.author }))
    return {
      data: { query: keyword, total: hits.length, perSource, items },
      warnings: !only || sourceId(only) === 'kanunu' ? indexWarnings() : [],
      table: { headers: ['n', 'source', 'title', 'author'], rows: items.map((i) => [i.n, i.source, i.title, i.author]) },
    }
  },
}

const info: Command = {
  name: 'novel info',
  summary: '看一本书的信息与分卷，不下载',
  usage: 'astra novel info <书名|链接> [--pick n] [--source s]',
  options: {
    pick: { type: 'string', description: '书名有多个候选时选第几个', valueName: 'n' },
    source: { type: 'string', description: `只在一个书源里找：${SOURCE_NAMES}`, valueName: 'name' },
  },
  minArgs: 1,
  async run({ positionals, values, signal }) {
    const ref = await resolveBook(positionals.join(' '), {
      ...(typeof values.source === 'string' ? { source: values.source } : {}),
      ...(pickOption(values.pick) !== undefined ? { pick: pickOption(values.pick)! } : {}),
      signal,
    })
    const book = await ref.source.book(ref.id, signal)
    return {
      data: {
        source: ref.source.name,
        id: book.id,
        title: book.title,
        author: book.author,
        url: book.url,
        cover: book.cover,
        language: ref.source.language,
        chapters: book.volumes.reduce((n, v) => n + v.chapters.length, 0),
        volumes: describeVolumes(book),
        next: book.volumes.length > 1 && ref.source.volumesAreBooks
          ? '多卷：`astra novel get <链接> --volume <n>`，或 `--volume all` 合成一本'
          : '`astra novel get <链接>`',
      },
    }
  },
}

const get: Command = {
  name: 'novel get',
  summary: '下载一本小说成 EPUB（后台任务）',
  usage: 'astra novel get <书名|链接|lnovel 书号> [--pick n] [--volume n|all] [--source s] [--simplified] [--no-images] [--wait 300]',
  notes: [
    '书名只在「完全同名且只有一条」时自动选；否则报 AMBIGUOUS，details.candidates 是候选，选好后加 --pick',
    '日轻每卷单独成书：多卷不给 --volume 会报 AMBIGUOUS_VOLUME，details.volumes 是卷列表',
    '立刻返回任务 id；`--wait 300` 等它跑完（最多 600 秒）。进度：`astra novel job <id>`',
    '章节先进本地缓存，中断后 `astra novel job resume <id>` 只补缺的章；全部到齐才出书',
    '--simplified：书名、章节名、正文整本繁转简（逐字 + 常用词组，个别多义字可能转错）',
    '落盘 novel.dir / ASTRA_NOVEL_DIR，模板 novel.template；完成后登记进资产库（`astra lib find`）',
  ],
  options: {
    pick: { type: 'string', description: '书名有多个候选时选第几个', valueName: 'n' },
    volume: { type: 'string', description: '只出第 n 卷；all = 全部卷合成一本', valueName: 'n|all' },
    source: { type: 'string', description: `只在一个书源里找：${SOURCE_NAMES}`, valueName: 'name' },
    simplified: { type: 'boolean', description: '整本繁转简' },
    'no-images': { type: 'boolean', description: '不要插图' },
    wait: { type: 'string', description: '等任务结束的最长秒数（≤600）', valueName: 's' },
  },
  minArgs: 1,
  async run({ positionals, values, signal }) {
    const ref = await resolveBook(positionals.join(' '), {
      ...(typeof values.source === 'string' ? { source: values.source } : {}),
      ...(pickOption(values.pick) !== undefined ? { pick: pickOption(values.pick)! } : {}),
      signal,
    })
    const book = await ref.source.book(ref.id, signal)
    const plan = makePlan(book, parseVolumeOption(typeof values.volume === 'string' ? values.volume : undefined), ref.source.volumesAreBooks)
    const key = sourceId(ref.source)
    const simplified = values.simplified === true
    const images = values['no-images'] !== true
    const target = epubPath({ title: simplified ? toSimplified(plan.title) : plan.title, author: book.author, source: key })
    const overwrite = existsSync(target)
    const meta: BookJobMeta = { source: key, bookId: book.id, plan, simplified, images }
    const job = createJob({
      domain: NOVEL_DOMAIN,
      kind: 'book',
      title: `《${simplified ? toSimplified(plan.title) : plan.title}》`,
      items: plan.chapters.map((c) => {
        const m: ChapterItemMeta = { source: key, bookId: book.id, title: c.title, images }
        return { id: c.id, title: c.title, meta: { ...m } }
      }),
      meta: { ...meta },
    })
    spawnWorker(NOVEL_DOMAIN, job.id)
    const waitSeconds = Math.min(600, Math.max(0, Number(values.wait ?? '0') || 0))
    const final = waitSeconds > 0 ? await waitJob(job.id, waitSeconds, signal) : job
    return {
      data: {
        job: jobView(final),
        book: { source: ref.source.name, id: book.id, title: plan.title, author: book.author, chapters: plan.chapters.length },
        path: target,
        overwrite,
        next: ['done', 'partial', 'failed'].includes(final.status) ? null : `\`astra novel job ${job.id} --wait 300\` 等它跑完`,
      },
    }
  },
}

const jobCmd: Command = {
  name: 'novel job',
  summary: '看小说任务进度与产物',
  usage: 'astra novel job <id> [--failed] [--wait 60]',
  options: {
    failed: { type: 'boolean', description: '列出失败的章' },
    wait: { type: 'string', description: '最多等待秒数（≤600）', valueName: 's' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const id = positionals[0]!
    const seconds = Math.min(600, Math.max(0, Number(values.wait ?? '0') || 0))
    if (seconds > 0) await waitJob(id, seconds, signal)
    const full = getJob(id, true, NOVEL_DOMAIN)
    const failed = (full.items ?? []).filter((i) => i.status === 'failed')
    return {
      data: {
        ...jobView(full.job),
        ...(values.failed === true ? { failedItems: failed.map((i) => ({ seq: i.seq, title: i.title, error: i.error })) } : {}),
      },
      warnings: failed.length > 0 && values.failed !== true
        ? [`${failed.length} ${full.job.kind === 'index' ? '页' : '章'}失败，加 --failed 看原因，\`astra novel job resume ${full.job.id}\` 重试`]
        : [],
    }
  },
}

const jobsCmd: Command = {
  name: 'novel jobs',
  summary: '最近的小说任务',
  usage: 'astra novel jobs [--active] [--limit 20]',
  options: {
    active: { type: 'boolean', description: '只看还在跑的' },
    limit: { type: 'string', description: '条数，默认 20', valueName: 'n' },
  },
  maxArgs: 0,
  async run({ values }) {
    const limit = Math.max(1, Math.min(200, Number(values.limit ?? '20') || 20))
    return { data: { jobs: listJobs(limit, values.active === true, NOVEL_DOMAIN).map(jobView) } }
  },
}

const jobCancel: Command = {
  name: 'novel job cancel',
  summary: '取消小说任务',
  usage: 'astra novel job cancel <id>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    return { data: jobView(cancelJob(positionals[0]!, NOVEL_DOMAIN)) }
  },
}

const jobResume: Command = {
  name: 'novel job resume',
  summary: '重试小说任务里失败 / 没跑完的章，补齐后自动出书',
  usage: 'astra novel job resume <id>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    return { data: jobView(resumeJob(positionals[0]!, NOVEL_DOMAIN)) }
  },
}

const worker: Command = {
  name: 'novel _worker',
  summary: '（内部）小说任务执行体',
  usage: 'astra novel _worker <id>',
  hidden: true,
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    await runWorker(NOVEL_DOMAIN, positionals[0]!)
    return { data: jobView(getJob(positionals[0]!, false, NOVEL_DOMAIN).job) }
  },
}

const indexCmd: Command = {
  name: 'novel index',
  summary: '努努书坊书名索引：看状态，或后台重建',
  usage: 'astra novel index [--rebuild]',
  notes: [
    '努努书坊没有站内搜索，按书名找书全靠这份索引（分类页 + 专题 + 约 1,800 个作家页）',
    '--rebuild 开后台任务，约 10 分钟；失败页超过 1/5 时不覆盖旧索引',
  ],
  options: { rebuild: { type: 'boolean', description: '重建（后台任务）' } },
  maxArgs: 0,
  async run({ values, signal }) {
    const index = loadIndex()
    const status = index
      ? { books: index.books.length, pages: index.pages, builtAt: index.builtAt, stale: Date.now() - Date.parse(index.builtAt) > INDEX_TTL_MS }
      : null
    if (values.rebuild !== true) return { data: { index: status, next: status ? null : '`astra novel index --rebuild`' } }
    const running = listJobs(50, true, NOVEL_DOMAIN).find((j) => j.kind === 'index')
    if (running) throw new AstraError('JOB_RUNNING', `已经在重建了：${running.id}`, { exitCode: 2, hint: `\`astra novel job ${running.id}\`` })
    const pages = await indexPages(signal)
    const job = createJob({
      domain: NOVEL_DOMAIN,
      kind: 'index',
      title: '努努书坊书名索引',
      items: pages.map((p) => ({ id: p.path, title: p.author ?? p.path, meta: { kind: 'index-page', path: p.path, author: p.author } })),
    })
    spawnWorker(NOVEL_DOMAIN, job.id)
    return { data: { index: status, job: jobView(job), next: `\`astra novel job ${job.id} --wait 600\`` } }
  },
}

function subView(s: NovelSubscription): Record<string, unknown> {
  return {
    id: s.id,
    source: displaySource(s.source),
    bookId: s.bookId,
    title: s.title,
    everyHours: s.everyHours,
    enabled: s.enabled,
    chapters: s.seen.length,
    options: s.options,
    lastCheckedAt: s.lastCheckedAt,
    lastJobId: s.lastJobId,
  }
}

const subAdd: Command = {
  name: 'novel subscribe add',
  summary: '追更一本连载：有新章节就重出 EPUB',
  usage: 'astra novel subscribe add <书名|链接> [--pick n] [--volume n] [--every 12] [--simplified] [--no-images]',
  notes: [
    '建订阅时把当前章节记为基线，第一次检查不会重下',
    '要定时检查：`astra schedule add novel-sub --every 12h --cmd "novel subscribe run --notify"`',
  ],
  options: {
    pick: { type: 'string', description: '书名有多个候选时选第几个', valueName: 'n' },
    volume: { type: 'string', description: '盯哪一卷（日轻多卷时必填）', valueName: 'n' },
    source: { type: 'string', description: `只在一个书源里找：${SOURCE_NAMES}`, valueName: 'name' },
    every: { type: 'string', description: '检查间隔（小时），默认 12', valueName: 'h' },
    simplified: { type: 'boolean', description: '出书时繁转简' },
    'no-images': { type: 'boolean', description: '不要插图' },
  },
  minArgs: 1,
  async run({ positionals, values, signal }) {
    const ref = await resolveBook(positionals.join(' '), {
      ...(typeof values.source === 'string' ? { source: values.source } : {}),
      ...(pickOption(values.pick) !== undefined ? { pick: pickOption(values.pick)! } : {}),
      signal,
    })
    const volume = parseVolumeOption(typeof values.volume === 'string' ? values.volume : undefined)
    if (volume === 'all') throw invalidInput('订阅只能盯一卷或整本不分卷的书', '日轻请给 `--volume <n>`')
    const everyHours = Number(values.every ?? '12')
    if (!Number.isInteger(everyHours) || everyHours < 1) throw invalidInput('--every 必须是 ≥1 的整数（小时）')
    const sub = await addNovelSubscription({
      source: sourceId(ref.source),
      bookId: ref.id,
      everyHours,
      options: { volume, simplified: values.simplified === true, images: values['no-images'] !== true },
    }, signal)
    return { data: subView(sub) }
  },
}

const subList: Command = {
  name: 'novel subscribe list',
  summary: '小说订阅列表',
  usage: 'astra novel subscribe list',
  maxArgs: 0,
  async run() {
    const subs = listNovelSubscriptions().map(subView)
    return { data: { subscriptions: subs }, table: { headers: ['id', 'title', 'chapters', 'every', 'enabled'], rows: subs.map((s) => [String(s.id), String(s.title), Number(s.chapters), Number(s.everyHours), s.enabled ? 'yes' : 'no']) } }
  },
}

const subRemove: Command = {
  name: 'novel subscribe remove',
  summary: '取消一条小说订阅（已出的 EPUB 不动）',
  usage: 'astra novel subscribe remove <id>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const sub = findNovelSubscription(positionals[0]!)
    return { data: { removed: removeNovelSubscription(sub.id), id: sub.id, title: sub.title } }
  },
}

const subRun: Command = {
  name: 'novel subscribe run',
  summary: '检查小说订阅有没有新章节（默认只查到点的）',
  usage: 'astra novel subscribe run [id] [--all] [--notify]',
  options: {
    all: { type: 'boolean', description: '不管间隔，全部检查' },
    notify: { type: 'boolean', description: '有新章节时发通知' },
  },
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const targets = positionals[0]
      ? [findNovelSubscription(positionals[0])]
      : values.all === true ? listNovelSubscriptions().filter((s) => s.enabled) : dueNovelSubscriptions()
    const results: Record<string, unknown>[] = []
    const warnings: string[] = []
    for (const sub of targets) {
      try {
        const r = await runNovelSubscription(sub.id, signal)
        results.push({ id: sub.id, title: sub.title, newCount: r.newCount, jobId: r.jobId, note: r.note })
      } catch (err) {
        warnings.push(`《${sub.title}》检查失败：${(err as Error).message.slice(0, 120)}`)
      }
    }
    const gained = results.filter((r) => Number(r.newCount) > 0)
    if (values.notify === true && gained.length > 0) {
      await notify(`【订阅更新】📖 小说新增章节：${gained.map((r) => `《${String(r.title)}》+${String(r.newCount)}`).join('，')}`)
    }
    return { data: { checked: results.length, results }, warnings }
  },
}

const doctor: Command = {
  name: 'novel doctor',
  summary: '小说能力自检：目录、ffmpeg、各书源连通、索引',
  usage: 'astra novel doctor',
  maxArgs: 0,
  async run({ signal }) {
    const checks: { name: string; ok: boolean; detail: string }[] = []
    const root = novelRoot()
    try {
      mkdirSync(root, { recursive: true })
      const w = checkWritable(root)
      checks.push({ name: 'novel_dir', ok: w.ok, detail: `${root}：${w.detail}` })
    } catch (err) {
      checks.push({ name: 'novel_dir', ok: false, detail: `${root}：${(err as Error).message.slice(0, 120)}` })
    }
    try {
      const r = await runBinary(ffmpegPath(getConfig('music.ffmpeg')), ['-version'], undefined, 10_000)
      checks.push({ name: 'ffmpeg', ok: r.code === 0, detail: r.code === 0 ? (r.stdout.split('\n')[0] ?? '').slice(0, 60) : '不可用（WebP 插图转不了，其它不受影响）' })
    } catch (err) {
      checks.push({ name: 'ffmpeg', ok: false, detail: (err as Error).message.slice(0, 120) })
    }
    for (const source of SOURCES) {
      try {
        checks.push({ name: `source:${source.name}`, ok: true, detail: await source.probe(signal) })
      } catch (err) {
        checks.push({ name: `source:${source.name}`, ok: false, detail: err instanceof AstraError ? err.message : (err as Error).message.slice(0, 120) })
      }
    }
    return {
      data: { ok: checks.every((c) => c.ok), dir: root, checks },
      warnings: [...checks.filter((c) => !c.ok).map((c) => `${c.name}：${c.detail}`), ...indexWarnings()],
    }
  },
}

export const novelCommands: Command[] = [search, info, get, jobCmd, jobsCmd, jobCancel, jobResume, worker, indexCmd, subAdd, subList, subRemove, subRun, doctor]

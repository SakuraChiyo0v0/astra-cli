/**
 * `astra jm ...`：按车号 / 关键词找漫画并下载到本地。
 *
 * 纯 TypeScript 实现移动端 API，不依赖本机其它下载容器。
 */
import { AstraError, invalidInput } from '../core/errors.ts'
import type { Command } from '../core/command.ts'
import { checkWritable } from '../core/doctor.ts'
import { getConfig } from '../core/config.ts'
import { mkdirSync } from 'node:fs'
import { jmClient, searchMainTag, type AlbumDetail, type SearchHit, type SearchScope } from './client.ts'
import { downloadAlbum } from './download.ts'
import { cancelJob, createJob, getJob, listJobs, resumeJob, runWorker, spawnWorker, statusLabel, type JobView } from '../core/jobs.ts'
import { chapterItems, JM_DOMAIN } from './jobs.ts'
import {
  addJmSubscription, dueJmSubscriptions, findJmSubscription, listJmSubscriptions,
  removeJmSubscription, runJmSubscription, setJmSubscription, type JmSubscription,
} from './subscribe.ts'
import { jmRoot } from './paths.ts'
import { parseJmTarget } from './target.ts'
import { ffmpegPath, runBinary } from '../core/ffmpeg.ts'

function albumView(album: Awaited<ReturnType<ReturnType<typeof jmClient>['getAlbum']>>) {
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

/** 后台任务的统一返回形状（和 bili bulk / music get 一致：data.job.id）。 */
function jobStarted(job: JobView, album: Pick<AlbumDetail, 'id' | 'title' | 'episodes'>, chapters: number[]) {
  return {
    status: 'job_started' as const,
    job: { id: job.id, title: job.title, total: job.total },
    album: { id: album.id, title: album.title, episodes: album.episodes.length },
    chapters,
    next: `用 \`astra jm job ${job.id}\` 看进度；要等它跑完加 \`--wait 600\``,
  }
}

/**
 * 当场下还是开后台任务。显式参数优先；都没给时多话本走后台，单话当场下。
 * 抽成纯函数方便测，不用起网络。
 */
export function shouldBackground(values: { background?: unknown; wait?: unknown }, chapterCount: number): boolean {
  if (values.background === true) return true
  if (values.wait === true) return false
  return chapterCount > 1
}

const get: Command = {
  name: 'jm get',
  summary: '下载一本漫画：车号、JM 号或链接都行',
  usage: 'astra jm get <车号|链接> [--chapter <n>] [--background | --wait] [--force] [--concurrency 3]',
  notes: [
    'data.status：downloaded / already_have / job_started',
    '**多话本默认开后台任务**（job_started，看 data.job.id）；单话本或给了 --chapter 时当场下完。`--background` 强制后台，`--wait` 强制当场下',
    '后台任务用 `astra jm job <id>` 查进度；每一项是一话，items[].status 是 downloaded / skipped（已有）/ failed',
    '截断的图不算已有，会重下；仍不完整就不留文件',
    '落盘后登记资产库，id 是 jm:<本子>_c<话数>_p<页码>。chapters[].registered 小于 pages 说明漫画目录还不是 lib root',
    '落盘目录看 `jm.dir` / `ASTRA_JM_DIR`，模板看 `jm.template`',
    '解混淆需要 ffmpeg（和 B 站共用 `music.ffmpeg`）',
  ],
  options: {
    chapter: { type: 'string', description: '只下一话（从 1 开始的 sort）', valueName: 'n' },
    background: { type: 'boolean', description: '开后台任务，立刻返回 job id' },
    wait: { type: 'boolean', description: '当场下完再返回（多话本也不开任务）' },
    force: { type: 'boolean', description: '已有也重新下（只在当场下载时生效）' },
    concurrency: { type: 'string', description: '单话内图片并发 1..6，默认取 jm.concurrency', valueName: 'n' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const target = parseJmTarget(positionals[0]!)
    let chapter: number | 'all' = 'all'
    if (typeof values.chapter === 'string') {
      const n = Number(values.chapter)
      if (!Number.isInteger(n) || n < 1) throw invalidInput('--chapter 必须是从 1 开始的整数')
      chapter = n
    }
    if (values.background === true && values.wait === true) throw invalidInput('--background 和 --wait 只能选一个')
    if (values.background === true && values.force === true) {
      throw invalidInput('--force 只能和当场下载一起用', '后台任务会跳过已经完整的页；要强制重下就去掉 --background')
    }
    const concurrency = Math.max(1, Math.min(6, Number(values.concurrency ?? getConfig('jm.concurrency')) || 3))

    // /photo/ 链接：解析成所属本子，并只下这一话（除非用户另指定了 --chapter）
    const client = jmClient()
    let albumId = target.id
    if (target.kind === 'photo') {
      const ch = await client.getChapter(target.id, undefined, signal)
      albumId = ch.albumId
      if (chapter === 'all') chapter = ch.sort
    }

    const album = await client.getAlbum(albumId, signal)
    let episodes = album.episodes
    if (typeof chapter === 'number') {
      const hit = episodes.find((e) => e.sort === chapter)
      if (!hit) throw new AstraError('NOT_FOUND', `没有第 ${chapter} 话`, { exitCode: 4, hint: '`astra jm info` 看章节列表' })
      episodes = [hit]
    }

    if (shouldBackground({ background: values.background, wait: values.wait }, episodes.length)) {
      const job = createJob({
        domain: JM_DOMAIN,
        kind: chapter === 'all' ? 'album' : 'chapter',
        title: chapter === 'all' ? `「${album.title}」${episodes.length} 话` : `「${album.title}」第 ${chapter} 话`,
        items: chapterItems(album, episodes),
        meta: { albumId: album.id },
      })
      spawnWorker(JM_DOMAIN, job.id)
      return { data: jobStarted(job, album, episodes.map((e) => e.sort)) }
    }

    const result = await downloadAlbum(album, { force: values.force === true, chapter, concurrency, signal })
    const unregistered = result.chapters.some((c) => c.registered < c.pages)
    return {
      data: result,
      ...(unregistered
        ? { warnings: ['有页没登记进资产库：漫画目录还不是 lib root。跑 `astra lib root auto`，再 `astra lib adopt --root jm` 认领'] }
        : {}),
    }
  },
}

const info: Command = {
  name: 'jm info',
  summary: '看漫画信息与章节列表，不下载',
  usage: 'astra jm info <车号|链接>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, signal }) {
    const target = parseJmTarget(positionals[0]!)
    const client = jmClient()
    const albumId = target.kind === 'photo' ? (await client.getChapter(target.id, undefined, signal)).albumId : target.id
    const album = await client.getAlbum(albumId, signal)
    return { data: albumView(album) }
  },
}

/**
 * 搜索结果能不能直接用。只有上游跳转（搜的是车号）或全站只有一条才算 exact；
 * 本页只剩一条但 total 更大（被 --limit 或分页截掉了），仍是 ambiguous。
 */
export function searchDecision(redirectId: string | null, items: SearchHit[], total: number): {
  status: 'exact' | 'ambiguous' | 'empty'
  pick: string | null
  next: string
} {
  if (redirectId) return { status: 'exact', pick: redirectId, next: `可直接 \`astra jm get ${redirectId}\`` }
  if (items.length === 0) return { status: 'empty', pick: null, next: '换个词，或换 --scope（tag / author / work / actor）再搜' }
  if (items.length === 1 && total <= 1) return { status: 'exact', pick: items[0]!.id, next: `可直接 \`astra jm get ${items[0]!.id}\`` }
  return { status: 'ambiguous', pick: null, next: '让用户从 candidates 里选一个 id，再 `astra jm get <id>`；不要替用户挑' }
}

const search: Command = {
  name: 'jm search',
  summary: '按关键词搜漫画',
  usage: 'astra jm search <关键词> [--scope site|work|author|tag|actor] [--page 1] [--limit 20]',
  notes: [
    '默认 --scope site：站内全文，对标题和正文',
    '--scope tag 按站内标签；author 作者；work 作品；actor 登场角色',
    '搜到车号会直接 redirect 到那一本',
    'data.status：exact（上游跳转或全站只有一条，data.pick 可直接 `jm get`）/ ambiguous（多条）/ empty（没搜到）',
    'ambiguous 时**不要替用户挑**：把 candidates 的 id / title / author 列给用户，选定后再 `jm get <id>`',
  ],
  options: {
    scope: { type: 'string', description: '搜索范围：site（默认）/ work / author / tag / actor', valueName: 'scope' },
    page: { type: 'string', description: '页码，从 1 开始', valueName: 'n' },
    limit: { type: 'string', description: '最多返回几条，默认 20', valueName: 'n' },
  },
  minArgs: 1,
  async run({ positionals, values, signal }) {
    const query = positionals.join(' ').trim()
    if (!query) throw invalidInput('缺少关键词')
    const scopeRaw = typeof values.scope === 'string' && values.scope.trim() ? values.scope.trim() : 'site'
    searchMainTag(scopeRaw)
    const scope = scopeRaw as SearchScope
    const page = Math.max(1, Number(values.page ?? '1') || 1)
    const limit = Math.max(1, Math.min(80, Number(values.limit ?? '20') || 20))
    const result = await jmClient().search(query, page, scope, signal)
    const items = result.items.slice(0, limit)
    const decision = searchDecision(result.redirectId, items, result.total)
    return {
      data: {
        status: decision.status,
        query: result.query,
        scope: result.scope,
        total: result.total,
        page: result.page,
        redirectId: result.redirectId,
        pick: decision.pick,
        items,
        ...(decision.status === 'ambiguous'
          ? { candidates: items.map((i) => ({ id: i.id, title: i.title, author: i.author || null })) }
          : {}),
        next: decision.next,
      },
      table: {
        headers: ['id', 'title', 'author'],
        rows: result.items.slice(0, limit).map((i) => [i.id, i.title, i.author || null]),
      },
    }
  },
}

const doctor: Command = {
  name: 'jm doctor',
  summary: '漫画能力自检：目录、ffmpeg、上游连通',
  usage: 'astra jm doctor',
  maxArgs: 0,
  async run({ signal }) {
    const checks: { name: string; ok: boolean; detail: string }[] = []
    const root = jmRoot()
    try {
      mkdirSync(root, { recursive: true })
      const write = checkWritable(root)
      checks.push({ name: 'jm_dir', ok: write.ok, detail: write.detail })
    } catch (err) {
      checks.push({ name: 'jm_dir', ok: false, detail: (err as Error).message.slice(0, 120) })
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
      await jmClient().ensure()
      // 用 setting 已经打通过；再探一次搜索空词会失败，改探一个已知可能存在的接口形状
      const probe = await jmClient().search('1', 1, 'site', signal)
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

// ── 后台任务 ─────────────────────────────────────────────

const jobCmd: Command = {
  name: 'jm job',
  summary: '看漫画后台任务进度（一项 = 一话）',
  usage: 'astra jm job <id> [--items] [--failed] [--wait 60]',
  notes: [
    'status：queued / running / done / partial / failed / cancelled / interrupted',
    'interrupted = worker 进程没了（重启、被杀），用 `astra jm job resume <id>` 接着下',
    '--wait 最多阻塞这么多秒等它结束（≤600）',
  ],
  options: {
    items: { type: 'boolean', description: '列出每一话' },
    failed: { type: 'boolean', description: '只列失败的' },
    wait: { type: 'string', description: '最多等待秒数（≤600）', valueName: 's' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const id = positionals[0]!
    const waitSeconds = Math.min(600, Math.max(0, Number(values.wait ?? '0') || 0))
    const deadline = Date.now() + waitSeconds * 1000
    let snapshot = getJob(id, false, JM_DOMAIN)
    while (waitSeconds > 0 && Date.now() < deadline && !signal.aborted && ['queued', 'running'].includes(snapshot.job.status)) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      snapshot = getJob(id, false, JM_DOMAIN)
    }
    const withItems = values.items === true || values.failed === true
    const full = getJob(id, withItems, JM_DOMAIN)
    const items = values.failed === true ? full.items?.filter((i) => i.status === 'failed') : full.items
    return {
      data: {
        ...full.job,
        statusLabel: statusLabel(full.job.status),
        progress: `${full.job.done + full.job.skipped}/${full.job.total}`,
        ...(withItems ? { items } : {}),
      },
    }
  },
}

const jobList: Command = {
  name: 'jm jobs',
  summary: '最近的漫画后台任务',
  usage: 'astra jm jobs [--active] [--limit 10]',
  options: {
    active: { type: 'boolean', description: '只看进行中的' },
    limit: { type: 'string', short: 'n', description: '默认 10，最多 100', valueName: 'n' },
  },
  maxArgs: 0,
  async run({ values }) {
    const limit = Number(values.limit ?? '10')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidInput('--limit 必须是 1..100 的整数')
    const jobs = listJobs(limit, values.active === true, JM_DOMAIN)
    return {
      data: { total: jobs.length, jobs: jobs.map((j) => ({ ...j, statusLabel: statusLabel(j.status), progress: `${j.done + j.skipped}/${j.total}` })) },
      table: {
        headers: ['ID', '状态', '进度', '失败', '标题'],
        rows: jobs.map((j) => [j.id, statusLabel(j.status), `${j.done + j.skipped}/${j.total}`, j.failed, j.title]),
      },
    }
  },
}

const jobCancel: Command = {
  name: 'jm job cancel',
  summary: '取消漫画后台任务（已下好的话不删）',
  usage: 'astra jm job cancel <id>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const j = cancelJob(positionals[0]!, JM_DOMAIN)
    return { data: { ...j, statusLabel: statusLabel(j.status) } }
  },
}

const jobResume: Command = {
  name: 'jm job resume',
  summary: '继续 / 重试漫画后台任务（只重跑没完成的话）',
  usage: 'astra jm job resume <id>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const j = resumeJob(positionals[0]!, JM_DOMAIN)
    return { data: { ...j, statusLabel: statusLabel(j.status) } }
  },
}

const workerCmd: Command = {
  name: 'jm _worker',
  summary: '（内部）漫画后台任务执行体',
  usage: 'astra jm _worker <id>',
  hidden: true,
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    await runWorker(JM_DOMAIN, positionals[0]!)
    return { data: getJob(positionals[0]!, false, JM_DOMAIN).job }
  },
}

// ── 订阅 ─────────────────────────────────────────────

/** 给 cron 的那一行。和 bili / music 一样：`subscribe run` 只跑到点的。 */
export const JM_SUBSCRIBE_CRON = 'astra jm subscribe run'

function subView(s: JmSubscription) {
  return {
    id: s.id,
    albumId: s.albumId,
    title: s.title,
    everyHours: s.everyHours,
    enabled: s.enabled,
    lastCheckedAt: s.lastCheckedAt,
    baselineChapters: s.baseline.length,
    downloadedChapters: Object.keys(s.done).length,
    lastJobId: s.lastJobId,
  }
}

function parseEvery(raw: unknown): number {
  const n = Number(raw ?? '24')
  if (!Number.isInteger(n) || n < 1 || n > 720) throw invalidInput('--every 必须是 1..720 的整数（小时）')
  return n
}

const subAdd: Command = {
  name: 'jm subscribe add',
  summary: '订阅一本连载：定时检查，出新话自动下',
  usage: 'astra jm subscribe add <车号|链接> [--every 24] [--backfill]',
  notes: [
    '建订阅时把**当前已有的话记为基线**，订阅只管之后出的新话；要补旧话用 `jm get`，或建订阅时加 --backfill',
    '新话按章节 id 求差判断，不靠更新时间',
    '定时检查：在 Hermes 里配一条 cron 定时调 `astra jm subscribe run`（比如每 6 小时）。它只跑到点的订阅，到点间隔由 --every 决定',
    '同一本重复订阅不会建第二条，会返回已有那条（data.status: already_subscribed）',
  ],
  options: {
    every: { type: 'string', description: '每隔几小时检查一次，默认 24', valueName: 'h' },
    backfill: { type: 'boolean', description: '不记基线：第一次检查就把还没下过的话全补上' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const every = parseEvery(values.every)
    const target = parseJmTarget(positionals[0]!)
    const client = jmClient()
    const albumId = target.kind === 'photo' ? (await client.getChapter(target.id, undefined, signal)).albumId : target.id
    const album = await client.getAlbum(albumId, signal)
    const { subscription, created } = addJmSubscription(album, { everyHours: every, backfill: values.backfill === true })
    const warnings: string[] = []
    if (created) {
      warnings.push(values.backfill === true
        ? `下一次 \`${JM_SUBSCRIBE_CRON}\` 会把还没下过的 ${album.episodes.length} 话补上`
        : `已把现有 ${album.episodes.length} 话记为基线，只下之后的新话；之前的用 \`astra jm get ${album.id}\``)
    }
    return {
      data: {
        status: created ? 'subscribed' : 'already_subscribed',
        subscription: subView(subscription),
        cron: { command: JM_SUBSCRIBE_CRON, suggestedSchedule: '0 */6 * * *', note: 'run 只跑到点的订阅；到点间隔看 everyHours' },
      },
      warnings,
    }
  },
}

const subList: Command = {
  name: 'jm subscribe list',
  summary: '列出漫画订阅及状态',
  usage: 'astra jm subscribe list',
  maxArgs: 0,
  async run() {
    const subs = listJmSubscriptions()
    const due = new Set(dueJmSubscriptions(Date.now(), subs).map((s) => s.id))
    return {
      data: { total: subs.length, cron: JM_SUBSCRIBE_CRON, subscriptions: subs.map((s) => ({ ...subView(s), due: due.has(s.id) })) },
      table: {
        headers: ['ID', '车号', '标题', '间隔h', '启用', '已下话数', '上次检查'],
        rows: subs.map((s) => [s.id, s.albumId, s.title, s.everyHours, s.enabled ? '是' : '否', Object.keys(s.done).length, s.lastCheckedAt ?? '-']),
      },
    }
  },
}

const subSet: Command = {
  name: 'jm subscribe set',
  summary: '改漫画订阅：间隔 / 启停',
  usage: 'astra jm subscribe set <订阅id|车号> [--every 12] [--enable|--disable]',
  options: {
    every: { type: 'string', description: '每隔几小时', valueName: 'h' },
    enable: { type: 'boolean', description: '启用' },
    disable: { type: 'boolean', description: '停用' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    if (values.enable === true && values.disable === true) throw invalidInput('--enable 与 --disable 不能同时给')
    const patch: { everyHours?: number; enabled?: boolean } = {}
    if (values.every !== undefined) patch.everyHours = parseEvery(values.every)
    if (values.enable === true) patch.enabled = true
    if (values.disable === true) patch.enabled = false
    return { data: subView(setJmSubscription(positionals[0]!, patch)) }
  },
}

const subRemove: Command = {
  name: 'jm subscribe remove',
  summary: '删除漫画订阅（已下载的文件不动）',
  usage: 'astra jm subscribe remove <订阅id|车号>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const sub = removeJmSubscription(positionals[0]!)
    return { data: { removed: true, subscription: subView(sub) } }
  },
}

const subRun: Command = {
  name: 'jm subscribe run',
  summary: '检查到点的漫画订阅，有新话就开后台任务（给 cron 调）',
  usage: 'astra jm subscribe run [--id <订阅id|车号>] [--force]',
  notes: [
    `cron 里配 \`${JM_SUBSCRIBE_CRON}\` 即可；不带参数只跑到点的，--force 不管间隔全跑一遍`,
    '有新话时 results[].job.id 是后台任务，用 `astra jm job <id>` 看',
    '只有下成功（downloaded / skipped）的话才记为已下；失败的下一轮自动重试',
    '上一轮任务还没跑完的订阅这次跳过，不会重复下',
  ],
  options: {
    id: { type: 'string', description: '只跑这一个订阅', valueName: 'id' },
    force: { type: 'boolean', description: '忽略间隔，立刻检查全部启用的订阅' },
  },
  maxArgs: 0,
  async run({ values, signal }) {
    const targets = typeof values.id === 'string' && values.id
      ? [findJmSubscription(values.id)]
      : values.force === true ? listJmSubscriptions().filter((s) => s.enabled) : dueJmSubscriptions()
    if (targets.length === 0) return { data: { ran: 0, results: [], note: '没有到点的订阅' } }
    const results: Record<string, unknown>[] = []
    const warnings: string[] = []
    for (const sub of targets) {
      if (signal.aborted) break
      try {
        const r = await runJmSubscription(sub.id, { signal })
        results.push({
          id: r.subscription.id,
          albumId: r.subscription.albumId,
          title: r.subscription.title,
          newCount: r.newCount,
          newChapters: r.newChapters,
          ...(r.jobId ? { job: { id: r.jobId, total: r.newCount } } : {}),
          note: r.note,
        })
      } catch (err) {
        const message = err instanceof AstraError ? err.message : (err as Error).message.slice(0, 150)
        results.push({ id: sub.id, albumId: sub.albumId, title: sub.title, newCount: 0, newChapters: [], note: `失败：${message}` })
        warnings.push(`订阅 ${sub.id}（${sub.title}）检查失败：${message}`)
      }
    }
    return { data: { ran: results.length, results }, warnings }
  },
}

export const jmCommands: Command[] = [
  get, info, search, doctor,
  jobCmd, jobList, jobCancel, jobResume, workerCmd,
  subAdd, subList, subSet, subRemove, subRun,
]

/**
 * `astra music ...` 命令。
 *
 * 设计取向：一条命令办完一件事。`get` 是主入口 —— 给关键词 / 链接 / id 都行，
 * 拿得准就直接下完返回结果，拿不准就返回候选让 AI 回去问用户。
 */
import { AstraError, invalidInput } from '../core/errors.ts'
import { getConfig } from '../core/config.ts'
import type { Command } from '../core/command.ts'
import { isQuality, type Quality } from './audio.ts'
import { decide, scoreTrack, type Candidate } from './match.ts'
import { artistTopTracks, albumInfo, playlistTracks, searchCollection, searchSongs, songDetail, songDetails, type Track } from './netease.ts'
import { resolveTarget } from './target.ts'
import { downloadTrack } from './download.ts'
import { allTracks, backfillFingerprints, findTrack, forgetTrack, libraryStats, searchLibrary, type LibraryTrack } from './library.ts'
import { archiveAlbumCovers, exportM3u } from './library-io.ts'
import { refreshLibrarySpecs } from './maintain.ts'
import {
  addSubscription, dueSubscriptions, fetchSubscriptionTracks, findSubscription, listSubscriptions,
  recentRuns, removeSubscription, runSubscription, setSubscription, type SubscribeKind,
} from './subscribe.ts'
import { jobItemsFor, MUSIC_DOMAIN, qualitySummary } from './jobs.ts'
import { cancelJob, createJob, getJob, listJobs, resumeJob, runWorker, spawnWorker, statusLabel } from '../core/jobs.ts'
import { addSource, listSources, loadEnabledSources, orphanScripts, removeSource, setSourceEnabled } from '../lx/store.ts'
import { musicInfoOf } from './resolve.ts'
import { probeUrl } from './audio.ts'
import { accountStatus, beginLogin, logout as logoutSession, pollLogin, waitLogin } from './login.ts'
import { loadSession, myPlaylists } from './auth.ts'
import { likedIds, likedStatus, recommendDaily, requireSession, weapiPost } from './account-api.ts'
import { loadCandidateTracks, scanUpgradable } from './upgrade.ts'
import { applyLike, prepareLike } from './like.ts'
import { toTrack } from './netease.ts'

function qualityOf(value: unknown): Quality {
  const q = typeof value === 'string' && value ? value : getConfig('music.quality')
  if (!isQuality(q)) throw invalidInput(`音质 ${q} 不合法`, '可选：128k / 320k / flac / 24bit')
  return q
}

function intOf(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw invalidInput(`--${name} 必须是 ${min}..${max} 的整数`)
  return n
}

function formatDuration(ms: number | null): string | null {
  if (!ms) return null
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 给 AI 看的候选：带 ref（下一步直接 `music get <ref>`）和版本标记。 */
function candidateView(c: Candidate, index: number) {
  const t = c.track
  return {
    index: index + 1,
    ref: `wy:${t.id}`,
    title: t.title,
    artists: t.artists,
    album: t.album,
    duration: formatDuration(t.durationMs),
    year: t.publishTime ? new Date(t.publishTime + 8 * 3600_000).getUTCFullYear() : null,
    note: [...t.aliases, ...t.translations].join(' / ') || null,
    flags: c.flags,
    inLibrary: findTrack('wy', t.id) !== null,
  }
}

function trackView(t: Track) {
  return {
    ref: `wy:${t.id}`,
    title: t.title,
    artists: t.artists,
    album: t.album,
    duration: formatDuration(t.durationMs),
    note: [...t.aliases, ...t.translations].join(' / ') || null,
  }
}

async function collectionTracks(kind: 'album' | 'playlist' | 'artist', id: string, signal: AbortSignal): Promise<{ title: string; tracks: Track[] }> {
  if (kind === 'album') {
    const r = await albumInfo(id, signal)
    return { title: `专辑《${r.album.name}》- ${r.album.artists.join(' / ')}`, tracks: r.tracks }
  }
  if (kind === 'playlist') {
    const r = await playlistTracks(id, signal)
    return { title: `歌单《${r.name}》`, tracks: r.tracks }
  }
  const r = await artistTopTracks(id, signal)
  return { title: `${r.name} 热门歌曲`, tracks: r.tracks }
}

function startBatch(kind: string, title: string, quality: Quality, tracks: Track[]) {
  if (tracks.length === 0) throw new AstraError('EMPTY', `${title} 里没有歌曲`, { exitCode: 4 })
  const job = createJob({ domain: MUSIC_DOMAIN, kind, title, profile: quality, items: jobItemsFor(tracks, quality) })
  spawnWorker(MUSIC_DOMAIN, job.id)
  const inLibrary = tracks.filter((t) => findTrack('wy', t.id) !== null).length
  return {
    data: {
      status: 'job_started',
      job: { id: job.id, title, total: tracks.length, alreadyInLibrary: inLibrary },
      preview: tracks.slice(0, 5).map(trackView),
    },
    warnings: [] as string[],
  }
}

const get: Command = {
  name: 'music get',
  summary: '下载一首歌（或一整张专辑 / 歌单）：给关键词、网易云链接或 ref 都行',
  usage: 'astra music get <关键词|链接|ref> [--quality flac] [--force]',
  notes: [
    '结果 data.status：downloaded（下好了）/ already_have（曲库里已有，没重复下）/ ambiguous（拿不准，需要用户选）/ job_started（批量任务已在后台开始）',
    'ambiguous 时把 candidates 列给用户（标题、歌手、专辑、时长、flags），用户选定后用该项的 ref 再调一次 get；不要自己替用户挑',
    'downloaded 时如果 downgraded=true，要告诉用户实际音质（比如请求无损只拿到 128k）',
    '链接是专辑 / 歌单 / 歌手时会直接开后台任务，用 `astra music job <id>` 查进度',
  ],
  options: {
    quality: { type: 'string', short: 'q', description: '请求音质：128k / 320k / flac / 24bit（默认取配置 music.quality）', valueName: 'q' },
    force: { type: 'boolean', description: '曲库里已有也重新下载' },
    limit: { type: 'string', description: '候选数量上限，默认 5', valueName: 'n' },
  },
  minArgs: 1,
  async run({ positionals, values, signal }) {
    const input = positionals.join(' ')
    const quality = qualityOf(values.quality)
    const target = await resolveTarget(input)
    if (target.kind === 'album' || target.kind === 'playlist' || target.kind === 'artist') {
      const { title, tracks } = await collectionTracks(target.kind, target.id, signal)
      return startBatch(target.kind, title, quality, tracks)
    }
    let track: Track
    let alternatives: Candidate[] = []
    if (target.kind === 'song') {
      track = await songDetail(target.id, signal)
    } else {
      const { tracks } = await searchSongs(target.keyword, 30, 0, signal)
      const decision = decide(target.keyword, tracks, intOf(values.limit, 5, 1, 20, 'limit'))
      if (!decision.pick) {
        if (decision.candidates.length === 0) {
          throw new AstraError('NOT_FOUND', `网易云搜不到「${target.keyword}」`, { exitCode: 4, hint: '换个写法再搜，比如只写歌名，或歌名加歌手' })
        }
        return {
          data: {
            status: 'ambiguous',
            reason: decision.reason,
            keyword: target.keyword,
            candidates: decision.candidates.map(candidateView),
            next: '让用户从 candidates 里选一个，然后执行 `astra music get <ref>`',
          },
        }
      }
      track = decision.pick.track
      alternatives = decision.alternatives
    }
    const result = await downloadTrack(track, { quality, force: values.force === true, signal })
    const data: Record<string, unknown> = { ...result }
    delete data.warnings
    if (alternatives.length > 0) data.otherVersions = alternatives.slice(0, 3).map(candidateView)
    return { data, warnings: result.warnings }
  },
}

const search: Command = {
  name: 'music search',
  summary: '只搜索不下载：歌曲（默认）/ 专辑 / 歌单 / 歌手',
  usage: 'astra music search <关键词> [--type song|album|playlist|artist] [--limit 10]',
  notes: ['每项都带 ref，可以直接交给 `astra music get <ref>`'],
  options: {
    type: { type: 'string', short: 't', description: 'song（默认）/ album / playlist / artist', valueName: 'type' },
    limit: { type: 'string', short: 'n', description: '1..30，默认 10', valueName: 'n' },
    page: { type: 'string', description: '页码，默认 1', valueName: 'n' },
  },
  minArgs: 1,
  async run({ positionals, values, signal }) {
    const keyword = positionals.join(' ')
    const limit = intOf(values.limit, 10, 1, 30, 'limit')
    const page = intOf(values.page, 1, 1, 50, 'page')
    const type = (values.type as string | undefined) ?? 'song'
    if (type === 'song') {
      const { total, tracks } = await searchSongs(keyword, limit, (page - 1) * limit, signal)
      return { data: { type, keyword, total, page, items: tracks.map((t, i) => candidateView(scoreTrack(keyword, t), i)) } }
    }
    if (type !== 'album' && type !== 'playlist' && type !== 'artist') throw invalidInput(`--type ${type} 不合法`, '可选：song / album / playlist / artist')
    const items = await searchCollection(type, keyword, limit, signal)
    const prefix = type === 'album' ? 'album' : type === 'playlist' ? 'playlist' : 'artist'
    return { data: { type, keyword, items: items.map((x, i) => ({ index: i + 1, ref: `${prefix}:${x.id}`, ...x, id: undefined })) } }
  },
}

const info: Command = {
  name: 'music info',
  summary: '查看歌曲 / 专辑 / 歌单 / 歌手的曲目，不下载',
  usage: 'astra music info <链接|ref>',
  options: { limit: { type: 'string', short: 'n', description: '列表最多显示几首，默认 50', valueName: 'n' } },
  minArgs: 1,
  async run({ positionals, values, signal }) {
    const target = await resolveTarget(positionals.join(' '))
    const limit = intOf(values.limit, 50, 1, 1000, 'limit')
    if (target.kind === 'keyword') throw invalidInput('info 需要链接或 ref', '先用 `astra music search` 找到 ref')
    if (target.kind === 'song') {
      const t = await songDetail(target.id, signal)
      const lib = findTrack('wy', t.id)
      return { data: { ...trackView(t), inLibrary: lib ? { path: lib.path, quality: lib.quality, missing: lib.missing } : null } }
    }
    const { title, tracks } = await collectionTracks(target.kind, target.id, signal)
    return {
      data: {
        title,
        total: tracks.length,
        inLibrary: tracks.filter((t) => findTrack('wy', t.id) !== null).length,
        tracks: tracks.slice(0, limit).map(trackView),
        truncated: tracks.length > limit,
      },
    }
  },
}

const batch: Command = {
  name: 'music batch',
  summary: '一次下载多首指定的歌（后台任务）',
  usage: 'astra music batch <ref> [ref...] [--quality flac]',
  notes: ['只接受明确的 ref / 歌曲链接；关键词要先用 get 或 search 确认版本'],
  options: {
    quality: { type: 'string', short: 'q', description: '请求音质', valueName: 'q' },
    title: { type: 'string', description: '任务名，默认"N 首歌"', valueName: 'text' },
  },
  minArgs: 1,
  async run({ positionals, values, signal }) {
    const quality = qualityOf(values.quality)
    const ids: string[] = []
    for (const p of positionals) {
      const t = await resolveTarget(p)
      if (t.kind !== 'song') throw invalidInput(`「${p}」不是一首歌的 ref 或链接`)
      if (!ids.includes(t.id)) ids.push(t.id)
    }
    const tracks = await songDetails(ids, signal)
    const missing = ids.filter((id) => !tracks.some((t) => t.id === id))
    const started = startBatch('songs', (values.title as string | undefined) ?? `${tracks.length} 首歌`, quality, tracks)
    if (missing.length > 0) started.warnings.push(`网易云查不到：${missing.join(', ')}`)
    return started
  },
}

function trackViewOfLib(t: LibraryTrack) {
  return {
    ref: `wy:${t.id}`,
    title: t.title,
    artists: t.artists,
    album: t.album,
    quality: t.quality,
    spec: t.spec.sampleRate ? `${Math.round((t.spec.sampleRate / 1000) * 10) / 10}kHz/${t.spec.bitsPerSample ?? '?'}bit` : null,
    format: t.format,
    bitrateKbps: t.bps ? Math.round(t.bps / 1000) : null,
    sizeMB: t.bytes ? Math.round((t.bytes / 1048576) * 10) / 10 : null,
    path: t.path,
    missing: t.missing,
    hasCover: t.hasCover,
    hasWordLyric: t.hasWordLyric,
    downloadedAt: t.createdAt,
  }
}

const have: Command = {
  name: 'music have',
  summary: '查曲库：有没有某首歌 / 最近下了什么 / 统计 / 哪些还能升级',
  usage: 'astra music have [关键词] [--limit 20] [--low] [--refresh]',
  notes: [
    '不带关键词时列出最近下载的歌和统计；missing=true 表示记录还在但文件已被删除或移动',
    '--low 只列不是无损或低于 24bit 的（问"哪些还能升级"时用）',
    '--refresh 重新读一遍文件头部，回填老记录缺的采样率 / 位深与配套文件状态',
  ],
  options: {
    limit: { type: 'string', short: 'n', description: '默认 20', valueName: 'n' },
    low: { type: 'boolean', description: '只列有损或低于 24bit 的' },
    refresh: { type: 'boolean', description: '回读文件补齐规格字段（会读文件头，几秒）' },
  },
  async run({ positionals, values }) {
    const limit = intOf(values.limit, 20, 1, 500, 'limit')
    if (values.refresh === true) {
      // 先补指纹再回读规格：指纹是"老记录才缺"的，补它不需要读文件
      // 全量重算：指纹算法会变，旧的留着重算不出来就会一直匹配不上
      const fingerprinted = backfillFingerprints(true)
      const refreshed = await refreshLibrarySpecs()
      return { data: { refreshed, fingerprinted, stats: libraryStats() } }
    }
    if (values.low === true) {
      const low = allTracks().filter((t) => !t.missing && (t.quality === '128k' || t.quality === '320k' || (t.spec.bitsPerSample !== null && t.spec.bitsPerSample <= 16)))
      return { data: { total: low.length, tracks: low.slice(0, limit).map(trackViewOfLib), truncated: low.length > limit, hint: '这些可以用 `astra music get <ref> --force` 重下，官方通道常能拿到更高规格' } }
    }
    const { total, tracks } = searchLibrary(positionals.join(' '), limit)
    return {
      data: positionals.length > 0
        ? { keyword: positionals.join(' '), total, tracks: tracks.map(trackViewOfLib) }
        : { stats: libraryStats(), recent: tracks.map(trackViewOfLib) },
    }
  },
}

const forget: Command = {
  name: 'music forget',
  summary: '从曲库记录里移除一首歌（不删文件），之后 get 会重新下载',
  usage: 'astra music forget <ref>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const t = await resolveTarget(positionals[0]!)
    if (t.kind !== 'song') throw invalidInput('需要一首歌的 ref')
    return { data: { removed: forgetTrack('wy', t.id), ref: `wy:${t.id}` } }
  },
}

const job: Command = {
  name: 'music job',
  summary: '查看后台任务进度（可只写 id 前几位）',
  usage: 'astra music job <id> [--items] [--wait 60]',
  notes: ['--wait 会阻塞最多 N 秒直到任务结束；status 为 interrupted 表示进程意外退出，可 `astra music job resume <id>`'],
  options: {
    items: { type: 'boolean', description: '列出每一首的状态' },
    failed: { type: 'boolean', description: '只列失败的' },
    wait: { type: 'string', description: '最多等待秒数（≤600）', valueName: 's' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const id = positionals[0]!
    const waitSeconds = intOf(values.wait, 0, 0, 600, 'wait')
    const deadline = Date.now() + waitSeconds * 1000
    let snapshot = getJob(id, false, MUSIC_DOMAIN)
    while (waitSeconds > 0 && Date.now() < deadline && !signal.aborted && ['queued', 'running'].includes(snapshot.job.status)) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      snapshot = getJob(id, false, MUSIC_DOMAIN)
    }
    const full = getJob(id, true, MUSIC_DOMAIN)
    const items = values.failed === true ? full.items?.filter((i) => i.status === 'failed') : full.items
    return {
      data: {
        ...full.job,
        statusLabel: statusLabel(full.job.status),
        quality: qualitySummary(full.items ?? []) || null,
        requestedQuality: full.job.profile,
        ...(values.items === true || values.failed === true ? { items } : {}),
      },
    }
  },
}

const jobs: Command = {
  name: 'music jobs',
  summary: '最近的后台任务',
  usage: 'astra music jobs [--active] [--limit 10]',
  options: {
    active: { type: 'boolean', description: '只看进行中的' },
    limit: { type: 'string', short: 'n', description: '默认 10', valueName: 'n' },
  },
  maxArgs: 0,
  async run({ values }) {
    return { data: { jobs: listJobs(intOf(values.limit, 10, 1, 100, 'limit'), values.active === true, MUSIC_DOMAIN).map((j) => ({ ...j, statusLabel: statusLabel(j.status) })) } }
  },
}

const jobCancel: Command = {
  name: 'music job cancel',
  summary: '取消后台任务（已下好的保留）',
  usage: 'astra music job cancel <id>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const j = cancelJob(positionals[0]!, MUSIC_DOMAIN)
    return { data: { ...j, statusLabel: statusLabel(j.status) } }
  },
}

const jobResume: Command = {
  name: 'music job resume',
  summary: '继续 / 重试一个中断、取消或部分失败的任务',
  usage: 'astra music job resume <id>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const j = resumeJob(positionals[0]!, MUSIC_DOMAIN)
    return { data: { ...j, statusLabel: statusLabel(j.status) } }
  },
}

const worker: Command = {
  name: 'music _worker',
  summary: '（内部）后台任务执行体',
  usage: 'astra music _worker <id>',
  hidden: true,
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    await runWorker(MUSIC_DOMAIN, positionals[0]!)
    return { data: getJob(positionals[0]!, false, MUSIC_DOMAIN).job }
  },
}

const sourceList: Command = {
  name: 'music source list',
  summary: '列出已导入的洛雪音源',
  usage: 'astra music source list',
  maxArgs: 0,
  async run() {
    const orphans = orphanScripts()
    return {
      data: { sources: listSources().map(({ sha256, file, ...rest }) => ({ ...rest, sha256: sha256.slice(0, 12) })) },
      warnings: orphans.length > 0 ? [`音源目录里有未登记的脚本：${orphans.join(', ')}，用 source add 导入才会生效`] : [],
    }
  },
}

const sourceAdd: Command = {
  name: 'music source add',
  summary: '导入洛雪自定义音源脚本（.js），导入前会试加载',
  usage: 'astra music source add <文件> [--id 名字]',
  options: { id: { type: 'string', description: '自定义 id，默认取文件名', valueName: 'id' } },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    const r = await addSource(positionals[0]!, values.id as string | undefined)
    const warnings = r.platforms.includes('wy') ? [] : ['这个音源没有声明网易云（wy），对当前下载没用']
    return { data: { ...r.record, sha256: r.record.sha256.slice(0, 12), platforms: r.platforms }, warnings }
  },
}

const sourceRemove: Command = {
  name: 'music source remove',
  summary: '删除一个已导入的音源',
  usage: 'astra music source remove <id>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    return { data: { removed: removeSource(positionals[0]!).id } }
  },
}

const sourceToggle = (enabled: boolean): Command => ({
  name: `music source ${enabled ? 'enable' : 'disable'}`,
  summary: enabled ? '启用音源' : '停用音源（不删除）',
  usage: `astra music source ${enabled ? 'enable' : 'disable'} <id>`,
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    return { data: setSourceEnabled(positionals[0]!, enabled) }
  },
})

const sourceTest: Command = {
  name: 'music source test',
  summary: '用一首歌测试每个音源能不能出直链、实际音质是多少',
  usage: 'astra music source test [ref] [--quality flac]',
  options: { quality: { type: 'string', short: 'q', description: '请求音质', valueName: 'q' } },
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const target = await resolveTarget(positionals[0] ?? 'wy:1472480890')
    if (target.kind !== 'song') throw invalidInput('需要一首歌的 ref')
    const track = await songDetail(target.id, signal)
    const quality = qualityOf(values.quality)
    const { loaded, failed } = await loadEnabledSources()
    const results: Record<string, unknown>[] = failed.map((f) => ({ source: f.id, ok: false, error: `加载失败：${f.error}` }))
    for (const { record, source } of loaded) {
      const started = Date.now()
      try {
        const url = await source.musicUrl('wy', quality, musicInfoOf(track), 30_000)
        const probe = await probeUrl(url, track.durationMs, signal)
        results.push({
          source: record.id,
          ok: probe.problem === null,
          format: probe.format,
          quality: probe.quality,
          bitrateKbps: probe.bps ? Math.round(probe.bps / 1000) : null,
          bytes: probe.bytes,
          ms: Date.now() - started,
          ...(probe.problem ? { error: probe.problem } : {}),
        })
      } catch (err) {
        results.push({ source: record.id, ok: false, error: (err as Error).message.slice(0, 200), ms: Date.now() - started })
      }
    }
    return { data: { track: trackView(track), requested: quality, results } }
  },
}

const loginStart: Command = {
  name: 'music login start',
  summary: '开始网易云扫码登录：返回二维码（终端可直接显示）和后续轮询方法',
  usage: 'astra music login start',
  notes: [
    '命令立刻返回，不会等扫码。data.qrArt 是二维码文本，原样发给用户（等宽代码块），data.qrContent 是它编码的内容',
    '拿到后每隔 2~3 秒调一次 `astra music login poll`，直到 status 变成 done / expired',
    '二维码 5 分钟内有效；过期就重新 start',
  ],
  maxArgs: 0,
  async run({ signal }) {
    return { data: await beginLogin(signal) }
  },
}

const loginPoll: Command = {
  name: 'music login poll',
  summary: '查一次扫码状态（不阻塞）',
  usage: 'astra music login poll',
  notes: ['status: pending（继续等）/ done（成功，已在 data.account）/ expired（二维码过期，重新 start）'],
  maxArgs: 0,
  async run({ signal }) {
    const view = await pollLogin(signal)
    return { data: view }
  },
}

const loginWait: Command = {
  name: 'music login wait',
  summary: '阻塞等待扫码完成（给人用，最多 3 分钟）',
  usage: 'astra music login wait [--timeout 180]',
  options: { timeout: { type: 'string', description: '最多等多少秒，默认 180，最大 600', valueName: 's' } },
  maxArgs: 0,
  async run({ values, signal }) {
    const seconds = intOf(values.timeout, 180, 5, 600, 'timeout')
    return { data: await waitLogin(seconds, signal) }
  },
}

const loginPlain: Command = {
  name: 'music login',
  summary: '扫码登录（等同 `login start`）',
  usage: 'astra music login',
  maxArgs: 0,
  async run({ signal }) {
    return { data: await beginLogin(signal) }
  },
}

const account: Command = {
  name: 'music account',
  summary: '看登录状态：账号、会员、会话是否还有效',
  usage: 'astra music account',
  maxArgs: 0,
  async run({ signal }) {
    return { data: await accountStatus(signal) }
  },
}

const logout: Command = {
  name: 'music logout',
  summary: '清除本地会话（不影响网易云账号本身）',
  usage: 'astra music logout',
  maxArgs: 0,
  async run() {
    return { data: { loggedOut: logoutSession() } }
  },
}

const playlists: Command = {
  name: 'music playlists',
  summary: '我的歌单（含收藏的），需要登录',
  usage: 'astra music playlists [--limit 50]',
  notes: ['每项带 ref（playlist:<id>），可以直接 `astra music info <ref>` 看曲目或 `astra music get <ref>` 下载'],
  options: { limit: { type: 'string', short: 'n', description: '默认 50', valueName: 'n' } },
  maxArgs: 0,
  async run({ values, signal }) {
    const session = loadSession()
    if (!session) throw new AstraError('NOT_LOGGED_IN', '还没登录网易云', { exitCode: 3, hint: '先 `astra music login start`，让用户扫码' })
    const status = await accountStatus(signal)
    if (!status.userId) {
      throw new AstraError('NO_USER_ID', '拿不到账号 id，会话可能失效了', { exitCode: 3, hint: '`astra music login start` 重新扫码' })
    }
    const list = await myPlaylists(session, status.userId, signal)
    const limit = intOf(values.limit, 50, 1, 500, 'limit')
    return {
      data: {
        account: { userId: status.userId, nickname: status.nickname, vip: status.vip },
        total: list.length,
        playlists: list.slice(0, limit).map((p) => ({
          ref: `playlist:${p.id}`,
          name: p.name,
          trackCount: p.trackCount,
          kind: p.subscribed ? '收藏' : '自建',
          creator: p.creator,
          updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString().slice(0, 10) : null,
        })),
        truncated: list.length > limit,
      },
    }
  },
}

const daily: Command = {
  name: 'music daily',
  summary: '每日推荐（需要登录）：直接列出今天推给你的歌',
  usage: 'astra music daily [--limit 33] [--download]',
  notes: [
    '不带 --download 只列出来；带 --download 会开一个后台任务把这些歌下下来',
    '推荐每天都会变；数据来自网易云自己的推荐，不是我们算的',
  ],
  options: {
    limit: { type: 'string', short: 'n', description: '最多显示几首，默认全部', valueName: 'n' },
    download: { type: 'boolean', description: '顺手把今天的推荐开成下载任务' },
    quality: { type: 'string', short: 'q', description: '配合 --download 的请求音质', valueName: 'q' },
  },
  maxArgs: 0,
  async run({ values, signal }) {
    const status = await accountStatus(signal)
    const { session, userId } = requireSession(status.userId, signal)
    const { tracks, reasons } = await recommendDaily(session, signal)
    const limit = intOf(values.limit, tracks.length, 1, 300, 'limit')
    const mapped = tracks.map(toTrack)
    const view = mapped.slice(0, limit).map((t, i) => ({ ...trackView(t), reason: reasons[i] ?? null, inLibrary: findTrack('wy', t.id) !== null }))
    if (values.download === true) {
      const quality = qualityOf(values.quality)
      const started = startBatch('daily', `每日推荐 ${new Date().toISOString().slice(0, 10)}`, quality, mapped)
      return { data: { ...started.data, date: new Date().toISOString().slice(0, 10), today: view }, warnings: started.warnings }
    }
    return {
      data: {
        date: new Date().toISOString().slice(0, 10),
        total: mapped.length,
        inLibrary: mapped.filter((t) => findTrack('wy', t.id) !== null).length,
        tracks: view,
        truncated: mapped.length > limit,
      },
    }
  },
}

const liked: Command = {
  name: 'music liked',
  summary: '我喜欢的音乐（需要登录）：列出 / 下载 / 查红心 / 点红心（写操作需二次确认）',
  usage: 'astra music liked [--limit 50] [--download] [--check <ref>...] [--like <ref>...] [--unlike <ref>...] [--confirm <token>]',
  notes: [
    '不带参数时列出红心歌单；--check 查某几首是否已红心',
    '--like / --unlike 是**写操作**，会改动用户真实的网易云歌单。它不直接执行，只返回预览和一次性令牌；',
    '  把预览给用户看过、用户同意后，再用 `--confirm <token>` 执行。令牌 5 分钟有效、只能用一次',
    '已经是目标状态的歌会自动跳过（重复点红心是幂等的，但没必要发请求）',
    '--download 把红心歌单开成后台任务',
  ],
  options: {
    limit: { type: 'string', short: 'n', description: '显示几首，默认 50；0 表示不列曲目', valueName: 'n' },
    download: { type: 'boolean', description: '把喜欢的歌开成下载任务' },
    quality: { type: 'string', short: 'q', description: '配合 --download 的请求音质', valueName: 'q' },
    check: { type: 'boolean', description: '把位置参数当作歌曲 ref，查它们是否已红心' },
    like: { type: 'boolean', description: '把位置参数当作歌曲 ref，准备「点红心」（需 --confirm 确认）' },
    unlike: { type: 'boolean', description: '把位置参数当作歌曲 ref，准备「取消红心」（需 --confirm 确认）' },
    confirm: { type: 'string', description: '执行之前预览生成的令牌', valueName: 'token' },
  },
  async run({ positionals, values, signal }) {
    const status = await accountStatus(signal)
    const { session, userId } = requireSession(status.userId, signal)

    // 执行已确认的写操作
    if (typeof values.confirm === 'string') {
      const result = await applyLike(values.confirm, session, signal)
      return {
        data: { ...result, total: result.changed.length },
        warnings: result.failedCount > 0 ? [`${result.failedCount} 首没成功，见 changed 里的 error`] : [],
      }
    }

    // 准备写操作：只查状态 + 生成令牌，不动账号
    if (values.like === true || values.unlike === true) {
      if (values.like === true && values.unlike === true) throw invalidInput('--like 与 --unlike 不能同时给')
      if (positionals.length === 0) throw invalidInput('需要至少一个歌曲 ref', '例如：astra music liked --like wy:449818741')
      const action = values.like === true ? 'like' : 'unlike'
      const ids: string[] = []
      for (const p of positionals) {
        const t = await resolveTarget(p)
        if (t.kind !== 'song') throw invalidInput(`「${p}」不是一首歌的 ref`)
        if (!ids.includes(t.id)) ids.push(t.id)
      }
      const [details, statusMap] = await Promise.all([songDetails(ids, signal), likedStatus(session, ids, signal)])
      const titles = details.map((t) => ({
        id: t.id,
        title: t.title,
        artists: t.artists,
        currentlyLiked: statusMap.get(t.id) === true,
      }))
      return { data: prepareLike(action, titles) }
    }

    if (values.check === true) {
      if (positionals.length === 0) throw invalidInput('--check 需要至少一个 ref', '例如：astra music liked --check wy:186016')
      const ids: string[] = []
      for (const p of positionals) {
        const t = await resolveTarget(p)
        if (t.kind !== 'song') throw invalidInput(`「${p}」不是一首歌的 ref`)
        ids.push(t.id)
      }
      const map = await likedStatus(session, ids, signal)
      return { data: { checked: ids.map((id) => ({ ref: `wy:${id}`, liked: map.get(id) === true })) } }
    }
    const ids = await likedIds(session, userId, signal)
    const limit = intOf(values.limit, 50, 0, 2000, 'limit')
    if (values.download === true) {
      const quality = qualityOf(values.quality)
      const tracks = await songDetails(ids, signal)
      const started = startBatch('liked', '我喜欢的音乐', quality, tracks)
      return { data: { ...started.data, total: ids.length }, warnings: started.warnings }
    }
    const tracks = limit > 0 ? await songDetails(ids.slice(0, limit), signal) : []
    return {
      data: {
        total: ids.length,
        inLibrary: ids.length > 0 ? tracks.filter((t) => findTrack('wy', t.id) !== null).length : 0,
        tracks: tracks.map((t) => ({ ...trackView(t), inLibrary: findTrack('wy', t.id) !== null })),
        truncated: ids.length > limit && limit > 0,
      },
    }
  },
}

function subView(s: ReturnType<typeof listSubscriptions>[number]) {
  return {
    id: s.id,
    ref: `${s.kind}:${s.targetId}`,
    kind: s.kind,
    title: s.title,
    everyHours: s.everyHours,
    quality: s.quality,
    enabled: s.enabled,
    lastCheckedAt: s.lastCheckedAt,
    knownTracks: s.lastSeen?.length ?? null,
    lastJobId: s.lastJobId,
  }
}

/** 取订阅目标的真实名字与曲目数，确认它能读到。 */
async function describeTarget(kind: SubscribeKind, id: string, signal?: AbortSignal): Promise<{ title: string; count: number }> {
  if (kind === 'playlist') {
    const p = await playlistTracks(id, signal)
    return { title: `歌单《${p.name}》`, count: p.tracks.length }
  }
  if (kind === 'album') {
    const a = await albumInfo(id, signal)
    return { title: `专辑《${a.album.name}》- ${a.album.artists.join(' / ')}`, count: a.tracks.length }
  }
  const ar = await artistTopTracks(id, signal)
  return { title: `${ar.name} 的热门歌曲`, count: ar.tracks.length }
}

const subscribeAdd: Command = {
  name: 'music subscribe add',
  summary: '订阅歌单 / 专辑 / 歌手：定时检查，出新歌自动下',
  usage: 'astra music subscribe add <链接|ref> [--every 24] [--quality flac] [--download-existing]',
  notes: [
    '第一次只记当前曲目作为基线，**不会**把已有的全下一遍；要连已有的也下就加 --download-existing',
    '之后每次检查只下"上次没见过的曲目"，已经在曲库里的跳过',
    '实际执行靠定时任务调 `astra music subscribe run`，本工具不常驻',
  ],
  options: {
    every: { type: 'string', description: '检查间隔小时数，1..720，默认 24', valueName: 'h' },
    quality: { type: 'string', short: 'q', description: '新歌用哪个音质档位下载', valueName: 'q' },
    'download-existing': { type: 'boolean', description: '第一次就把现有曲目也下了' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const target = await resolveTarget(positionals[0]!)
    if (target.kind === 'song' || target.kind === 'keyword') throw invalidInput('订阅只能是歌单 / 专辑 / 歌手', '给它 playlist:/album:/artist: 的链接或 ref')
    const kind = target.kind as SubscribeKind
    const every = intOf(values.every, 24, 1, 720, 'every')
    const quality = values.quality === undefined ? null : qualityOf(values.quality)
    // 先读一次，确认目标存在并拿到它的真实名字（标题只用 id 的话列表里认不出是哪个）
    const { title, count } = await describeTarget(kind, target.id, signal)
    const sub = addSubscription({ kind, targetId: target.id, title, everyHours: every, quality })
    const result = await runSubscription(sub, { baselineOnly: values['download-existing'] !== true, signal, force: true })
    return { data: { subscription: subView(findSubscription(sub.id)), preview: { tracks: count }, baseline: result.baseline, note: result.note, jobId: result.jobId } }
  },
}

const subscribeList: Command = {
  name: 'music subscribe list',
  summary: '列出订阅及其状态',
  usage: 'astra music subscribe list [--runs]',
  options: { runs: { type: 'boolean', description: '附上最近 5 次运行记录' } },
  maxArgs: 0,
  async run({ values }) {
    const subs = listSubscriptions()
    return {
      data: {
        subscriptions: subs.map((s) => ({ ...subView(s), ...(values.runs === true ? { runs: recentRuns(s.id, 5) } : {}) })),
        due: dueSubscriptions().map((s) => s.id),
      },
    }
  },
}

const subscribeSet: Command = {
  name: 'music subscribe set',
  summary: '改订阅：间隔 / 启停 / 音质',
  usage: 'astra music subscribe set <id> [--every 24] [--enable] [--disable] [--quality flac]',
  options: {
    every: { type: 'string', description: '检查间隔小时数', valueName: 'h' },
    enable: { type: 'boolean', description: '启用' },
    disable: { type: 'boolean', description: '停用' },
    quality: { type: 'string', short: 'q', description: '音质档位', valueName: 'q' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values }) {
    if (values.enable === true && values.disable === true) throw invalidInput('--enable 与 --disable 不能同时给')
    const patch: Parameters<typeof setSubscription>[1] = {}
    if (values.every !== undefined) patch.everyHours = intOf(values.every, 24, 1, 720, 'every')
    if (values.enable === true) patch.enabled = true
    if (values.disable === true) patch.enabled = false
    if (values.quality !== undefined) patch.quality = qualityOf(values.quality)
    return { data: subView(setSubscription(positionals[0]!, patch)) }
  },
}

const subscribeRemove: Command = {
  name: 'music subscribe remove',
  summary: '删除订阅（已下载的文件不动）',
  usage: 'astra music subscribe remove <id>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    return { data: { removed: removeSubscription(positionals[0]!) } }
  },
}

const subscribeRun: Command = {
  name: 'music subscribe run',
  summary: '检查到点的订阅并下载新歌（给定时任务调）',
  usage: 'astra music subscribe run [--all] [--id <id>]',
  notes: [
    '不带参数时只处理"到点的"（上次检查超过间隔的）；--all 强制全部检查一遍',
    '--id 只跑指定的一个（不看是否到点）',
    '建议 cron 每小时调一次：`0 * * * * astra music subscribe run`',
  ],
  options: {
    all: { type: 'boolean', description: '忽略间隔，全部检查一遍' },
    id: { type: 'string', description: '只跑指定订阅', valueName: 'id' },
  },
  maxArgs: 0,
  async run({ values, signal }) {
    const subs = values.id !== undefined
      ? [findSubscription(String(values.id))]
      : values.all === true
        ? listSubscriptions().filter((s) => s.enabled)
        : dueSubscriptions()
    const results = []
    for (const sub of subs) {
      try {
        results.push(await runSubscription(sub, { signal }))
      } catch (err) {
        results.push({ subscriptionId: sub.id, title: sub.title, error: (err as Error).message })
      }
    }
    const jobs = results.filter((r) => 'jobId' in r && r.jobId).length
    return { data: { checked: subs.length, jobsStarted: jobs, results } }
  },
}

const coversCmd: Command = {
  name: 'music covers',
  summary: '给每张专辑目录补一张 cover.jpg（从文件内嵌封面提取，不联网）',
  usage: 'astra music covers',
  notes: [
    '已有 cover.jpg 的会跳过；文件里没有内嵌封面的会列在 failed 里',
    'Navidrome 等播放器按专辑浏览时就有了封面，不再是空白',
  ],
  maxArgs: 0,
  async run({ signal }) {
    const result = await archiveAlbumCovers(signal)
    return {
      data: result,
      warnings: result.failed.length > 0 ? [`${result.failed.length} 张没取到（多半是文件里没内嵌封面）`] : [],
    }
  },
}

const m3uCmd: Command = {
  name: 'music m3u',
  summary: '把曲库导出成 M3U8 播放列表',
  usage: 'astra music m3u <输出路径> [--keyword 关键词] [--relative]',
  notes: [
    '用 M3U8（UTF-8）而不是 M3U：中文路径在 M3U 里常被按本地编码读成乱码',
    '--relative 写相对路径（播放列表和音乐目录一起搬走时用）',
  ],
  options: {
    keyword: { type: 'string', description: '只导出匹配的曲目', valueName: 'kw' },
    relative: { type: 'boolean', description: '写相对路径' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    void signal
    const result = await exportM3u({
      output: positionals[0]!,
      ...(typeof values.keyword === 'string' ? { keyword: values.keyword } : {}),
      relative: values.relative === true,
    })
    return { data: result }
  },
}

const upgrade: Command = {
  name: 'music upgrade',
  summary: '找出真正能升级音质的歌，并可批量重下',
  usage: 'astra music upgrade [--scan 20] [--apply] [--limit 20]',
  notes: [
    '与 `have --low` 的区别：`--low` 只按库里的规格列（会被"母带本来就是 16bit"误导），',
    '这里会真的问一次"现在能拿到什么"，确实更好才算可升级',
    '扫描每首要打一次接口（不下载），所以 --scan 控制最多查几首',
    '--apply 把找到的候选开成后台任务重下；不加只列清单',
  ],
  options: {
    scan: { type: 'string', description: '最多扫多少首，默认 20', valueName: 'n' },
    apply: { type: 'boolean', description: '把找到的开成下载任务' },
    limit: { type: 'string', short: 'n', description: '最多列几条，默认 20', valueName: 'n' },
    quality: { type: 'string', short: 'q', description: '配合 --apply 的请求音质', valueName: 'q' },
  },
  maxArgs: 0,
  async run({ values, signal }) {
    const scanLimit = intOf(values.scan, 20, 1, 500, 'scan')
    const listLimit = intOf(values.limit, 20, 1, 500, 'limit')
    const result = await scanUpgradable(scanLimit, signal)

    if (values.apply === true) {
      if (result.candidates.length === 0) {
        return {
          data: { status: 'nothing_to_do', scanned: result.scanned, candidates: [], noUpgrade: result.noUpgrade.slice(0, listLimit) },
          warnings: ['扫描下来没有可升级的歌'],
        }
      }
      const quality = qualityOf(values.quality)
      const tracks = await loadCandidateTracks(result.candidates, signal)
      const started = startBatch('upgrade', `音质升级 ${tracks.length} 首`, quality, tracks)
      return {
        data: { ...started.data, scanned: result.scanned, upgrading: result.candidates },
        warnings: started.warnings,
      }
    }

    return {
      data: {
        status: 'scanned',
        scanned: result.scanned,
        upgradable: result.candidates.length,
        candidates: result.candidates.slice(0, listLimit),
        truncated: result.candidates.length > listLimit,
        // 没升上去的原因也给出来，免得用户以为漏了
        noUpgrade: result.noUpgrade.slice(0, Math.min(listLimit, 10)),
        // "查不了"（未登录 / 网络）和"升不了"（母带就这样）是两回事，不能都说成后者
        next: result.candidates.length > 0
          ? '确认后加 --apply 重下'
          : result.noUpgrade.every((n) => /未登录|失败|拿不到/.test(n.reason))
            ? '这轮没查成（多半是没登录或网络问题），登录后重试：`astra music login start`'
            : '这些歌的母带就这样，换源也不会更好',
      },
    }
  },
}

export const musicCommands: Command[] = [
  get, search, info, batch, have, forget,
  job, jobs, jobCancel, jobResume, worker,
  loginPlain, loginStart, loginPoll, loginWait, account, logout, playlists, daily, liked, upgrade,
  subscribeAdd, subscribeList, subscribeSet, subscribeRemove, subscribeRun,
  sourceList, sourceAdd, sourceRemove, sourceToggle(true), sourceToggle(false), sourceTest,
  coversCmd, m3uCmd,
]

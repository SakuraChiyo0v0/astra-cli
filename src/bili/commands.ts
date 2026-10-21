/**
 * `astra bili ...` 命令。
 *
 * 与音乐那边同一套取向：一条命令办完一件事，`get` 是主入口，
 * 链接 / BV 号 / 短链都吃，多分 P 的按需选择而不是一股脑全下。
 */
import { AstraError, invalidInput } from '../core/errors.ts'
import { getConfig } from '../core/config.ts'
import type { Command } from '../core/command.ts'
import { homePath } from '../core/paths.ts'
import { renderQrText, writeQrPng } from '../core/qr.ts'
import { biliSessionDigest, clearBiliSession, cookieHeader, fetchBiliAccount, loadBiliSession, pollBiliQr, saveBiliSession, startBiliQr } from './auth.ts'
import { playInfo, subtitleList, videoInfo, type VideoInfo } from './api.ts'
import { downloadPage } from './download.ts'
import { probe } from './ffmpeg.ts'
import { QUALITY_NAMES, QUALITY_ORDER, qualityName } from './sign.ts'
import { parseBiliTarget } from './target.ts'
import { parseCollectionRef, fetchFavorite, fetchSeasonArchives, fetchSeriesArchives, readSeason } from './collection.ts'
import { danmakuToAss, fetchDanmaku } from './danmaku.ts'
import { popular as fetchPopular, weeklyIssues as fetchWeeklyIssues, weeklyOne as fetchWeeklyOne } from './discover.ts'
import { watchLater, watchHistory } from './account-lists.ts'
import { httpRequest } from '../core/http.ts'

import { mediaRoot } from '../core/config.ts'
import path from 'node:path'
import { sanitizeSegment } from '../core/template.ts'
import { BILI_DOMAIN, biliJobItems, qualitySummary } from './jobs.ts'
import { cancelJob, createJob, getJob, listJobs, resumeJob, runWorker, spawnWorker, statusLabel } from '../core/jobs.ts'
import { readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs'

const PENDING_TTL_MS = 3 * 60 * 1000

/** 文件名净化：复用 core/template 的规则，别自己再写一套。 */
function safeFile(text: string): string {
  return sanitizeSegment(text, 80)
}

interface Pending { qrcodeKey: string; url: string; startedAt: number }

function pendingFile(): string {
  return homePath('bili-login-pending.json')
}

function readPending(): Pending | null {
  try {
    const p = JSON.parse(readFileSync(pendingFile(), 'utf8')) as Pending
    if (typeof p.qrcodeKey !== 'string' || Date.now() - p.startedAt > PENDING_TTL_MS) return null
    return p
  } catch {
    return null
  }
}

function formatDuration(sec: number | null): string | null {
  if (sec === null || sec <= 0) return null
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 把画质关键字解析成 qn 编号。 */
export function parseQuality(value: unknown): number {
  const text = typeof value === 'string' && value.trim() ? value.trim() : getConfig('bili.quality')
  if (/^\d+$/.test(text)) return Number(text)
  const lower = text.toLowerCase()
  for (const [qn, name] of Object.entries(QUALITY_NAMES)) {
    if (name.toLowerCase() === lower) return Number(qn)
  }
  // 常见别名
  const alias: Record<string, number> = { '4k': 120, '1080p60': 116, '1080p+': 112, '1080p': 80, '720p60': 74, '720p': 64, '480p': 32, '360p': 16 }
  if (alias[lower] !== undefined) return alias[lower]!
  throw invalidInput(`画质 ${text} 不合法`, `可用：${Object.values(QUALITY_NAMES).join(' / ')} 或 qn 数字`)
}

function videoView(info: VideoInfo) {
  return {
    bvid: info.bvid,
    title: info.title,
    uploader: info.owner.name,
    duration: formatDuration(info.duration),
    pages: info.pages.length,
    pubdate: info.pubdate ? new Date(info.pubdate * 1000).toISOString().slice(0, 10) : null,
  }
}

function pageView(info: VideoInfo, index: number) {
  const p = info.pages[index]!
  return { index, page: p.page, part: p.part, duration: formatDuration(p.duration), cid: p.cid }
}

/** 选出要下载哪几个分 P：给了 --page 就按它，否则单 P 全下、多 P 只下第一个并提示。 */
function selectPages(info: VideoInfo, rawPage: unknown): { pages: number[]; warnings: string[] } {
  const warnings: string[] = []
  if (typeof rawPage === 'string' && rawPage.trim()) {
    const pages: number[] = []
    for (const chunk of rawPage.split(',')) {
      const trimmed = chunk.trim()
      const range = trimmed.match(/^(\d+)-(\d+)$/)
      if (range) {
        const start = Number(range[1])
        const end = Number(range[2])
        if (start < 1 || end > info.pages.length || start > end) throw invalidInput(`分 P 范围 ${trimmed} 不合法`, `这个视频有 ${info.pages.length} 个分 P`)
        for (let i = start; i <= end; i += 1) if (!pages.includes(i - 1)) pages.push(i - 1)
        continue
      }
      const n = Number(trimmed)
      if (!Number.isInteger(n) || n < 1 || n > info.pages.length) throw invalidInput(`分 P ${trimmed} 不合法`, `这个视频有 ${info.pages.length} 个分 P`)
      if (!pages.includes(n - 1)) pages.push(n - 1)
    }
    return { pages: pages.sort((a, b) => a - b), warnings }
  }
  if (info.pages.length <= 1) return { pages: [0], warnings }
  // 多分 P 不替用户全下：可能是 200 集的番剧
  warnings.push(`这个视频有 ${info.pages.length} 个分 P，这次只下第 1 个；要别的用 --page 指定（如 --page 2,5-8）`)
  return { pages: [0], warnings }
}

const get: Command = {
  name: 'bili get',
  summary: '下载 B 站视频：BV 号 / 链接 / 短链都行，多分 P 用 --page 指定',
  usage: 'astra bili get <BV号|链接> [--page 1,3-5] [--quality 1080p] [--audio-only]',
  notes: [
    'data.status 是 downloaded；多分 P 时 results 里每个分 P 一条结果',
    'downgraded=true 表示服务端给的画质低于请求的——未登录时一定封顶 360P',
    '短链（b23.tv）会先展开；带分 P 参数的链接会直接定位到那一 P',
  ],
  options: {
    page: { type: 'string', description: '分 P：1 / 2,5 / 3-8', valueName: 'pages' },
    quality: { type: 'string', short: 'q', description: '画质：4k / 1080p60 / 1080p / 720p / 480p / 360p', valueName: 'q' },
    'audio-only': { type: 'boolean', description: '只要音频（m4a），不下视频' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const target = await parseBiliTarget(positionals[0]!, signal)
    if (target.kind !== 'video') throw invalidInput('这不是一个可下载的视频', '试试 BV 号或视频链接')
    const info = await videoInfo(target.bvid, signal)
    const quality = parseQuality(values.quality)
    const { pages, warnings } = selectPages(info, values.page)

    const results = []
    for (const index of pages) {
      const result = await downloadPage(info, index, { quality, audioOnly: values['audio-only'] === true, signal })
      warnings.push(...result.warnings)
      results.push(result)
    }
    return {
      data: {
        status: 'downloaded',
        video: videoView(info),
        results: results.length === 1 ? results[0] : results,
        ...(results.length > 1 ? { count: results.length } : {}),
      },
      warnings,
    }
  },
}

const info: Command = {
  name: 'bili info',
  summary: '看视频信息与分 P 列表，不下载',
  usage: 'astra bili info <BV号|链接> [--probe]',
  notes: ['加 --probe 会顺便查一次播放地址，看实际能拿到什么画质（不下载）'],
  options: { probe: { type: 'boolean', description: '查一下服务端实际给什么画质' } },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const target = await parseBiliTarget(positionals[0]!, signal)
    if (target.kind !== 'video') throw invalidInput('需要一个视频的 BV 号或链接')
    const v = await videoInfo(target.bvid, signal)
    const data: Record<string, unknown> = {
      ...videoView(v),
      desc: v.desc.slice(0, 200) || null,
      pageList: v.pages.map((_, i) => pageView(v, i)),
    }
    if (values.probe === true) {
      const play = await playInfo(v.bvid, v.pages[0]!.cid, parseQuality(undefined), signal)
      data.stream = {
        quality: play.qualityLabel,
        accept: play.acceptQuality.map((q) => qualityName(q)),
        videoStreams: play.videos.map((s) => ({ quality: qualityName(s.id), codecs: s.codecs, size: `${s.width}x${s.height}`, bandwidth: s.bandwidth })),
        audioStreams: play.audios.map((s) => ({ codecs: s.codecs, bandwidth: s.bandwidth })),
      }
    }
    return { data }
  },
}

const loginStart: Command = {
  name: 'bili login start',
  summary: 'B 站扫码登录：返回二维码图片，登录后才能拿到高画质',
  usage: 'astra bili login start',
  notes: [
    '二维码用 data.qrImage（PNG 路径）发给用户；发不了图再用 data.qrText',
    '然后每 2~3 秒调 `astra bili login poll`，直到 status 不是 pending',
    '未登录也能下载，但画质封顶 360P；登录 + 大会员才可能到 1080P60 / 4K / HDR',
  ],
  maxArgs: 0,
  async run({ signal }) {
    const { qrcodeKey, url } = await startBiliQr(signal)
    writeFileSync(pendingFile(), JSON.stringify({ qrcodeKey, url, startedAt: Date.now() }), { encoding: 'utf8', mode: 0o600 })
    chmodSync(pendingFile(), 0o600)
    const image = writeQrPng(url, homePath('bili-login-qr.png'), { scale: 8, margin: 4 })
    const text = renderQrText(url)
    return {
      data: {
        status: 'pending',
        qrImage: image.path,
        qrImageSize: image.size,
        qrText: text.art,
        expiresInSeconds: Math.round(PENDING_TTL_MS / 1000),
        next: '把 data.qrImage 这张 PNG 发给用户（用 MEDIA 标记，不要打成代码块）；然后每 2~3 秒调 `astra bili login poll`',
      },
    }
  },
}

const loginPoll: Command = {
  name: 'bili login poll',
  summary: '查一次 B 站扫码状态（不阻塞）',
  usage: 'astra bili login poll',
  maxArgs: 0,
  async run({ signal }) {
    const pending = readPending()
    if (!pending) {
      const existing = loadBiliSession()
      if (existing) {
        return { data: { status: 'done', account: { uid: existing.uid, nickname: existing.nickname, vip: existing.vip, digest: biliSessionDigest(existing) }, next: '已经是登录状态' } }
      }
      throw new AstraError('NO_PENDING_LOGIN', '没有正在进行的登录', { exitCode: 2, hint: '先执行 `astra bili login start`' })
    }
    const result = await pollBiliQr(pending.qrcodeKey, signal)
    if (result.state === 'success' && result.cookie) {
      const draft = { cookie: result.cookie, uid: null, nickname: null, vip: null, savedAt: new Date().toISOString() }
      let account: { uid: string | null; nickname: string | null; vip: boolean } = { uid: null, nickname: null, vip: false }
      try {
        account = await fetchBiliAccount(draft, signal)
      } catch {
        // 账号信息拿不到不影响会话本身
      }
      const session = { ...draft, ...account }
      saveBiliSession(session)
      if (existsSync(pendingFile())) rmSync(pendingFile(), { force: true })
      return {
        data: {
          status: 'done',
          account: { uid: account.uid, nickname: account.nickname, vip: account.vip, digest: biliSessionDigest(session) },
          next: account.vip ? '登录完成（大会员）。可以拿 1080P60 / 4K' : '登录完成。画质上限取决于账号权限',
        },
      }
    }
    if (result.state === 'expired' && existsSync(pendingFile())) rmSync(pendingFile(), { force: true })
    const next = result.state === 'waiting' ? '用户在 B 站 App 里扫码。过几秒再 poll'
      : result.state === 'scanned' ? '已扫码，等用户在手机上确认。过几秒再 poll'
      : result.state === 'expired' ? '二维码过期，重新 `astra bili login start`'
      : '上游返回了没见过的码，重新 start；一直这样就说明协议变了'
    return { data: { status: result.state === 'expired' ? 'expired' : result.state === 'unknown' ? 'unknown' : 'pending', state: result.state, code: result.code, message: result.message, next } }
  },
}

const account: Command = {
  name: 'bili account',
  summary: '看 B 站登录状态与大会员',
  usage: 'astra bili account',
  maxArgs: 0,
  async run({ signal }) {
    const session = loadBiliSession()
    if (!session) return { data: { loggedIn: false, note: '未登录时下载画质封顶 360P' } }
    try {
      const info = await fetchBiliAccount(session, signal)
      return { data: { loggedIn: true, uid: info.uid, nickname: info.nickname, vip: info.vip, digest: biliSessionDigest(session), savedAt: session.savedAt, stale: false } }
    } catch {
      return { data: { loggedIn: true, uid: session.uid, nickname: session.nickname, vip: session.vip, digest: biliSessionDigest(session), savedAt: session.savedAt, stale: true } }
    }
  },
}

const logout: Command = {
  name: 'bili logout',
  summary: '清除 B 站登录会话',
  usage: 'astra bili logout',
  maxArgs: 0,
  async run() {
    return { data: { loggedOut: clearBiliSession() } }
  },
}

const subtitle: Command = {
  name: 'bili subtitle',
  summary: '把某分 P 的字幕存成文件（需要登录；UP 主没传字幕就没有）',
  usage: 'astra bili subtitle <BV号|链接> [--page 1] [--out 路径]',
  notes: ['返回每份字幕的语言与文件路径；默认落在视频目录旁边的 .srt 不可用时退回 .json'],
  options: {
    page: { type: 'string', description: '分 P，默认 1', valueName: 'n' },
    out: { type: 'string', description: '输出目录，默认 <ASTRA_HOME>/video/subtitles', valueName: 'dir' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const target = await parseBiliTarget(positionals[0]!, signal)
    if (target.kind !== 'video') throw invalidInput('需要一个视频的 BV 号或链接')
    const info = await videoInfo(target.bvid, signal)
    const index = Math.max(0, Number(values.page ?? '1') - 1)
    const page = info.pages[index]
    if (!page) throw invalidInput(`没有第 ${index + 1} 个分 P`, `这个视频有 ${info.pages.length} 个分 P`)
    const subs = await subtitleList(info.bvid, page.cid, signal)
    if (subs.length === 0) {
      return { data: { bvid: info.bvid, page: page.page, subtitles: [] }, warnings: ['这个分 P 没有字幕（UP 主没传，或需要登录）'] }
    }
    const dir = typeof values.out === 'string' && values.out ? values.out : homePath('video', 'subtitles')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    const written: { lan: string; name: string; path: string; cues: number }[] = []
    for (const sub of subs) {
      const response = await fetch(sub.url, { signal: signal ?? undefined })
      if (!response.ok) continue
      const body = (await response.json()) as { body?: { from: number; to: number; content: string }[] }
      const cues = body.body ?? []
      const file = `${info.bvid}-P${page.page}-${sub.lan}.srt`
      const path = `${dir}/${file}`
      await writeFile(path, toSrt(cues), 'utf8')
      written.push({ lan: sub.lan, name: sub.lanDoc, path, cues: cues.length })
    }
    return { data: { bvid: info.bvid, page: page.page, subtitles: written } }
  },
}

function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const milli = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`
}

export function toSrt(cues: { from: number; to: number; content: string }[]): string {
  return cues
    .map((cue, i) => `${i + 1}\n${srtTime(cue.from)} --> ${srtTime(cue.to)}\n${cue.content.trim()}\n`)
    .join('\n')
}

const doctor: Command = {
  name: 'bili doctor',
  summary: 'B 站能力自检：网络、登录、ffmpeg',
  usage: 'astra bili doctor',
  maxArgs: 0,
  async run() {
    const checks: { name: string; ok: boolean; detail: string }[] = []
    try {
      const v = await videoInfo('BV17x411w7KC')
      checks.push({ name: 'api', ok: true, detail: `详情接口正常（${v.title.slice(0, 20)}）` })
    } catch (err) {
      checks.push({ name: 'api', ok: false, detail: (err as Error).message })
    }
    const session = loadBiliSession()
    if (!session) {
      checks.push({ name: 'login', ok: false, detail: '未登录，画质封顶 360P' })
    } else {
      try {
        const a = await fetchBiliAccount(session)
        checks.push({ name: 'login', ok: true, detail: `${a.nickname ?? a.uid}${a.vip ? '（大会员）' : ''}` })
      } catch {
        checks.push({ name: 'login', ok: false, detail: '会话失效，需要重新扫码' })
      }
    }
    const probed = await probe(homePath('bili-doctor-probe.mp4'), getConfig('music.ffmpeg')).catch(() => null)
    checks.push({ name: 'ffmpeg', ok: probed !== null, detail: probed !== null ? '可用' : '找不到 ffmpeg（合并音视频必需）' })
    return { data: { ok: checks.every((c) => c.name === 'login' ? true : c.ok), checks } }
  },
}

const bulk: Command = {
  name: 'bili bulk',
  summary: '批量下载：收藏夹 / 视频合集 / 一个视频的多个分 P',
  usage: 'astra bili bulk <fav:id|收藏夹链接|合集链接> [--limit 50] [--quality 1080p] [--all-pages]',
  notes: [
    '收藏夹：`fav:<id>` 或 favlist 链接（需登录看私密收藏夹）',
    '合集：collectiondetail?sid=<id> 链接，或 `season:<sid>` / `collection:<sid>`',
    '系列：seriesdetail?sid=<id> 链接，或 `series:<mid>/<sid>`',
    '给普通视频链接时，--all-pages 会把它的所有分 P 都排进任务',
    '开的是后台任务，用 `astra bili job <id>` 看进度',
    '**不支持按 UP 主主页批量**：B 站的 UP 投稿接口会返回风控页，硬啃只会一直失败',
  ],
  options: {
    limit: { type: 'string', short: 'n', description: '最多取几个视频，默认 50', valueName: 'n' },
    quality: { type: 'string', short: 'q', description: '画质', valueName: 'q' },
    'all-pages': { type: 'boolean', description: '普通视频：把所有分 P 都加进任务' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const input = positionals[0]!
    const limit = Number(values.limit ?? '50')
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw invalidInput('--limit 必须是 1..500')
    const quality = parseQuality(values.quality)

    // 收藏夹 / 合集：两种"一组视频"，先看是哪一种
    const ref = parseCollectionRef(input)
    if (ref.kind !== null) {
      const collection = ref.kind === 'fav'
        ? await fetchFavorite(ref.id, limit, signal)
        : ref.kind === 'series'
          ? await fetchSeriesArchives(ref.mid, ref.seriesId, limit, signal)
          : await fetchSeasonArchives(ref.mid, ref.seasonId, limit, signal)
      const label = ref.kind === 'fav' ? '收藏夹' : ref.kind === 'series' ? '系列' : '合集'
      const items = collection.items.map((v) => ({
        id: v.bvid,
        title: v.title,
        subtitle: collection.title,
        meta: { bvid: v.bvid, pageIndex: 0, quality, singlePage: true },
      }))
      if (items.length === 0) {
        throw new AstraError('EMPTY_COLLECTION', `${label}「${collection.title}」里没有可下载的视频`, { exitCode: 4 })
      }
      const job = createJob({ domain: BILI_DOMAIN, kind: ref.kind, title: `${label}「${collection.title}」`, profile: qualityName(quality), items })
      spawnWorker(BILI_DOMAIN, job.id)
      return {
        data: {
          status: 'job_started',
          job: { id: job.id, title: collection.title, total: items.length, platformTotal: collection.total },
          preview: collection.items.slice(0, 5).map((v) => ({ bvid: v.bvid, title: v.title })),
        },
      }
    }

    // 普通视频：可选全部分 P
    const target = await parseBiliTarget(input, signal)
    if (target.kind !== 'video') throw invalidInput('认不出这是什么', '收藏夹用 `fav:<id>`，或者给视频链接')
    const info = await videoInfo(target.bvid, signal)

    // 视频合集：详情里自带 ugc_season
    const season = (info as unknown as { ugc_season?: unknown }).ugc_season
    if (season) {
      const parsed = readSeason({ ugc_season: info as never })
      if (parsed) {
        const items = parsed.items.slice(0, limit).map((v) => ({
          id: v.bvid, title: v.title, subtitle: parsed.title,
          meta: { bvid: v.bvid, pageIndex: 0, quality, singlePage: true },
        }))
        const job = createJob({ domain: BILI_DOMAIN, kind: 'season', title: `合集「${parsed.title}」`, profile: qualityName(quality), items })
        spawnWorker(BILI_DOMAIN, job.id)
        return { data: { status: 'job_started', job: { id: job.id, title: parsed.title, total: items.length }, preview: parsed.items.slice(0, 5).map((v) => ({ bvid: v.bvid, title: v.title })) } }
      }
    }

    if (values['all-pages'] !== true) {
      throw invalidInput('这个视频没有合集，也不是收藏夹', '想要它的全部分 P 就加 --all-pages')
    }
    const items = (await biliJobItems(info.bvid, info.pages.map((_, i) => i), quality))
    const job = createJob({ domain: BILI_DOMAIN, kind: 'pages', title: info.title, profile: qualityName(quality), items })
    spawnWorker(BILI_DOMAIN, job.id)
    return { data: { status: 'job_started', job: { id: job.id, title: info.title, total: items.length }, preview: items.slice(0, 5).map((i) => ({ title: i.title })) } }
  },
}

const jobCmd: Command = {
  name: 'bili job',
  summary: '看 B 站批量任务进度',
  usage: 'astra bili job <id> [--items] [--failed] [--wait 60]',
  options: {
    items: { type: 'boolean', description: '列出每一项' },
    failed: { type: 'boolean', description: '只列失败的' },
    wait: { type: 'string', description: '最多等待秒数（≤600）', valueName: 's' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const id = positionals[0]!
    const waitSeconds = Number(values.wait ?? '0')
    const deadline = Date.now() + (Number.isFinite(waitSeconds) ? waitSeconds : 0) * 1000
    let snapshot = getJob(id, false, BILI_DOMAIN)
    while (waitSeconds > 0 && Date.now() < deadline && !signal.aborted && ['queued', 'running'].includes(snapshot.job.status)) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      snapshot = getJob(id, false, BILI_DOMAIN)
    }
    const full = getJob(id, true, BILI_DOMAIN)
    const items = values.failed === true ? full.items?.filter((i) => i.status === 'failed') : full.items
    return {
      data: {
        ...full.job,
        statusLabel: statusLabel(full.job.status),
        quality: qualitySummary(full.items ?? []) || null,
        ...(values.items === true || values.failed === true ? { items } : {}),
      },
    }
  },
}

const jobList: Command = {
  name: 'bili jobs',
  summary: '最近的 B 站批量任务',
  usage: 'astra bili jobs [--active] [--limit 10]',
  options: {
    active: { type: 'boolean', description: '只看进行中的' },
    limit: { type: 'string', short: 'n', description: '默认 10', valueName: 'n' },
  },
  maxArgs: 0,
  async run({ values }) {
    const limit = Number(values.limit ?? '10')
    return { data: { jobs: listJobs(limit, values.active === true, BILI_DOMAIN).map((j) => ({ ...j, statusLabel: statusLabel(j.status) })) } }
  },
}

const jobCancel: Command = {
  name: 'bili job cancel',
  summary: '取消 B 站批量任务',
  usage: 'astra bili job cancel <id>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const j = cancelJob(positionals[0]!, BILI_DOMAIN)
    return { data: { ...j, statusLabel: statusLabel(j.status) } }
  },
}

const jobResume: Command = {
  name: 'bili job resume',
  summary: '继续 / 重试 B 站批量任务',
  usage: 'astra bili job resume <id>',
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    const j = resumeJob(positionals[0]!, BILI_DOMAIN)
    return { data: { ...j, statusLabel: statusLabel(j.status) } }
  },
}

const workerCmd: Command = {
  name: 'bili _worker',
  summary: '（内部）B 站批量任务执行体',
  usage: 'astra bili _worker <id>',
  hidden: true,
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals }) {
    await runWorker(BILI_DOMAIN, positionals[0]!)
    return { data: getJob(positionals[0]!, false, BILI_DOMAIN).job }
  },
}

const danmaku: Command = {
  name: 'bili danmaku',
  summary: '下载弹幕并存成 ASS 字幕（可跟着视频一起看）',
  usage: 'astra bili danmaku <BV号|链接> [--page 1] [--out 路径] [--raw] [--max 3]',
  notes: [
    '默认转成 ASS（带颜色、描边、滚动效果），和视频放一起改成同名即被播放器自动加载',
    '--raw 存原始 XML（不转换，体积更小但播放器不认）',
    '默认只保留滚动弹幕，过滤底部/顶部固定弹幕；同一时间窗最多合并 3 条，避免刷屏',
  ],
  options: {
    page: { type: 'string', description: '分 P，默认 1', valueName: 'n' },
    out: { type: 'string', description: '输出路径（.ass 或 .xml）', valueName: 'path' },
    raw: { type: 'boolean', description: '存原始 XML 而不是 ASS' },
    max: { type: 'string', description: '每条字幕最多几条弹幕，默认 3', valueName: 'n' },
    all: { type: 'boolean', description: '保留顶部/底部固定弹幕（默认只留滚动的）' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const target = await parseBiliTarget(positionals[0]!, signal)
    if (target.kind !== 'video') throw invalidInput('需要一个视频的 BV 号或链接')
    const info = await videoInfo(target.bvid, signal)
    const index = Math.max(0, Number(values.page ?? '1') - 1)
    const page = info.pages[index]
    if (!page) throw invalidInput(`没有第 ${index + 1} 个分 P`, `这个视频有 ${info.pages.length} 个分 P`)

    const items = await fetchDanmaku(page.cid, {
      scrollOnly: values.all !== true,
      ...(signal ? { signal } : {}),
    })
    if (items.length === 0) {
      return { data: { bvid: info.bvid, page: page.page, count: 0, output: null }, warnings: ['这个分 P 没有弹幕'] }
    }

    const dir = mediaRoot()
    const base = path.join(dir, info.owner.name || '未知UP', info.title)
    const suffix = info.pages.length > 1 ? `-P${page.page}` : ''
    const raw = values.raw === true
    const output = typeof values.out === 'string' && values.out
      ? values.out
      : path.join(base, `${safeFile(info.title)}${suffix}.${raw ? 'xml' : 'ass'}`)

    const maxPerLine = Math.max(1, Math.min(10, Number(values.max ?? '3') || 3))
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(path.dirname(output), { recursive: true })
    if (raw) {
      // 原始 XML 用接口原文，不重新拼
      const session = loadBiliSession()
      const response = await httpRequest(`https://api.bilibili.com/x/v1/dm/list.so?oid=${page.cid}`, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
          referer: 'https://www.bilibili.com/',
          ...(session ? { cookie: cookieHeader(session) } : {}),
        },
        timeoutMs: 20_000,
        retries: 1,
      })
      await writeFile(output, await response.text(), 'utf8')
    } else {
      await writeFile(output, danmakuToAss(items, {
        width: 1920,
        height: 1080,
        maxPerLine,
        maxItems: 1200,
      }), 'utf8')
    }
    return {
      data: {
        bvid: info.bvid,
        page: page.page,
        title: info.title,
        count: items.length,
        format: raw ? 'xml' : 'ass',
        output,
        hint: raw ? null : '把文件改成和视频同名（如 `01 xxx.ass`）放在同一目录，播放器会自动加载',
      },
    }
  },
}

const popular: Command = {
  name: 'bili popular',
  summary: '综合热门：列出当前热门视频',
  usage: 'astra bili popular [--limit 20]',
  notes: ['每项带 bvid，可以直接 `astra bili get <bvid>` 下载'],
  options: { limit: { type: 'string', short: 'n', description: '默认 20，最多 50', valueName: 'n' } },
  maxArgs: 0,
  async run({ values, signal }) {
    const limit = Math.max(1, Math.min(50, Number(values.limit ?? '20') || 20))
    const items = await fetchPopular(limit, signal)
    return { data: { total: items.length, items: items.map((v) => ({ ...v, duration: formatDuration(v.durationSec) })) } }
  },
}

const weekly: Command = {
  name: 'bili weekly',
  summary: '每周必看：列出某一期（默认最新）的视频',
  usage: 'astra bili weekly [--issue 394] [--list]',
  notes: ['--list 只列期数；不给 --issue 时取最新一期'],
  options: {
    issue: { type: 'string', description: '期数编号', valueName: 'n' },
    list: { type: 'boolean', description: '只列所有期数，不取具体视频' },
  },
  maxArgs: 0,
  async run({ values, signal }) {
    if (values.list === true) {
      const issues = await fetchWeeklyIssues(signal)
      return { data: { total: issues.length, issues: issues.slice(0, 50) } }
    }
    const issue = values.issue === undefined ? null : Number(values.issue)
    if (issue !== null && (!Number.isInteger(issue) || issue < 1)) throw invalidInput('--issue 必须是正整数')
    const result = await fetchWeeklyOne(issue, signal)
    return {
      data: {
        issue: result.issue,
        total: result.items.length,
        items: result.items.map((v) => ({ ...v, duration: formatDuration(v.durationSec) })),
      },
    }
  },
}

const watchLaterCmd: Command = {
  name: 'bili later',
  summary: '稍后再看：列出或批量下载（需登录）',
  usage: 'astra bili later [--download] [--quality 1080p]',
  notes: [
    '不带 --download 只列出来；带上就开后台任务全下',
    '每项带 bvid，也可单独 `astra bili get <bvid>`',
  ],
  options: {
    download: { type: 'boolean', description: '把整个稍后再看开成下载任务' },
    quality: { type: 'string', short: 'q', description: '配合 --download 的画质', valueName: 'q' },
  },
  maxArgs: 0,
  async run({ values, signal }) {
    const items = await watchLater(signal)
    if (items.length === 0) return { data: { total: 0, items: [] }, warnings: ['稍后再看是空的'] }
    if (values.download === true) {
      const quality = parseQuality(values.quality)
      const jobItems = items.map((v) => ({ id: v.bvid, title: v.title, subtitle: '稍后再看', meta: { bvid: v.bvid, pageIndex: 0, quality, singlePage: true } }))
      const job = createJob({ domain: BILI_DOMAIN, kind: 'later', title: '稍后再看', profile: qualityName(quality), items: jobItems })
      spawnWorker(BILI_DOMAIN, job.id)
      return { data: { status: 'job_started', job: { id: job.id, title: '稍后再看', total: items.length }, preview: items.slice(0, 5).map((v) => ({ bvid: v.bvid, title: v.title })) } }
    }
    return { data: { total: items.length, items: items.map((v) => ({ ...v, duration: formatDuration(v.durationSec) })) } }
  },
}

const historyCmd: Command = {
  name: 'bili history',
  summary: '观看历史：列出最近的（需登录）',
  usage: 'astra bili history [--limit 20] [--download]',
  notes: ['只要视频，不含直播和专栏；--download 开后台任务批量下'],
  options: {
    limit: { type: 'string', short: 'n', description: '默认 20，最多 100', valueName: 'n' },
    download: { type: 'boolean', description: '把列出的这些开成下载任务' },
    quality: { type: 'string', short: 'q', description: '配合 --download 的画质', valueName: 'q' },
  },
  maxArgs: 0,
  async run({ values, signal }) {
    const limit = Math.max(1, Math.min(100, Number(values.limit ?? '20') || 20))
    const items = await watchHistory(limit, signal)
    if (values.download === true) {
      if (items.length === 0) throw new AstraError('EMPTY_HISTORY', '观看历史是空的', { exitCode: 4 })
      const quality = parseQuality(values.quality)
      const jobItems = items.map((v) => ({ id: v.bvid, title: v.title, subtitle: '观看历史', meta: { bvid: v.bvid, pageIndex: 0, quality, singlePage: true } }))
      const job = createJob({ domain: BILI_DOMAIN, kind: 'history', title: '观看历史', profile: qualityName(quality), items: jobItems })
      spawnWorker(BILI_DOMAIN, job.id)
      return { data: { status: 'job_started', job: { id: job.id, title: '观看历史', total: items.length } } }
    }
    return {
      data: {
        total: items.length,
        items: items.map((v) => ({
          ...v,
          duration: formatDuration(v.durationSec),
          viewedAt: v.viewedAt ? new Date(v.viewedAt * 1000).toISOString().slice(0, 16).replace('T', ' ') : null,
        })),
      },
    }
  },
}

export const biliCommands: Command[] = [
  get, info, subtitle, danmaku, popular, weekly, watchLaterCmd, historyCmd, bulk,
  jobCmd, jobList, jobCancel, jobResume, workerCmd,
  loginStart, loginPoll, account, logout, doctor,
]
export { QUALITY_ORDER }

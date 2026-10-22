/**
 * 单个分 P 的下载：取流 → 下视频 → 下音频 → ffmpeg 合并 → 核验。
 *
 * 与音乐那边一致的原则：
 * - 只信实测（下完用 ffprobe 核时长和流）
 * - 失败不在目标目录留半截文件
 * - 画质是"服务端实际给的"，不是请求的；没达到要如实标 downgraded
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { AstraError } from '../core/errors.ts'
import { getConfig, mediaRoot, musicRoot } from '../core/config.ts'
import { httpRequest } from '../core/http.ts'
import { progress } from '../core/output.ts'
import { loadBiliSession, cookieHeader } from './auth.ts'
import { playInfo, videoInfo, type DashStream, type PlayInfo, type VideoInfo } from './api.ts'
import { mux, probe } from './ffmpeg.ts'
import { audioTargetFormat, processBiliAudio } from './audio-tag.ts'
import { qualityName } from './sign.ts'
import { renderTemplate, resolveInside } from '../core/template.ts'
import { resolveSidecars, writeSidecars } from './sidecar.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
/** B 站 CDN 对 Referer 有校验，且分片下载可能慢，给足时间。 */
const DOWNLOAD_TIMEOUT_MS = 300_000

export interface DownloadOptions {
  /** 请求画质（会被服务端封顶）。 */
  quality: number
  /** 只取音频。 */
  audioOnly?: boolean
  /**
   * 只取音频时落到哪儿。默认 `music`（音乐根目录 + `music.template`）。
   *
   * 为什么默认进音乐库：同一批音频不该有两套命名规则。
   * 以前 `--audio-only` 落 `bili.dir` + `bili.template`，想进音乐库就得
   * "先临时改 bili.dir、下完再手工搬" —— 那个流程存在的唯一原因就是这条限制。
   * `--to bili` 是显式出口：确实想按视频模板归档音频时用。
   */
  audioTo?: 'music' | 'bili'
  /**
   * 下载完成后生成哪些伴生文件。不给就用配置 `bili.sidecar`。
   * 空数组 = 不生成（默认）。
   */
  sidecars?: SidecarKind[]
  signal?: AbortSignal
}

/** 伴生文件：跟视频同名的 .Metadata.nfo / .jpg / .Danmaku.ass。 */
export type SidecarKind = 'nfo' | 'cover' | 'danmaku'

export interface DownloadResult {
  status: 'downloaded'
  bvid: string
  page: number
  title: string
  part: string
  path: string
  requestedQuality: number
  actualQuality: number
  actualQualityLabel: string
  downgraded: boolean
  durationSec: number | null
  width: number | null
  height: number | null
  videoCodec: string | null
  audioCodec: string | null
  /** 音频文件里内嵌了封面（ffprobe 会把它报成视频流）。 */
  coverEmbedded: boolean
  bytes: number
  /** 生成的伴生文件（空 = 没生成）。 */
  sidecars: SidecarKind[]
  warnings: string[]
}

/**
 * 落盘用哪个根目录、哪个模板、哪些变量。
 *
 * 抽成纯函数是因为这里的规则容易搞错，而且错了很难发现（文件会安静地
 * 落到另一个库里去）：
 * - 视频一律 `bili.dir` + `bili.template`
 * - **只取音频时进音乐库**（`music.dir` + `music.template`）——
 *   同一批音频不该有两套命名规则，否则播放器里就是两堆互不相认的文件
 * - `--to bili` 是显式出口：要按视频模板归档音频时才用
 */
export function targetPathFor(
  info: VideoInfo,
  page: VideoInfo['pages'][number],
  options: Pick<DownloadOptions, 'audioOnly' | 'audioTo'>,
  actualQuality: number,
): { root: string; template: string; vars: Record<string, string> } {
  const audio = options.audioOnly === true
  const toMusic = audio && (options.audioTo ?? 'music') === 'music'
  const multiPart = info.pages.length > 1

  if (toMusic) {
    // 音乐模板的变量集和视频那套不同（{artist}/{album}/...）。
    // B 站没有"歌手/专辑"概念，用 UP 主当艺术家、视频标题当专辑 ——
    // 与 `bili get --audio-only` 写进标签的归属保持一致（TIT2/TPE1/TALB）。
    return {
      root: musicRoot(),
      template: getConfig('music.template'),
      vars: {
        artist: safeName(info.owner.name || '未知UP'),
        artist_list: safeName(info.owner.name || '未知UP'),
        primary_artist: safeName(info.owner.name || '未知UP'),
        albumartist: safeName(info.owner.name || '未知UP'),
        album: safeName(info.title),
        title: safeName(multiPart ? page.part : info.title),
        year: String(new Date((info.pubdate || 0) * 1000).getUTCFullYear() || ''),
        track: String(page.page),
        disc: '1',
        source: 'bilibili',
        ext: audioTargetFormat(),
      },
    }
  }

  return {
    root: mediaRoot(),
    template: getConfig('bili.template'),
    vars: {
      uploader: safeName(info.owner.name || '未知UP'),
      title: safeName(info.title),
      part: multiPart ? safeName(page.part) : '',
      page: String(page.page),
      bvid: info.bvid,
      quality: qualityName(actualQuality),
      ext: audio ? audioTargetFormat() : 'mp4',
    },
  }
}

/** 同一画质有多种编码，优先 avc1（兼容性最好），其次 hevc，最后 av01。 */
function pickCodec(streams: DashStream[]): DashStream | null {
  if (streams.length === 0) return null
  const rank = (s: DashStream): number => (s.codecs.startsWith('avc') ? 0 : s.codecs.startsWith('hev') || s.codecs.startsWith('hvc') ? 1 : 2)
  return [...streams].sort((a, b) => rank(a) - rank(b) || b.bandwidth - a.bandwidth)[0] ?? null
}

async function downloadFile(url: string, dest: string, signal?: AbortSignal): Promise<number> {
  const session = loadBiliSession()
  const options: Parameters<typeof httpRequest>[1] = {
    headers: {
      'user-agent': UA,
      referer: REFERER,
      ...(session ? { cookie: cookieHeader(session) } : {}),
    },
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    retries: 1,
  }
  if (signal) options.signal = signal
  const response = await httpRequest(url, options)
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new AstraError('BILI_DOWNLOAD_FAILED', `下载媒体流返回 HTTP ${response.status}`, { exitCode: 5, retryable: true })
  }
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(dest))
  return (await stat(dest)).size
}

/** 依次试 baseUrl 和各 backupUrl：CDN 单点失败很常见。 */
async function downloadWithFallback(stream: DashStream, dest: string, signal?: AbortSignal): Promise<number> {
  const urls = [stream.baseUrl, ...stream.backupUrls].filter(Boolean)
  let lastError: unknown = null
  for (const url of urls) {
    try {
      return await downloadFile(url, dest, signal)
    } catch (err) {
      lastError = err
      await rm(dest, { force: true })
      progress('bili.download.retry', { reason: (err as Error).message.slice(0, 100) })
    }
  }
  throw new AstraError('BILI_DOWNLOAD_FAILED', `所有 CDN 都下载失败：${(lastError as Error)?.message ?? '未知'}`, { exitCode: 5, retryable: true })
}

function safeName(text: string): string {
  return text.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || '_'
}

/**
 * 一个"只取音频"的请求该怎么落到磁盘上。
 *
 * 抽成纯函数是因为这里踩过一次：durl（非 DASH 的整段流）分支忘了过音频管道，
 * 直接把**带画面的整段流**按 `.mp3` 存下来 —— 扩展名说谎，也没有标签和 BV 号。
 * 只测 `processBiliAudio` 抓不到这种错：它本来就是对的，错在调用方没调它。
 */
export type AudioPath = 'pipeline' | 'raw'

/** 只取音频时，无论整段流还是 DASH 分轨，都要走管道（转码 + 写标签）。 */
export function audioPlan(audioOnly: boolean): AudioPath {
  return audioOnly ? 'pipeline' : 'raw'
}

export async function downloadPage(
  info: VideoInfo,
  pageIndex: number,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const { signal } = options
  const warnings: string[] = []
  const page = info.pages[pageIndex]
  if (!page) throw new AstraError('BILI_NO_PAGE', `这个视频没有第 ${pageIndex + 1} 个分 P`, { exitCode: 2 })

  const play = await playInfo(info.bvid, page.cid, options.quality, signal)
  if (play.videos.length === 0 && play.durl.length === 0) {
    throw new AstraError('BILI_NO_STREAM', '没有拿到任何媒体流', { exitCode: 5, retryable: true })
  }
  if (play.durl.length > 0) {
    warnings.push('这个视频走的是整段流（非 DASH），画质选项有限')
  }

  const actualQuality = play.quality
  const downgraded = actualQuality < options.quality

  // 目标路径
  const { root, template, vars } = targetPathFor(info, page, options, actualQuality)
  const relative = renderTemplate(template, vars)
  const target = resolveInside(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  const tmpVideo = `${target}.v-${process.pid}.tmp`
  const tmpAudio = `${target}.a-${process.pid}.tmp`
  const tmpOut = `${target}.out-${process.pid}.tmp${options.audioOnly ? `.${audioTargetFormat()}` : '.mp4'}`

  try {
    const ffmpegConfigured = getConfig('music.ffmpeg')
    let bytes = 0

    // 只取音频时的"一条龙"：源流 → 目标格式 → 写标签 → 内嵌封面。
    // durl 与 DASH 两条路都要用它 —— durl 下来的是**带画面的整段流**，
    // 直接当 mp3 存会得到扩展名说谎的文件，也没有标签和 BV 号。
    const toAudio = async (source: string): Promise<void> => {
      const audioResult = await processBiliAudio({
        source,
        output: tmpOut,
        info: {
          // 多分 P 时用分 P 名 —— 那才是"这首"的名字
          title: info.pages.length > 1 ? page.part : info.title,
          uploader: info.owner.name || '未知UP',
          coverUrl: info.pic,
          pubdate: info.pubdate || null,
          bvid: info.bvid,
        },
        ...(signal ? { signal } : {}),
      })
      // 视频没给 pubdate 时不会写日期标签。播放器里就永远是空的，
      // 用户看不出原因 —— 说一句，免得以为是 astra 漏了。
      if (!info.pubdate) warnings.push('这个视频没有发布日期，音频里不会写日期标签（TDRC / DATE）')
      warnings.push(...audioResult.warnings)
    }

    if (play.durl.length > 0) {
      // 非 DASH：整段流（flv/mp4），画面和声音在同一个文件里。
      const durl = play.durl[0]!
      if (audioPlan(options.audioOnly === true) === 'pipeline') {
        // 番剧、部分老视频全走这条路，跳过管道就拿不到 BV 号
        const tmpDurl = `${target}.d-${process.pid}.tmp`
        try {
          bytes = await downloadFile(durl.url, tmpDurl, signal)
          await toAudio(tmpDurl)
        } finally {
          await rm(tmpDurl, { force: true })
        }
      } else {
        bytes = await downloadFile(durl.url, tmpOut, signal)
      }
      await rename(tmpOut, target)
    } else {
      const videoStream = pickCodec(play.videos)
      // 音频按码率挑最高
      const audioStream = [...play.audios].sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? null

      if (!videoStream && !options.audioOnly) throw new AstraError('BILI_NO_VIDEO', '没有视频流', { exitCode: 5, retryable: true })
      if (options.audioOnly && !audioStream) throw new AstraError('BILI_NO_AUDIO', '这个视频没有独立音频流', { exitCode: 5, retryable: true })

      if (videoStream && !options.audioOnly) {
        progress('bili.download.video', { quality: qualityName(videoStream.id), codecs: videoStream.codecs, bandwidth: videoStream.bandwidth })
        bytes += await downloadWithFallback(videoStream, tmpVideo, signal)
      }
      if (audioStream) {
        progress('bili.download.audio', { bandwidth: audioStream.bandwidth })
        bytes += await downloadWithFallback(audioStream, tmpAudio, signal)
      }

      if (options.audioOnly) {
        await toAudio(tmpAudio)
      } else {
        await mux(tmpVideo, audioStream ? tmpAudio : null, tmpOut, ffmpegConfigured, signal)
        if (!audioStream) warnings.push('这个视频没有音频流，成品是无声的')
      }
      await rename(tmpOut, target)
    }

    // 核验：时长对不上说明下坏了或拼错了
    const probed = await probe(target, getConfig('music.ffmpeg'), signal)
    const expectedSec = page.duration
    if (probed.durationSec !== null && expectedSec > 0 && Math.abs(probed.durationSec - expectedSec) > 10) {
      warnings.push(`成品 ${Math.round(probed.durationSec)} 秒，与分 P 记录 ${expectedSec} 秒不一致`)
    }
    if (!options.audioOnly && probed.videoCodec === null) warnings.push('成品里没有视频流')

    // 伴生文件（nfo / 封面 / 弹幕）。只对**视频**生成 —— 音频进音乐库后
    // 靠内嵌标签，不需要这几个 sidecar。
    let sidecars: SidecarKind[] = []
    if (!options.audioOnly) {
      const want = resolveSidecars(options.sidecars)
      if (want.length > 0) {
        const result = await writeSidecars(target, info, page, want, signal)
        sidecars = result.written
        warnings.push(...result.warnings)
      }
    }
    // 只下音频时，内嵌封面会被 ffprobe 报成一条 mjpeg 视频流。这不是问题，但要说清楚，
    // 否则 AI 看到 videoCodec 会以为"不是说只要音频吗，怎么下了个视频"
    const coverStream = options.audioOnly && probed.videoCodec !== null && ['mjpeg', 'png', 'bmp', 'gif', 'webp'].includes(probed.videoCodec)

    return {
      status: 'downloaded',
      bvid: info.bvid,
      page: page.page,
      title: info.title,
      part: page.part,
      path: target,
      requestedQuality: options.quality,
      actualQuality,
      actualQualityLabel: qualityName(actualQuality),
      downgraded,
      durationSec: probed.durationSec,
      width: coverStream ? null : probed.width,
      height: coverStream ? null : probed.height,
      videoCodec: coverStream ? null : probed.videoCodec,
      audioCodec: probed.audioCodec,
      /** 音频文件里内嵌了封面（ffprobe 会把它报成视频流）。 */
      coverEmbedded: coverStream === true,
      bytes: (await stat(target)).size,
      sidecars,
      warnings,
    }
  } finally {
    await rm(tmpVideo, { force: true })
    await rm(tmpAudio, { force: true })
    await rm(tmpOut, { force: true })
  }
}

export async function fetchInfo(bvid: string, signal?: AbortSignal): Promise<VideoInfo> {
  return await videoInfo(bvid, signal)
}

export type { PlayInfo }
export { playInfo }

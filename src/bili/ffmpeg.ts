/**
 * B 站下载用到的 ffmpeg 封装：合并分轨、提取音轨、探测成品。
 *
 * 执行器本身在 `media/run.ts`（媒体处理域共用）。
 */
import { AstraError } from '../core/errors.ts'
import { runFfmpeg, runFfprobe } from '../media/run.ts'

export { ffmpegPath, ffprobePath } from '../media/run.ts'

/** 把分轨的音视频合成一个文件。`-c copy` 不重编码，快且无损。 */
export async function mux(
  video: string,
  audio: string | null,
  output: string,
  configured: string,
  signal?: AbortSignal,
  metadata?: Record<string, string>,
): Promise<void> {
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  args.push('-i', video)
  if (audio) args.push('-i', audio)
  args.push('-c', 'copy', '-map', '0:v:0')
  if (audio) args.push('-map', '1:a:0')
  // 溯源标签：视频侧原来一条都不写，只能靠文件名认，改一次模板就认不出来了。
  // `-c copy` 顺带写元数据不额外花时间（不重编码），所以就在合并这一步一起做。
  // `-map_metadata -1` 先清空输入自带的元数据：B 站原片里只有一句
  // "Packed by Bilibili XCoder"，还会把 major_brand 之类的容器键复制成重复的 mdta 条目。
  args.push('-map_metadata', '-1')
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value) args.push('-metadata', `${key}=${value}`)
  }
  // mp4 里放不了某些 codec 的原生封装（例如 AV1 的某些 annexb），有明显兼容问题就转封装。
  // `use_metadata_tags` 是必须的：mp4 muxer 默认只认白名单键（title/artist/album/date…），
  // 自定义键（BILIBILI_BVID / SOURCE_ID）会被静默丢掉，写进 `mdta` 才留得住。
  args.push('-movflags', '+faststart+use_metadata_tags', output)
  const result = await runFfmpeg(configured, args, signal)
  if (result.code !== 0) {
    throw new AstraError('FFMPEG_FAILED', `ffmpeg 合并失败（退出码 ${result.code}）：${result.stderr.trim().slice(0, 300)}`, { exitCode: 5 })
  }
}

/** 只提取音轨（用于 --audio-only）。 */
export async function extractAudio(input: string, output: string, configured: string, signal?: AbortSignal): Promise<void> {
  // 音频流本来就是 m4a(aac) 时直接 copy，不是就转 aac
  const result = await runFfmpeg(configured, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-c:a', 'copy', output], signal)
  if (result.code === 0) return
  const transcode = await runFfmpeg(configured, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-c:a', 'aac', '-b:a', '192k', output], signal)
  if (transcode.code !== 0) {
    throw new AstraError('FFMPEG_FAILED', `ffmpeg 提取音轨失败：${transcode.stderr.trim().slice(0, 300)}`, { exitCode: 5 })
  }
}

export interface ProbeResult {
  durationSec: number | null
  videoCodec: string | null
  audioCodec: string | null
  width: number | null
  height: number | null
}

/** 读实际时长与流信息，判断成品是不是正常。 */
export async function probe(file: string, configured: string, signal?: AbortSignal): Promise<ProbeResult> {
  const result = await runFfprobe(configured, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', file], signal, 60_000)
  if (result.code !== 0) {
    // ffprobe 不在时不让整个下载失败：返回空，调用方当作"未知"
    return { durationSec: null, videoCodec: null, audioCodec: null, width: null, height: null }
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      format?: { duration?: string }
      streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[]
    }
    const video = parsed.streams?.find((s) => s.codec_type === 'video')
    const audio = parsed.streams?.find((s) => s.codec_type === 'audio')
    return {
      durationSec: parsed.format?.duration ? Number(parsed.format.duration) : null,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      width: video?.width ?? null,
      height: video?.height ?? null,
    }
  } catch {
    return { durationSec: null, videoCodec: null, audioCodec: null, width: null, height: null }
  }
}

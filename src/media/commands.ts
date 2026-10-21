/**
 * `astra media ...`：对本地媒体文件做加工。
 *
 * 与下载域的关系：B 站/音乐下完的东西，经常还要"只要音频""剪一段""转个能播的格式"。
 * 这里只碰**本地文件**，不联网。
 */
import path from 'node:path'
import { AstraError, invalidInput } from '../core/errors.ts'
import type { Command } from '../core/command.ts'
import { cut, extractAudio, mediaInfo, parseTime, thumbnail, transcode } from './tools.ts'

function formatDuration(sec: number | null): string | null {
  if (sec === null || sec <= 0) return null
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const info: Command = {
  name: 'media info',
  summary: '看一个本地音视频文件的实际情况（时长、编码、分辨率、码率）',
  usage: 'astra media info <文件>',
  notes: ['这是后面所有 media 命令的基础：先看清楚是什么，再决定怎么处理'],
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, signal }) {
    const info = await mediaInfo(positionals[0]!, signal)
    return {
      data: {
        ...info,
        durationLabel: formatDuration(info.durationSec),
        sizeMB: Math.round((info.bytes / 1048576) * 10) / 10,
      },
    }
  },
}

const audio: Command = {
  name: 'media audio',
  summary: '抽音轨：从视频里取音频（源是 aac 且没指定码率时直接 copy，不二次有损）',
  usage: 'astra media audio <视频> [--format aac|mp3|flac] [--bitrate 320] [--out 路径] [--overwrite]',
  notes: ['默认输出到原文件旁边，同名换扩展名；已存在时默认报错，不覆盖'],
  options: {
    format: { type: 'string', description: 'aac（默认）/ mp3 / flac', valueName: 'fmt' },
    bitrate: { type: 'string', description: '码率 kbps，aac 默认 192、mp3 默认 320', valueName: 'k' },
    out: { type: 'string', description: '输出路径', valueName: 'path' },
    overwrite: { type: 'boolean', description: '覆盖已有文件' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const bitrate = values.bitrate === undefined ? undefined : Number(values.bitrate)
    if (bitrate !== undefined && (!Number.isInteger(bitrate) || bitrate < 32 || bitrate > 2048)) throw invalidInput('--bitrate 必须是 32..2048 的整数')
    const result = await extractAudio({
      input: positionals[0]!,
      ...(typeof values.format === 'string' ? { format: values.format } : {}),
      ...(bitrate !== undefined ? { bitrateKbps: bitrate } : {}),
      ...(typeof values.out === 'string' ? { output: values.out } : {}),
      overwrite: values.overwrite === true,
      signal,
    })
    return { data: { output: result.output, info: result.info } }
  },
}

const cutCmd: Command = {
  name: 'media cut',
  summary: '裁剪一段：按起点/终点或起点+时长',
  usage: 'astra media cut <文件> [--start 12.5] [--end 30] [--duration 10] [--copy] [--out 路径]',
  notes: [
    '默认重新编码（切点精确）；加 --copy 不重编码但切点会对齐关键帧',
    '时间支持 12.5 / 1:30 / 00:01:30.5 三种写法',
  ],
  options: {
    start: { type: 'string', description: '起点', valueName: 't' },
    end: { type: 'string', description: '终点（与 --duration 二选一）', valueName: 't' },
    duration: { type: 'string', description: '时长', valueName: 't' },
    copy: { type: 'boolean', description: '不重编码（快，但切点不精确）' },
    out: { type: 'string', description: '输出路径', valueName: 'path' },
    overwrite: { type: 'boolean', description: '覆盖已有文件' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const t = (v: unknown): number | undefined => (typeof v === 'string' && v ? parseTime(v) : undefined)
    const result = await cut({
      input: positionals[0]!,
      ...(t(values.start) !== undefined ? { start: t(values.start)! } : {}),
      ...(t(values.end) !== undefined ? { end: t(values.end)! } : {}),
      ...(t(values.duration) !== undefined ? { duration: t(values.duration)! } : {}),
      copy: values.copy === true,
      ...(typeof values.out === 'string' ? { output: values.out } : {}),
      overwrite: values.overwrite === true,
      signal,
    })
    return { data: { output: result.output, info: result.info }, warnings: result.warnings }
  },
}

const transcodeCmd: Command = {
  name: 'media transcode',
  summary: '转码或换容器：改格式、改分辨率、改码率',
  usage: 'astra media transcode <文件> [--format mp4|mkv|webm] [--width 1280] [--bitrate 2000] [--out 路径]',
  notes: [
    '不给 --width / --bitrate、且容器兼容时只换容器不重编码',
    'webm 走 VP9 + Opus，体积小但编码慢',
  ],
  options: {
    format: { type: 'string', description: 'mp4（默认）/ mkv / webm', valueName: 'fmt' },
    width: { type: 'string', description: '目标宽度，高度按比例（偶数对齐）', valueName: 'px' },
    bitrate: { type: 'string', description: '视频码率 kbps；不给则用 CRF', valueName: 'k' },
    out: { type: 'string', description: '输出路径', valueName: 'path' },
    overwrite: { type: 'boolean', description: '覆盖已有文件' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const width = values.width === undefined ? undefined : Number(values.width)
    const bitrate = values.bitrate === undefined ? undefined : Number(values.bitrate)
    if (width !== undefined && (!Number.isInteger(width) || width < 16 || width > 7680)) throw invalidInput('--width 必须是 16..7680 的整数')
    if (bitrate !== undefined && (!Number.isInteger(bitrate) || bitrate < 100 || bitrate > 100000)) throw invalidInput('--bitrate 必须是 100..100000 的整数')
    const result = await transcode({
      input: positionals[0]!,
      ...(typeof values.format === 'string' ? { format: values.format } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(bitrate !== undefined ? { videoBitrateKbps: bitrate } : {}),
      ...(typeof values.out === 'string' ? { output: values.out } : {}),
      overwrite: values.overwrite === true,
      signal,
    })
    return { data: { output: result.output, info: result.info }, warnings: result.warnings }
  },
}

const thumb: Command = {
  name: 'media thumbnail',
  summary: '截一帧当封面',
  usage: 'astra media thumbnail <视频> [--at 30] [--width 1280] [--out 路径]',
  notes: ['不给 --at 时取 1/3 处 —— 开头常是黑屏或片头'],
  options: {
    at: { type: 'string', description: '取哪一秒', valueName: 't' },
    width: { type: 'string', description: '输出宽度（像素）', valueName: 'px' },
    out: { type: 'string', description: '输出路径', valueName: 'path' },
    overwrite: { type: 'boolean', description: '覆盖已有文件' },
  },
  minArgs: 1,
  maxArgs: 1,
  async run({ positionals, values, signal }) {
    const at = typeof values.at === 'string' && values.at ? parseTime(values.at) : undefined
    const width = values.width === undefined ? undefined : Number(values.width)
    if (width !== undefined && (!Number.isInteger(width) || width < 16 || width > 7680)) throw invalidInput('--width 必须是 16..7680 的整数')
    const result = await thumbnail({
      input: positionals[0]!,
      ...(at !== undefined ? { at } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(typeof values.out === 'string' ? { output: values.out } : {}),
      overwrite: values.overwrite === true,
      signal,
    })
    return { data: { output: result.output, bytes: result.bytes, at: result.at } }
  },
}

export const mediaCommands: Command[] = [info, audio, cutCmd, transcodeCmd, thumb]

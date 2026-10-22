/**
 * B 站音频下载的标签流水线。
 *
 * 用真实 ffmpeg 生成的音频 + 真实的 ID3 写入，不 mock —— 这条链路的价值就在
 * "文件真的能被播放器读出正确的歌名/歌手/封面"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { processBiliAudio, audioTargetFormat } from '../src/bili/audio-tag.ts'
import { audioPlan } from '../src/bili/download.ts'

/** 造一个带音频流的 m4a 作为"刚下下来的音频流"。 */
function makeSource(dir: string): string {
  const source = path.join(dir, 'source.m4a')
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', source], { encoding: 'utf8' })
  if (r.error || r.status !== 0) throw new Error(`造夹具失败：${r.stderr}`)
  return source
}

function readTags(file: string): Record<string, string> | null {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', file], { encoding: 'utf8' })
  if (r.error || r.status !== 0) return null
  const tags = (JSON.parse(r.stdout) as { format?: { tags?: Record<string, string> } }).format?.tags ?? {}
  return Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]))
}

test('默认输出格式是 mp3（能写标签）', () => {
  // 没设 bili.audio-format 时
  const prev = process.env.ASTRA_HOME
  process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-at-'))
  try {
    assert.equal(audioTargetFormat(), 'mp3')
  } finally {
    if (prev === undefined) delete process.env.ASTRA_HOME
    else process.env.ASTRA_HOME = prev
  }
})

test('m4a → mp3：转码成功且写入 title / artist / album / date', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-at-'))
  const source = makeSource(dir)
  const output = path.join(dir, 'out.mp3')
  const home = mkdtempSync(path.join(tmpdir(), 'astra-home-'))
  const prevHome = process.env.ASTRA_HOME
  process.env.ASTRA_HOME = home
  try {
    const result = await processBiliAudio({
      source,
      output,
      info: { title: '某分P名', uploader: '某UP主', coverUrl: null, pubdate: 1_700_000_000, bvid: 'BV17x411w7KC' },
    })
    assert.equal(result.format, 'mp3')
    assert.equal(existsSync(output), true)
    assert.ok(result.tagged, `应当写入标签，warnings=${JSON.stringify(result.warnings)}`)

    const tags = readTags(output)
    if (tags) {
      assert.equal(tags.title, '某分P名')
      assert.equal(tags.artist, '某UP主')
      assert.equal(tags.album, '某UP主')
      assert.equal(tags.source_id, 'BV17x411w7KC', 'SOURCE_ID 要写 bvid，不是标题')
      // 音频离开下载目录后，SOURCE_ID 这种键名播放器不显示；BV 号要能被直接看到。
      // ffprobe 对 TXXX 的键名报法不统一（纯描述 / `TXXX:描述`），两种都认
      assert.equal(tags.bilibili_bvid ?? tags['txxx:bilibili_bvid'], 'BV17x411w7KC')
      assert.equal(tags.bilibili_url ?? tags['txxx:bilibili_url'], 'https://www.bilibili.com/video/BV17x411w7KC')
    }
  } finally {
    if (prevHome === undefined) delete process.env.ASTRA_HOME
    else process.env.ASTRA_HOME = prevHome
  }
})

test('m4a 输出：不写标签，但如实说明原因', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-at-'))
  const source = makeSource(dir)
  const output = path.join(dir, 'out.m4a')
  const home = mkdtempSync(path.join(tmpdir(), 'astra-home-'))
  const prevHome = process.env.ASTRA_HOME
  process.env.ASTRA_HOME = home
  try {
    const result = await processBiliAudio({
      source,
      output,
      info: { title: 'x', uploader: 'y', coverUrl: null },
    })
    assert.equal(result.tagged, false)
    assert.ok(result.warnings.some((w) => /不支持写标签|m4a/.test(w)), `应当说明原因：${JSON.stringify(result.warnings)}`)
  } finally {
    if (prevHome === undefined) delete process.env.ASTRA_HOME
    else process.env.ASTRA_HOME = prevHome
  }
})

test('封面下载失败不影响标签写入', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-at-'))
  const source = makeSource(dir)
  const output = path.join(dir, 'out.mp3')
  const home = mkdtempSync(path.join(tmpdir(), 'astra-home-'))
  const prevHome = process.env.ASTRA_HOME
  process.env.ASTRA_HOME = home
  try {
    const result = await processBiliAudio({
      source,
      output,
      info: { title: 't', uploader: 'u', coverUrl: 'https://invalid.example/not-a-real-image.jpg' },
    })
    assert.equal(result.tagged, true, '封面挂了，文字标签仍要写进去')
    assert.equal(result.coverEmbedded, false)
    assert.ok(result.warnings.some((w) => /封面/.test(w)))
  } finally {
    if (prevHome === undefined) delete process.env.ASTRA_HOME
    else process.env.ASTRA_HOME = prevHome
  }
})

test('分支判定：整段流 + 只取音频，必须过音频管道', () => {
  // 这条防的是"调用方忘了调管道"。上一次只测 processBiliAudio 本身，
  // 把 durl 分支退回"直接存"测试照样绿 —— 因为它验的是被调用的函数，不是要不要调。
  assert.equal(audioPlan(true), 'pipeline', 'durl 是带画面的整段流，不过管道就存成假 mp3')
  assert.equal(audioPlan(false), 'raw', '下视频时整段流直接存就行')
})

test('整段流（带画面）也能抽出音频并写 BV：番剧和老视频走的是这条路', async () => {
  // 非 DASH 的视频（番剧 / 部分老视频）拿到的是**画面+声音在一个文件里**的整段流。
  // 这条曾经直接把它当 mp3 存下去：扩展名说谎、没有标签、没有 BV 号。
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-at-'))
  const source = path.join(dir, 'segment.mp4')
  const made = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=2',
    '-shortest', '-c:v', 'libx264', '-c:a', 'aac', source,
  ], { encoding: 'utf8' })
  if (made.error || made.status !== 0) throw new Error(`造夹具失败：${made.stderr}`)

  const output = path.join(dir, 'out.mp3')
  const home = mkdtempSync(path.join(tmpdir(), 'astra-home-'))
  const prevHome = process.env.ASTRA_HOME
  process.env.ASTRA_HOME = home
  try {
    const result = await processBiliAudio({
      source,
      output,
      info: { title: '某番剧第 1 话', uploader: '某 UP', coverUrl: null, bvid: 'BV17x411w7KC' },
    })
    assert.equal(result.format, 'mp3')
    assert.ok(result.tagged, `应当写入标签，warnings=${JSON.stringify(result.warnings)}`)

    const tags = readTags(output)
    if (tags) {
      assert.equal(tags.bilibili_bvid ?? tags['txxx:bilibili_bvid'], 'BV17x411w7KC', '整段流也要带 BV 号')
    }
    // 成品必须真的是音频：不能把带画面的流原样存成 .mp3
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', output], { encoding: 'utf8' })
    assert.equal(probe.stdout.trim(), 'audio', '不许有视频轨')
  } finally {
    if (prevHome === undefined) delete process.env.ASTRA_HOME
    else process.env.ASTRA_HOME = prevHome
  }
})

test('发行日期：pubdate 写成 TDRC，播放器按年份归档', async () => {
  // 清单 P2#12：B 站音频进音乐库后，按年份浏览全是空白
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-at-'))
  const source = makeSource(dir)
  const output = path.join(dir, 'out.mp3')
  const home = mkdtempSync(path.join(tmpdir(), 'astra-home-'))
  const prevHome = process.env.ASTRA_HOME
  process.env.ASTRA_HOME = home
  try {
    const result = await processBiliAudio({
      source,
      output,
      // 2024-03-29 00:00:00 UTC
      info: { title: '《5:20AM》', uploader: '东洋雪莲', coverUrl: null, bvid: 'BV19K421a7kx', pubdate: 1711670400 },
    })
    assert.ok(result.tagged)
    const tags = readTags(output)
    if (tags) {
      assert.equal(tags.date, '2024-03-29', '应当是视频发布日期，不是下载时间')
    }
  } finally {
    if (prevHome === undefined) delete process.env.ASTRA_HOME
    else process.env.ASTRA_HOME = prevHome
  }
})

test('没有 pubdate 时不写日期，也不编一个', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'astra-at-'))
  const source = makeSource(dir)
  const output = path.join(dir, 'out.mp3')
  const home = mkdtempSync(path.join(tmpdir(), 'astra-home-'))
  const prevHome = process.env.ASTRA_HOME
  process.env.ASTRA_HOME = home
  try {
    await processBiliAudio({
      source,
      output,
      info: { title: 't', uploader: 'u', coverUrl: null, bvid: 'BV17x411w7KC' },
    })
    const tags = readTags(output)
    if (tags) {
      assert.equal(tags.date, undefined, '没有发布日期就不该有 date —— 更不能拿"今天"顶上')
    }
  } finally {
    if (prevHome === undefined) delete process.env.ASTRA_HOME
    else process.env.ASTRA_HOME = prevHome
  }
})

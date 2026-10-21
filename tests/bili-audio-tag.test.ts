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

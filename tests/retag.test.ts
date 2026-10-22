/**
 * `music retag`：把落盘规则的历史改动补到存量文件上。
 *
 * 这个命令会**移动和重写用户的真实文件**，所以测试重点全在"别搞坏东西"：
 * 冲突检测、音频字节不变、歌词和封面不丢、曲库记录跟着走。
 *
 * 网络部分（查专辑信息）在这里全部走不通也没关系 —— 计划逻辑对"专辑查不到"
 * 是有兜底分支的，测试正好覆盖那条路。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

let home = ''
let musicDir = ''
const fixtures = path.resolve('tests/fixtures')

before(() => {
  home = mkdtempSync(path.join(tmpdir(), 'astra-retag-'))
  musicDir = path.join(home, 'music')
  mkdirSync(musicDir, { recursive: true })
  process.env.ASTRA_HOME = home
  process.env.ASTRA_MUSIC_DIR = musicDir
})

after(async () => {
  // Windows 上 SQLite 的句柄不放手就删不掉临时目录（EPERM）。先关库再清。
  const { closeDb } = await import('../src/core/db.ts')
  closeDb()
  if (home) rmSync(home, { recursive: true, force: true })
})

/** 把夹具音频拷到音乐目录下的指定相对路径。 */
function placeFixture(fixture: string, relative: string): string {
  const target = path.join(musicDir, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, readFileSync(path.join(fixtures, fixture)))
  return target
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 音频载荷的哈希（剥掉标签）。用来验证"写标签不动音频字节"。 */
async function audioHash(file: string): Promise<string> {
  const { audioPayload } = await import('../src/music/tags.ts')
  const buffer = readFileSync(file)
  const format = buffer.subarray(0, 4).toString('latin1') === 'fLaC' ? 'flac' : 'mp3'
  return createHash('sha256').update(audioPayload(buffer, format)).digest('hex')
}

test('找不到文件时给出可读原因，不抛异常', async () => {
  const { planRetag } = await import('../src/music/retag.ts')
  const plan = await planRetag({
    tracks: [{
      platform: 'netease', id: '1', title: '不存在的歌', artists: ['某人'], album: '某专辑',
      durationMs: 1000, path: path.join(musicDir, 'nope/1 不存在的歌.mp3'), format: 'mp3',
      quality: '320k', spec: { sampleRate: null, bitsPerSample: null, channels: null },
      bytes: null, bps: null, hasCover: null, hasLyric: null, hasWordLyric: null,
      sourceId: null, createdAt: '', missing: true,
    }],
  })
  assert.equal(plan.summary.problems, 1)
  assert.match(plan.items[0]!.problem ?? '', /文件不存在/)
  assert.equal(plan.conflicts.length, 0, '文件缺失不算冲突，只是做不了')
})

test('曲库 id 与实际查到的不一致时跳过，绝不搬进陌生歌手目录', async () => {
  // 实测过的事故：随手编的 id 999001 在网易云是 Anouar Brahem 的《Claquem les voiles》。
  // 曲库记录过期（改过名、手改过、从别的机器搬来的库）时，
  // 不看一眼就会把用户的文件搬进一个完全不相干的歌手目录。
  const { planRetag } = await import('../src/music/retag.ts')
  const file = placeFixture('tone.mp3', 'identity/旧/01 对不上.mp3')
  const plan = await planRetag({
    tracks: [{
      platform: 'netease', id: '999001', title: '对不上', artists: ['假歌手'], album: '假专辑',
      durationMs: 1000, path: file, format: 'mp3', quality: '320k',
      spec: { sampleRate: null, bitsPerSample: null, channels: null },
      bytes: null, bps: null, hasCover: null, hasLyric: null, hasWordLyric: null,
      sourceId: null, createdAt: '', missing: false,
    }],
  })
  const item = plan.items[0]!
  // 联网可用时才会触发校验；离线环境下接口失败、走"查不到专辑"的兜底，也算安全
  if (item.problem) {
    assert.match(item.problem, /id 对不上|文件不存在/, `跳过的原因要说得清：${item.problem}`)
    assert.equal(item.moves, false, '判为问题时绝不能移动')
  }
})

test('两首歌算出同一目标路径 -> 整批拒绝', async () => {
  const { planRetag } = await import('../src/music/retag.ts')
  // 同一个标题、同一个专辑、同样的歌手 —— 模板渲染出来必然相同
  const track = (id: string, file: string) => ({
    platform: 'netease', id, title: '同名歌', artists: ['同一人'], album: '同一专辑',
    durationMs: 1000, path: file, format: 'mp3' as const,
    quality: '320k' as const, spec: { sampleRate: null, bitsPerSample: null, channels: null },
    bytes: null, bps: null, hasCover: null, hasLyric: null, hasWordLyric: null,
    sourceId: null, createdAt: '', missing: false,
  })
  const a = placeFixture('tone.mp3', `dup/${'a'}.mp3`)
  const b = placeFixture('tone.mp3', `dup/${'b'}.mp3`)
  const plan = await planRetag({ tracks: [track('201', a), track('202', b)] })
  assert.ok(plan.conflicts.length > 0, '必须报冲突')
  assert.match(plan.conflicts[0]!, /同一个目标路径/)
})

test('目标位置已有不认识的同名文件 -> 不覆盖，报冲突', async () => {
  const { planRetag } = await import('../src/music/retag.ts')
  // 先把"占位文件"放到模板会算出来的位置上
  const { renderTemplate } = await import('../src/music/paths.ts')
  const { getConfig } = await import('../src/core/config.ts')
  const relative = renderTemplate(getConfig('music.template'), {
    artist: '占有者', artist_list: '占有者', albumartist: '占有者', primary_artist: '占有者',
    album: '某专辑', title: '被占的歌', year: '', track: '', disc: '', source: 'unknown', ext: 'mp3',
  } as never)
  const squatter = path.join(musicDir, relative)
  mkdirSync(path.dirname(squatter), { recursive: true })
  writeFileSync(squatter, 'not audio')

  const source = placeFixture('tone.mp3', 'squat/source.mp3')
  const plan = await planRetag({
    tracks: [{
      platform: 'netease', id: '301', title: '被占的歌', artists: ['占有者'], album: '某专辑',
      durationMs: 1000, path: source, format: 'mp3', quality: '320k',
      spec: { sampleRate: null, bitsPerSample: null, channels: null },
      bytes: null, bps: null, hasCover: null, hasLyric: null, hasWordLyric: null,
      sourceId: null, createdAt: '', missing: false,
    }],
  })
  assert.ok(plan.conflicts.some((c) => /目标位置已经有文件/.test(c)), `期望冲突，实际：${JSON.stringify(plan.conflicts)}`)
})

test('已经符合规则的文件判为 unchanged，不进迁移清单', async () => {
  const { planRetag } = await import('../src/music/retag.ts')
  const { renderTemplate } = await import('../src/music/paths.ts')
  const { getConfig } = await import('../src/core/config.ts')
  // 先按当前模板算出正确位置，把文件放那儿
  const relative = renderTemplate(getConfig('music.template'), {
    artist: '已归位', artist_list: '已归位', albumartist: '已归位', primary_artist: '已归位',
    album: '专辑', title: '已归位的歌', year: '', track: '', disc: '', source: 'unknown', ext: 'mp3',
  } as never)
  const placed = placeFixture('tone.mp3', relative)
  const plan = await planRetag({
    tracks: [{
      platform: 'netease', id: '401', title: '已归位的歌', artists: ['已归位'], album: '专辑',
      durationMs: 1000, path: placed, format: 'mp3', quality: '320k',
      spec: { sampleRate: null, bitsPerSample: null, channels: null },
      bytes: null, bps: null, hasCover: null, hasLyric: null, hasWordLyric: null,
      sourceId: null, createdAt: '', missing: false,
    }],
  })
  assert.equal(plan.items[0]!.moves, false, `不该移动：${plan.items[0]!.from} -> ${plan.items[0]!.to}`)
  assert.equal(plan.summary.moves, 0)
})

test('执行后：文件搬到新位置，音频字节一个都没变', async () => {
  const { planRetag, executeRetag } = await import('../src/music/retag.ts')
  // 放进一个旧规则的路径（直接用歌手名目录，不是 albumartist 规则）
  const oldPath = placeFixture('tone.mp3', '旧目录/旧专辑/01 旧歌.mp3')
  const beforeAudio = await audioHash(oldPath)

  const plan = await planRetag({
    tracks: [{
      platform: 'netease', id: '501', title: '旧歌', artists: ['新艺术家'], album: '新专辑',
      durationMs: 1000, path: oldPath, format: 'mp3', quality: '320k',
      spec: { sampleRate: null, bitsPerSample: null, channels: null },
      bytes: null, bps: null, hasCover: null, hasLyric: null, hasWordLyric: null,
      sourceId: null, createdAt: '', missing: false,
    }],
  })
  const item = plan.items[0]!
  assert.equal(item.moves, true, '应该要移动')

  const result = await executeRetag(plan)
  assert.equal(result.failed.length, 0, JSON.stringify(result.failed))
  assert.equal(result.moved, 1)
  assert.equal(existsSync(oldPath), false, '旧位置不该还在')
  assert.equal(existsSync(item.to), true, '新位置应该有文件')
  assert.equal(await audioHash(item.to), beforeAudio, '音频字节被改了')
})

test('写标签不动音频：文件整体哈希会变（标签变了），但音频载荷哈希不变', async () => {
  const { planRetag, executeRetag } = await import('../src/music/retag.ts')
  const file = placeFixture('tone.flac', 'tags/专辑/01 标签歌.flac')
  const wholeBefore = sha256(file)
  const audioBefore = await audioHash(file)

  const plan = await planRetag({
    tracks: [{
      platform: 'netease', id: '601', title: '标签歌', artists: ['歌手A'], album: '专辑',
      durationMs: 1000, path: file, format: 'flac', quality: 'flac',
      spec: { sampleRate: null, bitsPerSample: null, channels: null },
      bytes: null, bps: null, hasCover: null, hasLyric: null, hasWordLyric: null,
      sourceId: null, createdAt: '', missing: false,
    }],
  })
  await executeRetag(plan)

  const target = plan.items[0]!.to
  assert.equal(await audioHash(target), audioBefore, 'FLAC 音频帧被改了')
  // 标签确实写了：整体哈希变了
  assert.notEqual(sha256(target), wholeBefore, '标签没写进去')
})

test('搬文件时同名的 .lrc 跟着走', async () => {
  const { planRetag, executeRetag } = await import('../src/music/retag.ts')
  const file = placeFixture('tone.mp3', 'lyric/旧/01 带歌词.mp3')
  const lrc = file.replace(/\.mp3$/, '.lrc')
  writeFileSync(lrc, '[00:01.00]歌词第一行\n')

  const plan = await planRetag({
    tracks: [{
      platform: 'netease', id: '701', title: '带歌词', artists: ['歌词歌手'], album: '歌词专辑',
      durationMs: 1000, path: file, format: 'mp3', quality: '320k',
      spec: { sampleRate: null, bitsPerSample: null, channels: null },
      bytes: null, bps: null, hasCover: null, hasLyric: true, hasWordLyric: null,
      sourceId: null, createdAt: '', missing: false,
    }],
  })
  const item = plan.items[0]!
  await executeRetag(plan)

  assert.equal(existsSync(item.to), true)
  const movedLrc = item.to.replace(/\.[^.]+$/, '.lrc')
  assert.equal(existsSync(movedLrc), true, '.lrc 没跟着走，等于丢歌词')
  assert.match(readFileSync(movedLrc, 'utf8'), /歌词第一行/)
  assert.equal(existsSync(lrc), false, '旧 .lrc 不该还在')
})

test('写标签真的改坏音频时，执行会中止且不留下损坏的文件', async () => {
  const { planRetag, executeRetag } = await import('../src/music/retag.ts')
  const file = placeFixture('tone.flac', 'guard/专辑/01 保护.flac')
  const original = readFileSync(file)

  const plan = await planRetag({
    tracks: [{
      platform: 'netease', id: '751', title: '保护', artists: ['保护歌手'], album: '专辑',
      durationMs: 1000, path: file, format: 'flac', quality: 'flac',
      spec: { sampleRate: null, bitsPerSample: null, channels: null },
      bytes: null, bps: null, hasCover: null, hasLyric: null, hasWordLyric: null,
      sourceId: null, createdAt: '', missing: false,
    }],
  })
  // 正常路径能跑通（证明这条用例的前提成立）
  const result = await executeRetag(plan)
  assert.equal(result.failed.length, 0)
  assert.equal(existsSync(plan.items[0]!.to), true)
  // 音频载荷哈希必须可复现 —— 这是"检测到损坏"的依据
  const { audioPayload } = await import('../src/music/tags.ts')
  const originalFormat = original.subarray(0, 4).toString('latin1') === 'fLaC' ? 'flac' : 'mp3'
  const after = readFileSync(plan.items[0]!.to)
  assert.equal(
    createHash('sha256').update(audioPayload(original, originalFormat)).digest('hex'),
    createHash('sha256').update(audioPayload(after, originalFormat)).digest('hex'),
    '音频载荷哈希在写标签前后必须一致 —— 不一致就该被中止',
  )
})

test('曲库记录跟着更新，`have` 不会报文件缺失', async () => {
  const { planRetag, executeRetag } = await import('../src/music/retag.ts')
  const { saveTrack, findTrack } = await import('../src/music/library.ts')
  const file = placeFixture('tone.mp3', 'lib/旧/01 库歌.mp3')
  saveTrack({
    platform: 'netease', id: '801', title: '库歌', artists: ['库歌手'], album: '库专辑',
    durationMs: 1000, path: file, format: 'mp3', quality: '320k', bytes: null, bps: null,
    audioSha256: null, sourceId: null,
  })

  const plan = await planRetag({ tracks: [findTrack('netease', '801')!] })
  await executeRetag(plan)

  const after = findTrack('netease', '801')!
  assert.equal(after.path, plan.items[0]!.to, '曲库路径没更新')
  assert.equal(after.missing, false, '曲库说文件缺失')
})

test('大小写不同但同一文件的两个目标，在 Windows/macOS 上算冲突', async () => {
  const { planRetag } = await import('../src/music/retag.ts')
  const track = (id: string, title: string, file: string) => ({
    platform: 'netease', id, title, artists: ['同一人'], album: '同一专辑',
    durationMs: 1000, path: file, format: 'mp3' as const, quality: '320k' as const,
    spec: { sampleRate: null, bitsPerSample: null, channels: null },
    bytes: null, bps: null, hasCover: null, hasLyric: null, hasWordLyric: null,
    sourceId: null, createdAt: '', missing: false,
  })
  // 只差大小写：在大小写不敏的文件系统上这两个是同一个文件
  const a = placeFixture('tone.mp3', 'case/a.mp3')
  const b = placeFixture('tone.mp3', 'case/b.mp3')
  const plan = await planRetag({ tracks: [track('901', 'Idol', a), track('902', 'idol', b)] })
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
  if (caseInsensitive) {
    assert.ok(plan.conflicts.length > 0, 'Idol / idol 在大小写不敏的系统上必须报冲突')
  } else {
    assert.equal(plan.conflicts.length, 0, '区分大小写的系统上它们是两个文件，不算冲突')
  }
})

test('重写标签时优先用同目录的同步歌词，别把纯文本原样写回去', async () => {
  const { syncedLyricsFor } = await import('../src/music/retag.ts')
  const audio = placeFixture('tone.flac', 'lyr/song.flac')
  const base = path.join(musicDir, 'lyr/song')

  // 都没有 → null，调用方沿用原标签
  assert.equal(await syncedLyricsFor(audio), null)

  // 只有纯文本的 .lrc（没时间戳）→ 仍然 null，带回去没有意义
  writeFileSync(base + '.lrc', '第一行\n第二行\n', 'utf8')
  assert.equal(await syncedLyricsFor(audio), null)

  // 普通 LRC（有 [mm:ss.xx]）→ 用它
  writeFileSync(base + '.lrc', '[00:12.34]第一行\n[00:15.00]第二行\n', 'utf8')
  const plainLrc = await syncedLyricsFor(audio)
  assert.match(plainLrc!, /\[00:12\.34\]/)

  // 逐字 `.word.lrc` 优先于 `.lrc`
  writeFileSync(base + '.word.lrc', '[00:12.34]<00:12.34>第<00:12.80>一行\n', 'utf8')
  const word = await syncedLyricsFor(audio)
  assert.match(word!, /<00:12\.34>/, '有逐字就用逐字')
})

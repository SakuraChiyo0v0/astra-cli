/**
 * 漫画后台任务与订阅：worker 在本进程里跑，上游换成假的 client（不打真站）。
 *
 * 验：一项 = 一话；已有的话记 skipped；订阅只补基线之外、且只把真下成功的话记为已下。
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AlbumDetail, AlbumEpisode, ChapterDetail } from '../src/jm/client.ts'

const PNG = (() => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr[16] = 8
  ihdr[17] = 6
  const iend = Buffer.alloc(12)
  iend.write('IEND', 4, 'ascii')
  return Buffer.concat([sig, ihdr, iend])
})()

let jobs: typeof import('../src/core/jobs.ts')
let jmJobs: typeof import('../src/jm/jobs.ts')
let sub: typeof import('../src/jm/subscribe.ts')
let commands: typeof import('../src/jm/commands.ts')
let musicSub: typeof import('../src/music/subscribe.ts')
let root = ''

/** 假上游：章节列表可以改，章节图片来自预先放好的文件（下载走 already_have）。 */
const upstream: { episodes: AlbumEpisode[]; failChapter: string | null } = { episodes: [], failChapter: null }
const album = (): AlbumDetail => ({
  id: '777', seriesId: '777', title: '连载', authors: ['作者'], tags: [], description: '', pageCount: 0, pubDate: null,
  episodes: upstream.episodes,
})

/** 把某一话的页先放进目录，下载时就是 already_have，不碰网络。 */
function seedChapter(sort: number): void {
  const page = path.join(root, '777 连载', String(sort).padStart(2, '0'), '001.png')
  mkdirSync(path.dirname(page), { recursive: true })
  writeFileSync(page, PNG)
}

before(async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'astra-jm-jobs-'))
  process.env.ASTRA_HOME = home
  root = path.join(home, 'jm')
  process.env.ASTRA_JM_DIR = root
  process.env.ASTRA_DB_URL = `sqlite:${path.join(home, 'lib.db')}`
  delete process.env.ASTRA_FEISHU_WEBHOOK
  jobs = await import('../src/core/jobs.ts')
  jmJobs = await import('../src/jm/jobs.ts')
  sub = await import('../src/jm/subscribe.ts')
  commands = await import('../src/jm/commands.ts')
  musicSub = await import('../src/music/subscribe.ts')
  const { jmClient } = await import('../src/jm/client.ts')
  const client = jmClient()
  client.getAlbum = async () => album()
  client.getScrambleId = async () => '0'
  client.getChapter = async (id: string): Promise<ChapterDetail> => {
    if (id === upstream.failChapter) throw new Error('上游 500')
    const ep = upstream.episodes.find((e) => e.id === id)!
    return { id, albumId: '777', title: ep.title, sort: ep.sort, images: ['00001.png'], imageDomain: '', scrambleId: '0' }
  }
  client.downloadImageBytes = async () => {
    throw new Error('测试里不该真去拉图')
  }
})

const eps = (n: number): AlbumEpisode[] => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, sort: i + 1, title: `第${i + 1}话` }))

test('chapterItems：一话一项，带 albumId / chapterId / sort', () => {
  const items = jmJobs.chapterItems({ id: '777', title: '连载' }, eps(2))
  assert.equal(items.length, 2)
  assert.equal(items[1]!.id, 'c2')
  assert.deepEqual(items[1]!.meta, { albumId: '777', chapterId: 'c2', sort: 2 })
})

test('shouldBackground：多话默认后台，单话当场；显式参数优先', () => {
  assert.equal(commands.shouldBackground({}, 3), true)
  assert.equal(commands.shouldBackground({}, 1), false)
  assert.equal(commands.shouldBackground({ wait: true }, 3), false)
  assert.equal(commands.shouldBackground({ background: true }, 1), true)
})

test('worker：已有的话记 skipped，失败的话不拖累其它话', async () => {
  upstream.episodes = eps(3)
  upstream.failChapter = 'c3'
  seedChapter(1)
  seedChapter(2)
  const job = jobs.createJob({ domain: jmJobs.JM_DOMAIN, kind: 'album', title: 't', items: jmJobs.chapterItems(album(), eps(3)) })
  await jobs.runWorker(jmJobs.JM_DOMAIN, job.id)
  const { job: done, items } = jobs.getJob(job.id, true, jmJobs.JM_DOMAIN)
  assert.equal(done.status, 'partial')
  assert.deepEqual(items!.map((i) => i.status), ['skipped', 'skipped', 'failed'])
  assert.ok(existsSync(path.join(items![0]!.path!, '.astra-jm.json')), '跳过的话也补写 sidecar')
  assert.equal(jobs.listJobs(10, false, 'jm').some((j) => j.id === job.id), true)
})

test('订阅：默认记基线，只下之后的新话', () => {
  upstream.episodes = eps(2)
  const { subscription, created } = sub.addJmSubscription(album(), { everyHours: 24 })
  assert.equal(created, true)
  assert.deepEqual(subscription.baseline, ['c1', 'c2'])
  assert.deepEqual(sub.pickNewChapters(eps(2), subscription.baseline, subscription.done), [])
  assert.deepEqual(sub.pickNewChapters(eps(4), subscription.baseline, subscription.done).map((e) => e.sort), [3, 4])

  const again = sub.addJmSubscription(album(), { everyHours: 6 })
  assert.equal(again.created, false, '同一本不建第二条')
  assert.equal(again.subscription.id, subscription.id)
  sub.removeJmSubscription(subscription.id)
})

test('订阅：只把下成功的话记为已下，失败的下一轮还会补', async () => {
  upstream.episodes = eps(3)
  upstream.failChapter = 'c3'
  const { subscription } = sub.addJmSubscription(album(), { everyHours: 24, backfill: true })
  assert.deepEqual(subscription.baseline, [])

  // 走 run 的同一条路径，但不起子进程：建任务、本进程跑 worker
  const fresh = sub.pickNewChapters(upstream.episodes, subscription.baseline, subscription.done)
  assert.equal(fresh.length, 3)
  const job = jobs.createJob({
    domain: jmJobs.JM_DOMAIN, kind: 'subscribe', title: 's',
    items: jmJobs.chapterItems(album(), fresh), meta: { subscriptionId: subscription.id },
  })
  await jobs.runWorker(jmJobs.JM_DOMAIN, job.id) // afterFinish 回写

  const after = sub.findJmSubscription(subscription.id)
  assert.deepEqual(after.done, { c1: 1, c2: 2 })
  assert.deepEqual(sub.pickNewChapters(upstream.episodes, after.baseline, after.done).map((e) => e.id), ['c3'])
  sub.removeJmSubscription(subscription.id)
})

test('dueJmSubscriptions：没跑过的、过了间隔的到点；停用的不跑', () => {
  const base = { albumId: 'x', title: 'x', baseline: [], done: {}, lastJobId: null, createdAt: '' }
  const now = Date.parse('2026-10-30T12:00:00Z')
  const due = sub.dueJmSubscriptions(now, [
    { ...base, id: 'never', everyHours: 24, enabled: true, lastCheckedAt: null },
    { ...base, id: 'stale', everyHours: 6, enabled: true, lastCheckedAt: '2026-10-30T05:00:00Z' },
    { ...base, id: 'fresh', everyHours: 6, enabled: true, lastCheckedAt: '2026-10-30T10:00:00Z' },
    { ...base, id: 'off', everyHours: 1, enabled: false, lastCheckedAt: null },
  ])
  assert.deepEqual(due.map((s) => s.id), ['never', 'stale'])
})

test('漫画订阅不混进 music subscribe', () => {
  const { subscription } = sub.addJmSubscription({ ...album(), id: '888' }, { everyHours: 24 })
  assert.equal(musicSub.listSubscriptions().some((s) => s.id === subscription.id), false)
  assert.throws(() => musicSub.findSubscription(subscription.id), /没有订阅/)
  sub.removeJmSubscription(subscription.id)
})

test('jm 下的新命令都注册了，cron 命令就是 subscribe run', () => {
  const names = commands.jmCommands.map((c) => c.name)
  for (const n of ['jm job', 'jm jobs', 'jm job cancel', 'jm job resume', 'jm _worker', 'jm subscribe add', 'jm subscribe list', 'jm subscribe set', 'jm subscribe remove', 'jm subscribe run']) {
    assert.ok(names.includes(n), `缺 ${n}`)
  }
  assert.ok(names.includes(commands.JM_SUBSCRIBE_CRON.replace(/^astra /, '')))
})

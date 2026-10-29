/**
 * `astra pixiv` 的纯逻辑部分。
 *
 * 不碰网络：只测「多页 URL 怎么换页号」「cookie 只回显存在性」「没配目录就报错」这三件
 * 容易悄悄错掉的事。真实抓取靠 `astra pixiv info/rank` 手工验，不放进单测（会依赖代理和上游）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cookieDigest, pageUrls, type IllustDetail } from '../src/pixiv/api.ts'
import { pixivCommands } from '../src/pixiv/commands.ts'
import { parseCommandArgs } from '../src/core/command.ts'

function detail(over: Partial<IllustDetail> = {}): IllustDetail {
  return {
    id: '123456789',
    title: 'テスト',
    userId: '42',
    userName: 'painter',
    pageCount: 1,
    xRestrict: 0,
    sl: 2,
    illustType: 0,
    width: 1000,
    height: 1400,
    tags: ['tag'],
    urls: {
      original: 'https://i.pximg.net/img-original/img/2026/01/01/00/00/00/123456789_p0.jpg',
      regular: 'https://i.pximg.net/img-master/img/2026/01/01/00/00/00/123456789_p0_master1200.jpg',
      small: 'https://i.pximg.net/c/540x540_70/img-master/img/2026/01/01/00/00/00/123456789_p0_square1200.jpg',
    },
    ...over,
  }
}

test('单页作品：页号不参与替换，扩展名按原图取', () => {
  const pages = pageUrls(detail())
  assert.equal(pages.length, 1)
  assert.equal(pages[0]!.page, 0)
  assert.equal(pages[0]!.ext, 'jpg')
  assert.match(pages[0]!.original, /_p0\.jpg$/)
})

test('多页作品：每一页都换成自己的页号，regular 同步换', () => {
  const pages = pageUrls(detail({ pageCount: 3 }))
  assert.equal(pages.length, 3)
  assert.deepEqual(pages.map((p) => p.page), [0, 1, 2])
  assert.match(pages[2]!.original, /123456789_p2\.jpg$/)
  assert.match(pages[2]!.regular, /123456789_p2_master1200\.jpg$/)
  // 不能把 _master1200 也当成页号替换掉
  assert.ok(!pages[1]!.regular.includes('_p1_master1200_p'))
})

test('png 原图保留扩展名', () => {
  const d = detail({
    urls: {
      original: 'https://i.pximg.net/img-original/img/x/1_p0.png',
      regular: 'https://i.pximg.net/img-master/img/x/1_p0_master1200.jpg',
      small: 'https://i.pximg.net/c/x.jpg',
    },
  })
  assert.equal(pageUrls(d)[0]!.ext, 'png')
})

test('cookie 只回显「有没有」，不回显值', () => {
  assert.deepEqual(cookieDigest(''), { has: false, keys: 0 })
  const digest = cookieDigest('PHPSESSID=secret-value; device_token=abc')
  assert.deepEqual(digest, { has: true, keys: 2 })
  assert.ok(!JSON.stringify(digest).includes('secret-value'))
})

test('命令都登记上了，且名字以 pixiv 开头', () => {
  const names = pixivCommands.map((c) => c.name)
  assert.deepEqual(names, [
    'pixiv info',
    'pixiv rank',
    'pixiv top',
    'pixiv user',
    'pixiv search',
    'pixiv pull',
    'pixiv sub add',
    'pixiv sub remove',
    'pixiv sub list',
    'pixiv sub run',
    'pixiv cookie set',
    'pixiv cookie show',
    'pixiv cookie check',
    'pixiv cookie clear',
  ])
  for (const c of pixivCommands) {
    assert.ok(c.summary.length > 0, `${c.name} 缺 summary`)
    assert.ok(c.usage.startsWith('astra '), `${c.name} 的 usage 要以 astra 开头`)
  }
})

test('参数个数按声明拦住（info 只收一个 id）', () => {
  const info = pixivCommands.find((c) => c.name === 'pixiv info')!
  assert.throws(() => parseCommandArgs(info, []), /缺少参数/)
  assert.throws(() => parseCommandArgs(info, ['1', '2']), /参数太多/)
})

test('pull 没配目录且没给 --out 时明确报错，不瞎写默认路径', async () => {
  const pull = pixivCommands.find((c) => c.name === 'pixiv pull')!
  const prev = process.env.ASTRA_HOME
  process.env.ASTRA_HOME = '/tmp/astra-pixiv-test-home'
  try {
    await assert.rejects(
      async () => pull.run({ positionals: ['123456789'], values: {}, signal: new AbortController().signal }),
      (err: unknown) => {
        const e = err as { code?: string; hint?: string }
        assert.equal(e.code, 'NO_OUTPUT_DIR')
        assert.match(String(e.hint), /pixiv\.dir/)
        return true
      },
    )
  } finally {
    if (prev === undefined) delete process.env.ASTRA_HOME
    else process.env.ASTRA_HOME = prev
  }
})

test('非法 id 在发请求之前就被拦住', async () => {
  const info = pixivCommands.find((c) => c.name === 'pixiv info')!
  await assert.rejects(
    async () => info.run({ positionals: ['abc'], values: {}, signal: new AbortController().signal }),
    /illustId 要是正整数/,
  )
})


test('订阅：加进去记基线，重复加不重复写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'astra-pixiv-sub-'))
  const prev = process.env.ASTRA_HOME
  process.env.ASTRA_HOME = dir
  try {
    // 直接写订阅表，绕开网络（sub add 会去拉画师作品）
    const file = join(dir, 'pixiv-subs.json')
    writeFileSync(file, JSON.stringify([
      { userId: 42, userName: 'painter', lastSeenId: 1000, addedAt: '2026-10-26T00:00:00Z' },
    ]))
    const list = pixivCommands.find((c) => c.name === 'pixiv sub list')!
    const res = await list.run({ positionals: [], values: {}, signal: new AbortController().signal })
    assert.equal((res.data as { total: number }).total, 1)

    const remove = pixivCommands.find((c) => c.name === 'pixiv sub remove')!
    await remove.run({ positionals: ['42'], values: {}, signal: new AbortController().signal })
    const after = JSON.parse(readFileSync(file, 'utf8')) as unknown[]
    assert.equal(after.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (prev === undefined) delete process.env.ASTRA_HOME
    else process.env.ASTRA_HOME = prev
  }
})

test('订阅表坏了不炸，当空表处理', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'astra-pixiv-bad-'))
  const prev = process.env.ASTRA_HOME
  process.env.ASTRA_HOME = dir
  try {
    writeFileSync(join(dir, 'pixiv-subs.json'), '{ not json')
    const list = pixivCommands.find((c) => c.name === 'pixiv sub list')!
    const res = await list.run({ positionals: [], values: {}, signal: new AbortController().signal })
    assert.equal((res.data as { total: number }).total, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (prev === undefined) delete process.env.ASTRA_HOME
    else process.env.ASTRA_HOME = prev
  }
})

/**
 * 洛雪宿主契约。夹具脚本按 qdy v9.3 实际的写法：顶层解构 globalThis.lx、用 body 时两种写法都有。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { loadLxSource, makeLxBody, parseScriptMeta } from '../src/lx/host.ts'

const SCRIPT = (base: string) => `/*!
 * @name 测试音源
 * @version 1.2
 */
const { EVENT_NAMES, request, on, send, utils } = globalThis.lx
const md5 = utils.crypto.md5('abc')
on(EVENT_NAMES.request, ({ action, source, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('action not support'))
  return new Promise((resolve, reject) => {
    request('${base}/url?id=' + info.musicInfo.songmid + '&q=' + info.type, { method: 'GET', timeout: 5000 }, (err, resp) => {
      if (err) return reject(err)
      // 两种写法都要能用：直接取字段 / JSON.parse(body)
      if (resp.body.code !== 0) return reject(new Error('code ' + resp.body.code))
      const parsed = JSON.parse(resp.body)
      resolve(parsed.url + '&md5=' + md5)
    })
  })
})
send(EVENT_NAMES.inited, { sources: { wy: { name: '网易云', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] } } })
`

test('makeLxBody：既是字符串又挂着字段', () => {
  const body = makeLxBody('{"code":0,"url":"x"}')
  assert.equal(JSON.parse(String(body)).url, 'x')
  assert.equal((body as unknown as { code: number }).code, 0)
  assert.equal(String(makeLxBody('plain')), 'plain')
})

test('parseScriptMeta', () => {
  assert.deepEqual(parseScriptMeta('/*!\n * @name 全豆要[聚合音源]\n * @version 9.3 特供\n */'), {
    name: '全豆要[聚合音源]', description: '', version: '9.3 特供', author: '', homepage: '',
  })
})

test('加载脚本、上报能力、走宿主 request 取直链', async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('content-type', 'application/json')
    if (url.searchParams.get('id') === 'bad') res.end(JSON.stringify({ code: 1 }))
    else res.end(JSON.stringify({ code: 0, url: `http://cdn.example/${url.searchParams.get('id')}.mp3?q=${url.searchParams.get('q')}` }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const source = await loadLxSource(SCRIPT(base), 'test.js')
    assert.equal(source.name, '测试音源')
    assert.deepEqual(source.sources.wy?.qualitys, ['128k', '320k', 'flac'])
    const info = { source: 'wy', name: 'n', singer: 's', albumName: 'a', songmid: '42', hash: '42', id: '42', interval: 10 }
    const url = await source.musicUrl('wy', 'flac', info)
    assert.equal(url, 'http://cdn.example/42.mp3?q=flac&md5=900150983cd24fb0d6963f7d28e17f72')
    await assert.rejects(source.musicUrl('wy', 'flac', { ...info, songmid: 'bad' }), /code 1/)
  } finally {
    server.close()
  }
})

test('不上报 inited 的脚本加载失败（而不是挂住）', async () => {
  const started = Date.now()
  await assert.rejects(loadLxSource('globalThis.lx.on("request", () => "x"); throw new Error("boom")', 'bad.js'), /boom/)
  assert.ok(Date.now() - started < 5000)
})

test('返回非 http 地址算失败', async () => {
  const code = `const { on, send, EVENT_NAMES } = globalThis.lx
on(EVENT_NAMES.request, () => Promise.resolve('not a url'))
send(EVENT_NAMES.inited, { sources: { wy: { actions: ['musicUrl'], qualitys: ['128k'] } } })`
  const source = await loadLxSource(code, 'x.js')
  await assert.rejects(source.musicUrl('wy', '128k', { source: 'wy', name: '', singer: '', albumName: '', songmid: '1', hash: '1', id: '1', interval: 0 }), /不是 http/)
})

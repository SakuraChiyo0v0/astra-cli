/**
 * pixiv 的 curl 传输层。
 *
 * 事故背景（2026-10-28）：日报 50 张只下到 16 张，34 条 HTTP 403。排查发现
 * **Cloudflare 按 TLS/HTTP 指纹判定**：同一个 cookie，Node 的 undici 请求
 * www.pixiv.net 是 403，换成 curl 就是 200。所以带 cookie 时改走 curl 子进程。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { curlArgs, pickTransport } from '../src/pixiv/api.ts'

test('curl 参数：带 cookie + 代理时三样都在', () => {
  const args = curlArgs('https://www.pixiv.net/ajax/illust/1', 'PHPSESSID=abc', 'http://mihomo:7890')
  assert.ok(args.includes('-H'))
  assert.ok(args.includes('Cookie: PHPSESSID=abc'))
  const at = args.indexOf('-x')
  assert.ok(at >= 0)
  assert.equal(args[at + 1], 'http://mihomo:7890')
  assert.equal(args.at(-1), 'https://www.pixiv.net/ajax/illust/1')
})

test('curl 参数：没有 cookie 就不塞 Cookie 头', () => {
  const args = curlArgs('https://www.pixiv.net/ajax/illust/1', '', null)
  assert.ok(!args.some((a) => a.startsWith('Cookie:')))
  assert.ok(!args.includes('-x'))
})

test('curl 参数：UA 与 Referer 必带（缺一个就是 403）', () => {
  const args = curlArgs('https://www.pixiv.net/x', 'k=v', null)
  assert.ok(args.some((a) => a.startsWith('User-Agent: Mozilla/5.0')))
  assert.ok(args.includes('Referer: https://www.pixiv.net/'))
})

test('URL 永远在最后（curl 只认最后一个裸参数）', () => {
  const url = 'https://www.pixiv.net/ajax/user/11/profile/all'
  assert.equal(curlArgs(url, 'k=v', 'http://p:1').at(-1), url)
  assert.equal(curlArgs(url, '', null).at(-1), url)
})

test('通道选择：auto 有 cookie 走 curl、没 cookie 走 fetch', () => {
  // 环境里没配 pixiv.transport 时默认 auto
  assert.equal(pickTransport('PHPSESSID=abc'), 'curl')
  assert.equal(pickTransport(''), 'fetch')
})

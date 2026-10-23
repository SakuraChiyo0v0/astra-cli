/**
 * 代理传输层：方法、body、重试、错误归一。
 *
 * 这些用本地起一个真代理（CONNECT 隧道 + 回固定响应）来测，不走外网。
 * 起因是一个真事故：`httpRequest` 只在命中 include 时转发 headers，
 * 方法硬写成 GET、body 丢掉 —— 而 `proxy.include` 留空表示"全部走"，
 * 于是只要配了 URL 不配 include，网易云登录、红心、webhook 全变成空 GET。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'

/** 一个会说 HTTP/1.1 的假目标服务器，直接挂在隧道后面。 */
interface Seen {
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

let server: http.Server
let port = 0
const seen: Seen[] = []
/** 让测试指定下一次响应：返回 null 走默认。 */
let respond: ((res: http.ServerResponse) => void) | null = null

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      if (respond) {
        respond(res)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** 假 CONNECT 代理：接受隧道后原样转发到真目标。 */
async function startTunnelProxy(): Promise<{ close: () => Promise<void>; proxyUrl: string; connections: number }> {
  const state = { connections: 0 }
  const proxy = http.createServer((_req, res) => {
    res.writeHead(400)
    res.end()
  })
  proxy.on('connect', (req, clientSocket, head) => {
    state.connections += 1
    const [host, targetPort] = (req.url ?? '').split(':')
    const upstream = net.connect(Number(targetPort), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyPort = (proxy.address() as AddressInfo).port
  return {
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    connections: state.connections,
    close: () => new Promise<void>((resolve) => proxy.close(() => resolve())),
  }
}

function reset(): void {
  seen.length = 0
  respond = null
}

test('经代理的 POST：方法、body、Content-Length 原样到达', async () => {
  reset()
  const proxy = await startTunnelProxy()
  try {
    const { proxiedRequest } = await import('../src/core/proxy.ts')
    const body = 'params=abc&type=3'
    const result = await proxiedRequest(`http://127.0.0.1:${port}/weapi/login`, {
      proxyUrl: proxy.proxyUrl,
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'test-agent' },
    })
    assert.equal(result.status, 200)
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.method, 'POST', '不能被写成 GET')
    assert.equal(seen[0]!.body, body, 'body 不能丢')
    assert.equal(seen[0]!.headers['content-length'], String(Buffer.byteLength(body)))
    assert.equal(seen[0]!.headers['content-type'], 'application/x-www-form-urlencoded')
    assert.equal(seen[0]!.headers['user-agent'], 'test-agent')
  } finally {
    await proxy.close()
  }
})

test('经代理的 GET：不带 body 时不发 Content-Length', async () => {
  reset()
  const proxy = await startTunnelProxy()
  try {
    const { proxiedRequest } = await import('../src/core/proxy.ts')
    await proxiedRequest(`http://127.0.0.1:${port}/api/x?cc=cn`, { proxyUrl: proxy.proxyUrl })
    assert.equal(seen[0]!.method, 'GET')
    assert.equal(seen[0]!.path, '/api/x?cc=cn')
    assert.equal(seen[0]!.headers['content-length'], undefined)
  } finally {
    await proxy.close()
  }
})

test('经代理的 PUT / DELETE 也不被改成 GET', async () => {
  reset()
  const proxy = await startTunnelProxy()
  try {
    const { proxiedRequest } = await import('../src/core/proxy.ts')
    await proxiedRequest(`http://127.0.0.1:${port}/a`, { proxyUrl: proxy.proxyUrl, method: 'DELETE' })
    await proxiedRequest(`http://127.0.0.1:${port}/b`, { proxyUrl: proxy.proxyUrl, method: 'PUT', body: '{"x":1}' })
    assert.deepEqual(seen.map((s) => s.method), ['DELETE', 'PUT'])
    assert.equal(seen[1]!.body, '{"x":1}')
  } finally {
    await proxy.close()
  }
})

test('chunked 响应能解出正文', async () => {
  reset()
  const proxy = await startTunnelProxy()
  try {
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"a":')
      res.write('1}')
      res.end()
    }
    const { proxiedRequest } = await import('../src/core/proxy.ts')
    const result = await proxiedRequest(`http://127.0.0.1:${port}/chunked`, { proxyUrl: proxy.proxyUrl })
    assert.equal(result.body.toString('utf8'), '{"a":1}')
  } finally {
    await proxy.close()
  }
})

test('服务器无视 identity 照样 gzip 时能解开，且头部改成解压后的长度', async () => {
  reset()
  const proxy = await startTunnelProxy()
  try {
    const payload = JSON.stringify({ message: '被限流了' })
    respond = (res) => {
      res.writeHead(429, { 'content-encoding': 'gzip', 'content-type': 'application/json' })
      res.end(zlib.gzipSync(Buffer.from(payload, 'utf8')))
    }
    const { proxiedRequest } = await import('../src/core/proxy.ts')
    const result = await proxiedRequest(`http://127.0.0.1:${port}/gzipped`, { proxyUrl: proxy.proxyUrl })
    assert.equal(result.status, 429)
    assert.equal(result.body.toString('utf8'), payload)
    assert.equal(result.headers['content-encoding'], undefined, '解压后不能再声称是 gzip')
    assert.equal(result.headers['content-length'], String(Buffer.byteLength(payload)))
  } finally {
    await proxy.close()
  }
})

test('代理连不上：抛的是 TimeoutError 之外的可识别错误，不是裸字符串', async () => {
  const { proxiedRequest } = await import('../src/core/proxy.ts')
  await assert.rejects(
    () => proxiedRequest('http://127.0.0.1:1/x', { proxyUrl: 'http://127.0.0.1:1', timeoutMs: 1500 }),
    (err: Error) => {
      assert.equal(err.name, 'Error')
      assert.match(err.message, /ECONNREFUSED|代理/)
      return true
    },
  )
})

test('代理拒绝建隧道时报出 CONNECT 状态码', async () => {
  const refusing = http.createServer()
  refusing.on('connect', (_req, socket) => {
    socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
    socket.destroy()
  })
  await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', resolve))
  const refusingPort = (refusing.address() as AddressInfo).port
  try {
    const { proxiedRequest } = await import('../src/core/proxy.ts')
    await assert.rejects(
      () => proxiedRequest('http://example.com/x', { proxyUrl: `http://127.0.0.1:${refusingPort}`, timeoutMs: 3000 }),
      /CONNECT 407/,
    )
  } finally {
    await new Promise<void>((resolve) => refusing.close(() => resolve()))
  }
})

test('SOCKS 之类不支持的协议直接拒绝，不去猜', async () => {
  const { proxiedRequest } = await import('../src/core/proxy.ts')
  await assert.rejects(() => proxiedRequest('http://example.com/', { proxyUrl: 'socks5://127.0.0.1:1080' }), /只支持 http/)
})

test('非 http/https 的目标协议直接拒绝', async () => {
  const proxy = await startTunnelProxy()
  try {
    const { proxiedRequest } = await import('../src/core/proxy.ts')
    await assert.rejects(() => proxiedRequest('ftp://example.com/x', { proxyUrl: proxy.proxyUrl }), /只支持 http/)
  } finally {
    await proxy.close()
  }
})

// ---------- http.ts 这一层：调用方无感，错误契约不破 ----------

/** 用 ASTRA_PROXY 让 httpRequest 走代理（它自己读配置，不接受注入）。 */
async function withProxyEnv<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ASTRA_PROXY
  const prevInclude = process.env.ASTRA_PROXY_INCLUDE
  const prevExclude = process.env.ASTRA_PROXY_EXCLUDE
  process.env.ASTRA_PROXY = url
  // 机器上的真实配置可能配了 include（例如只让 steam 走代理），
  // 那样 example.com 会直连、这个用例就永远绿不了。显式清空，用例只测代理行为本身。
  process.env.ASTRA_PROXY_INCLUDE = ''
  process.env.ASTRA_PROXY_EXCLUDE = ''
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.ASTRA_PROXY
    else process.env.ASTRA_PROXY = prev
    if (prevInclude === undefined) delete process.env.ASTRA_PROXY_INCLUDE
    else process.env.ASTRA_PROXY_INCLUDE = prevInclude
    if (prevExclude === undefined) delete process.env.ASTRA_PROXY_EXCLUDE
    else process.env.ASTRA_PROXY_EXCLUDE = prevExclude
  }
}

test('httpRequest 经代理时：POST 的 body 不被吞掉', async () => {
  reset()
  const proxy = await startTunnelProxy()
  try {
    await withProxyEnv(proxy.proxyUrl, async () => {
      const { httpRequest } = await import('../src/core/http.ts')
      const response = await httpRequest(`http://127.0.0.1:${port}/eapi/song/enhance/player/url`, {
        method: 'POST',
        body: 'params=xyz',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
      assert.equal(response.status, 200)
      assert.equal(await response.text(), '{"ok":true}')
    })
    assert.equal(seen[0]!.method, 'POST')
    assert.equal(seen[0]!.body, 'params=xyz')
  } finally {
    await proxy.close()
  }
})

test('httpRequest 经代理时：5xx 仍按 retries 重试', async () => {
  reset()
  const proxy = await startTunnelProxy()
  try {
    let hits = 0
    respond = (res) => {
      hits += 1
      if (hits === 1) {
        res.writeHead(503)
        res.end('busy')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    }
    await withProxyEnv(proxy.proxyUrl, async () => {
      const { httpRequest } = await import('../src/core/http.ts')
      const response = await httpRequest(`http://127.0.0.1:${port}/retry`, { retries: 1 })
      assert.equal(response.status, 200, '第一次 503 应该重试')
    })
    assert.equal(hits, 2)
  } finally {
    await proxy.close()
  }
})

test('代理连不上：归一成 NETWORK_ERROR / exitCode 5 / 可重试，且给代理相关的 hint', async () => {
  await withProxyEnv('http://127.0.0.1:1', async () => {
    const { httpRequest } = await import('../src/core/http.ts')
    await assert.rejects(
      () => httpRequest('http://example.com/x', { retries: 0 }),
      (err: { code?: string; exitCode?: number; retryable?: boolean; hint?: string | null }) => {
        assert.equal(err.code, 'NETWORK_ERROR', '不能漏成 INTERNAL')
        assert.equal(err.exitCode, 5)
        assert.equal(err.retryable, true)
        assert.match(err.hint ?? '', /代理/)
        return true
      },
    )
  })
})

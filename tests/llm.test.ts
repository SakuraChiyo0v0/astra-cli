import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMultipart,
  extractChatText,
  normalizeSize,
  pickImagePayload,
  sanitizeErrorText,
} from '../src/llm/api.ts'
import { maskKey, normalizeBaseUrl, resolveProvider, upsertProvider, emptyStore } from '../src/llm/store.ts'

test('maskKey 只露前 4 后 2', () => {
  assert.equal(maskKey('sk-abcdefghijklmn'), 'sk-a…mn')
  assert.equal(maskKey('short'), '***')
  assert.equal(maskKey(''), '***')
})

test('normalizeBaseUrl 统一补 /v1 并去尾斜杠', () => {
  assert.equal(normalizeBaseUrl('http://model-gateway:8788'), 'http://model-gateway:8788/v1')
  assert.equal(normalizeBaseUrl('http://model-gateway:8788/v1'), 'http://model-gateway:8788/v1')
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1///'), 'https://api.openai.com/v1')
  assert.throws(() => normalizeBaseUrl('model-gateway:8788'), /base-url/)
})

test('normalizeSize 认三档，其他档位报错', () => {
  assert.equal(normalizeSize(undefined), '1024x1024')
  assert.equal(normalizeSize('1536X1024'), '1536x1024')
  assert.throws(() => normalizeSize('512x512'), /不支持的 size/)
})

test('extractChatText 兼容字符串与分段数组', () => {
  assert.equal(extractChatText({ choices: [{ message: { content: '甲' } }] }), '甲')
  assert.equal(
    extractChatText({ choices: [{ message: { content: [{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }] } }] }),
    '甲乙',
  )
  assert.equal(extractChatText({} as never), '')
})

test('pickImagePayload 认 b64 与 url 两种', () => {
  assert.deepEqual(pickImagePayload({ data: [{ b64_json: 'AAA' }] }), { b64: 'AAA' })
  assert.deepEqual(pickImagePayload({ data: [{ url: 'http://x/y.png' }] }), { url: 'http://x/y.png' })
  assert.deepEqual(pickImagePayload({}), {})
})

test('sanitizeErrorText 打码 key 并截断', () => {
  const key = 'sk-super-secret-key-1234'
  const text = `Invalid token ${key} for request`
  assert.equal(sanitizeErrorText(text, key).includes('super-secret'), false)
  assert.equal(sanitizeErrorText('x'.repeat(400), '').endsWith('…'), true)
})

test('buildMultipart 生成合法边界与文件段', () => {
  const { body, contentType } = buildMultipart(
    { model: 'gpt-image-1', prompt: '改成夜景' },
    { field: 'image', filename: 'a.png', contentType: 'image/png', bytes: Buffer.from('PNGDATA') },
  )
  const boundary = contentType.split('boundary=')[1]
  const text = body.toString('utf8')
  assert.ok(text.startsWith(`--${boundary}`))
  assert.ok(text.includes('name="model"'))
  assert.ok(text.includes('prompt') && text.includes('改成夜景'))
  assert.ok(text.includes('filename="a.png"'))
  assert.ok(text.includes('PNGDATA'))
  assert.ok(text.endsWith(`--${boundary}--\r\n`))
})

test('resolveProvider 回落到 default，缺省报错', () => {
  const store = emptyStore()
  assert.throws(() => resolveProvider(store), /还没有配任何端点/)
  upsertProvider(store, { name: 'gw', baseUrl: 'http://a/v1', apiKey: 'k', models: { chat: 'm' }, addedAt: 'now' }, false)
  assert.equal(resolveProvider(store).name, 'gw')
  assert.equal(resolveProvider(store, 'gw').name, 'gw')
  assert.throws(() => resolveProvider(store, 'nope'), /没有这个端点/)
})

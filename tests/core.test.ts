import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { feishuSign } from '../src/core/notify.ts'

test('飞书签名：以 "timestamp\\nsecret" 为 key 对空串 HmacSHA256 再 base64', () => {
  const expected = createHmac('sha256', '1599360473\ndemo').update(Buffer.alloc(0)).digest('base64')
  assert.equal(feishuSign(1599360473, 'demo'), expected)
})

test('配置：未知键 / 非法值被拒，密钥列出时打码', async () => {
  process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-cfg-'))
  const { setConfig, getConfig, listConfig } = await import('../src/core/config.ts')
  assert.throws(() => setConfig('music.qualty', 'flac'), /未知配置项/)
  assert.throws(() => setConfig('music.quality', 'lossless'), /不合法/)
  assert.throws(() => setConfig('notify.feishu_webhook', 'https://example.com/hook'), /不是飞书/)
  setConfig('music.quality', '320k')
  assert.equal(getConfig('music.quality'), '320k')
  setConfig('notify.feishu_secret', 'abc')
  assert.equal(listConfig().find((c) => c.key === 'notify.feishu_secret')?.value, '已设置（不显示）')
})

/**
 * 后台任务结束时的通知。只支持飞书自定义机器人 webhook（群里加一个机器人即可，不需要开放平台应用）。
 *
 * 没配置就什么都不做；发送失败只写进日志，不影响任务结果。
 * 支持签名校验（机器人开了"签名校验"时填 secret）。
 */
import { createHmac } from 'node:crypto'
import { getConfig } from './config.ts'
import { httpRequest } from './http.ts'
import { progress } from './output.ts'

export function feishuSign(timestamp: number, secret: string): string {
  // 飞书的签名算法：以 "timestamp\nsecret" 作为 key，对空串做 HmacSHA256
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
}

export async function notify(text: string): Promise<boolean> {
  const webhook = process.env.ASTRA_FEISHU_WEBHOOK || getConfig('notify.feishu_webhook')
  if (!webhook) return false
  const secret = process.env.ASTRA_FEISHU_SECRET || getConfig('notify.feishu_secret')
  const body: Record<string, unknown> = { msg_type: 'text', content: { text } }
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000)
    body.timestamp = String(timestamp)
    body.sign = feishuSign(timestamp, secret)
  }
  try {
    const response = await httpRequest(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 10_000,
      retries: 2,
    })
    const result = (await response.json().catch(() => ({}))) as { code?: number; msg?: string }
    if (result.code !== undefined && result.code !== 0) {
      progress('notify.failed', { code: result.code, msg: result.msg })
      return false
    }
    return response.ok
  } catch (err) {
    progress('notify.failed', { error: (err as Error).message })
    return false
  }
}

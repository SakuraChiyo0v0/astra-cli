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

/**
 * 发通知：把所有**已配置**的通道都发一遍，任一成功即返回 true。
 *
 * 支持：飞书自定义机器人（webhook+签名）、Telegram Bot API、通用 webhook（POST {"text": ...}）。
 * 没配置的通道静默跳过 —— 这是「离开 Hermes 也能用」的一部分。
 */
export async function notify(text: string): Promise<boolean> {
  const results = await Promise.all([feishu(text), telegram(text), webhook(text)])
  return results.some(Boolean)
}

/** 当前有哪些通道可用（`astra notify providers` 用）。 */
export function notifyProviders(): Array<{ name: string; configured: boolean }> {
  return [
    { name: 'feishu', configured: Boolean(process.env.ASTRA_FEISHU_WEBHOOK || getConfig('notify.feishu_webhook')) },
    { name: 'telegram', configured: Boolean(telegramToken()) && Boolean(getConfig('notify.telegram_chat')) },
    { name: 'webhook', configured: Boolean(getConfig('notify.webhook_url')) },
  ]
}

function telegramToken(): string {
  return (process.env.ASTRA_TELEGRAM_TOKEN || getConfig('notify.telegram_token') || '').trim()
}

async function telegram(text: string): Promise<boolean> {
  const token = telegramToken()
  const chat = (getConfig('notify.telegram_chat') || '').trim()
  if (!token || !chat) return false
  try {
    const response = await httpRequest(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      timeoutMs: 10_000,
      retries: 2,
    })
    const result = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string }
    if (result.ok === false) {
      progress('notify.telegram_failed', { error: result.description })
      return false
    }
    return response.ok
  } catch (err) {
    progress('notify.telegram_failed', { error: (err as Error).message })
    return false
  }
}

async function webhook(text: string): Promise<boolean> {
  const url = (getConfig('notify.webhook_url') || '').trim()
  if (!url) return false
  try {
    const response = await httpRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      timeoutMs: 10_000,
      retries: 2,
    })
    return response.ok
  } catch (err) {
    progress('notify.webhook_failed', { error: (err as Error).message })
    return false
  }
}

async function feishu(text: string): Promise<boolean> {
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

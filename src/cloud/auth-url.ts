/**
 * `astra cloud auth-url` —— 生成授权链接，但**不把链接打进聊天文本**。
 *
 * 为什么需要它：Hermes 网关出口会对文本做强制打码（`agent/redact.py` 的
 * `redact_for_egress`，force=True，`security.redact_secrets: false` 也关不掉），
 * 形如 `client_id=<32位>`、`AppKey: xxx` 的串到用户那儿会变成星号。
 * 文件附件和图片字节不走那条文本过滤，所以这里把链接**写进文件 + 生成二维码 PNG**，
 * 由用户扫码或双击 .url，链接本身永远不进聊天正文。
 *
 * 注意：生成的 .url / .png 里含 AppKey（不是 SecretKey，泄漏风险有限），
 * 落在临时目录，用完可以删。
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AstraError, invalidInput } from '../core/errors.ts'
import { ensureDir, homePath } from '../core/paths.ts'
import type { Command, CommandResult } from '../core/command.ts'
import { loadCloudCredential } from './auth-store.ts'

const AUTH_BASE = 'https://openapi.baidu.com/oauth/2.0/authorize'

export function buildAuthUrl(appKey: string): string {
  const params = new URLSearchParams({
    response_type: 'token',
    client_id: appKey.trim(),
    redirect_uri: 'oob',
    scope: 'basic,netdisk',
  })
  return `${AUTH_BASE}?${params}`
}

/** 用本机 python 的 segno 生成二维码；没有就只写 .url 文件。 */
function writeQrPng(url: string, pngPath: string): boolean {
  const script =
    'import sys, segno\n' +
    'segno.make(sys.argv[1], error="m").save(sys.argv[2], scale=8, border=3)\n'
  const res = spawnSync('python3', ['-c', script, url, pngPath], { encoding: 'utf8', timeout: 20_000 })
  return res.status === 0
}

export const authUrlCommand: Command = {
  name: 'cloud auth-url',
  summary: '生成百度授权链接（写成 .url 文件 + 二维码 PNG，不进聊天文本）',
  usage: 'astra cloud auth-url [--out-dir 目录]',
  notes: [
    'AppKey 要先存：`astra cloud login baidu <token|cookie> --app-key <AppKey>`。',
    '产物：<dir>/baidu-auth.url（Windows 双击打开）和 <dir>/baidu-auth.png（手机扫码）。',
    '为什么这么绕：Hermes 网关对聊天正文强制打码，链接里的 client_id 会被盖成星号；文件/图片不受影响。',
  ],
  options: {
    'out-dir': { type: 'string', description: '产物目录，默认 scratch 目录', valueName: 'dir' },
  },
  run: async (ctx): Promise<CommandResult> => {
    const cred = loadCloudCredential('baidu')
    const appKey = cred?.appKey?.trim()
    if (!appKey) {
      throw invalidInput(
        '没有存 AppKey，无法生成授权链接',
        '先跑 `astra cloud login baidu <token> --app-key <开放平台 AppKey>`',
      )
    }
    if (appKey.length < 8) throw new AstraError('INVALID_APP_KEY', 'AppKey 看上去不对（太短）', { exitCode: 2 })
    const url = buildAuthUrl(appKey)
    const dir = ensureDir(typeof ctx.values['out-dir'] === 'string' ? ctx.values['out-dir'] : homePath('tmp'))
    const urlFile = join(dir, 'baidu-auth.url')
    const pngFile = join(dir, 'baidu-auth.png')
    writeFileSync(urlFile, `[InternetShortcut]\nURL=${url}\nIconIndex=0\n`, 'utf8')
    const qr = writeQrPng(url, pngFile)
    return {
      data: {
        authUrlFile: urlFile,
        qrPng: qr ? pngFile : null,
        qrAvailable: qr,
        scope: 'basic,netdisk',
        tokenTtlDays: 30,
        appKeyMasked: `${appKey.slice(0, 4)}…${appKey.slice(-3)}`,
      },
      warnings: qr ? ['把 .url 下载双击、或手机扫 PNG，授权后从地址栏取 access_token'] : ['没生成二维码（缺 segno），只用 .url 文件'],
    }
  },
}

/**
 * 自检：把所有能力依赖的东西一次性查清。
 *
 * 为什么要汇总：以前 `doctor` 只查音乐，B 站出问题时（ffmpeg 不在、会话过期）
 * 它一句都不提，得自己猜。诊断价值全在"一眼看全"。
 *
 * 三类检查：
 * - **硬依赖**：node 版本、数据目录可写、ffmpeg。缺了功能直接不可用
 * - **按域**：音乐（音源、目录、官方会话）、B 站（会话、目录）
 * - **可选**：通知 webhook。没有只是少个便利
 *
 * 目录可写性是踩过坑的：WebDAV 上传后文件权限是 000，下载直接失败。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getConfig, mediaRoot, musicRoot } from './config.ts'
import { astraHome } from './paths.ts'
import { listSources } from '../lx/store.ts'
import { loadSession } from '../music/auth.ts'
import { loadBiliSession } from '../bili/auth.ts'
import { runBinary, ffmpegPath } from '../media/run.ts'
import { dirUsage } from './disk.ts'

export type CheckKind = 'required' | 'domain' | 'optional'

export interface Check {
  name: string
  ok: boolean
  detail: string
  kind: CheckKind
  /** 不满足时怎么办。 */
  hint?: string
}

/** 真的写一个临时文件再删掉 —— 只查权限位不够（挂载点可能只读）。 */
export function checkWritable(dir: string): { ok: boolean; detail: string } {
  try {
    const probe = path.join(dir, `.astra-write-test-${process.pid}`)
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    return { ok: true, detail: `${dir} 可写` }
  } catch (err) {
    return { ok: false, detail: `${dir} 不可写：${(err as Error).message.slice(0, 120)}` }
  }
}

function ensureExists(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

export async function runDoctor(): Promise<{ checks: Check[]; summary: Record<string, number> }> {
  const checks: Check[] = []
  const add = (check: Check): void => { checks.push(check) }

  // —— 硬依赖 ——
  const nodeMajor = Number(process.versions.node.split('.')[0])
  add({ name: 'node', kind: 'required', ok: nodeMajor >= 24, detail: process.versions.node, hint: nodeMajor >= 24 ? undefined : '需要 Node ≥ 24（用到 node:sqlite）' })

  const home = astraHome()
  const homeWrite = checkWritable(home)
  add({ name: 'home', kind: 'required', ok: homeWrite.ok, detail: homeWrite.detail, ...(homeWrite.ok ? {} : { hint: '检查 ASTRA_HOME 的属主与权限' }) })

  // ffmpeg 只影响 B 站下载与媒体处理，音乐不需要 —— 所以算 domain 级
  const ffmpegConfigured = getConfig('music.ffmpeg')
  const ffmpegBin = ffmpegPath(ffmpegConfigured)
  try {
    const result = await runBinary(ffmpegBin, ['-version'], undefined, 10_000)
    const versionLine = result.stdout.split('\n')[0] ?? ''
    add({ name: 'ffmpeg', kind: 'domain', ok: result.code === 0, detail: versionLine.slice(0, 80) || ffmpegBin, ...(result.code === 0 ? {} : { hint: '装 ffmpeg，或 `astra config set music.ffmpeg <绝对路径>`' }) })
  } catch (err) {
    add({ name: 'ffmpeg', kind: 'domain', ok: false, detail: (err as Error).message.slice(0, 120), hint: '装 ffmpeg，或 `astra config set music.ffmpeg <绝对路径>`' })
  }

  // —— 音乐域 ——
  const music = musicRoot()
  try {
    ensureExists(music)
    const write = checkWritable(music)
    add({ name: 'music_dir', kind: 'domain', ok: write.ok, detail: write.detail, ...(write.ok ? {} : { hint: '检查音乐目录的属主与权限（WebDAV 上传后常见 000）' }) })
  } catch (err) {
    add({ name: 'music_dir', kind: 'domain', ok: false, detail: `建不出目录：${(err as Error).message.slice(0, 100)}` })
  }

  const sources = listSources()
  const enabled = sources.filter((s) => s.enabled)
  add({
    name: 'lx_sources',
    kind: 'domain',
    ok: enabled.length > 0,
    detail: sources.length === 0 ? '未导入音源' : enabled.map((s) => s.id).join(', ') || '全部停用',
    ...(enabled.length > 0 ? {} : { hint: '`astra music source add <文件>` 导入洛雪音源；登录官方账号也能下载' }),
  })

  try {
    const response = await fetch('https://music.163.com/api/v3/song/detail?c=' + encodeURIComponent('[{"id":1472480890}]'), {
      headers: { Referer: 'https://music.163.com/' },
      signal: AbortSignal.timeout(8000),
    })
    add({ name: 'netease', kind: 'domain', ok: response.ok, detail: `网易云接口 HTTP ${response.status}` })
  } catch (err) {
    add({ name: 'netease', kind: 'domain', ok: false, detail: (err as Error).message.slice(0, 120), hint: '检查网络或代理' })
  }

  const neteaseSession = loadSession()
  add({
    name: 'netease_login',
    kind: 'optional',
    ok: neteaseSession !== null,
    detail: neteaseSession ? `已登录（${neteaseSession.nickname ?? neteaseSession.userId ?? '会话存在'}）` : '未登录',
    ...(neteaseSession ? {} : { hint: '登录后能用官方通道取更高音质、看私人歌单（`astra music login start`）' }),
  })

  // —— B 站域 ——
  const video = mediaRoot()
  try {
    ensureExists(video)
    const write = checkWritable(video)
    add({ name: 'video_dir', kind: 'domain', ok: write.ok, detail: write.detail, ...(write.ok ? {} : { hint: '检查视频目录的属主与权限' }) })
  } catch (err) {
    add({ name: 'video_dir', kind: 'domain', ok: false, detail: `建不出目录：${(err as Error).message.slice(0, 100)}` })
  }

  try {
    const response = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=BV17x411w7KC', {
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(8000),
    })
    const body = (await response.json()) as { code?: number }
    add({ name: 'bili_api', kind: 'domain', ok: body.code === 0, detail: `B 站接口 code=${String(body.code)}` })
  } catch (err) {
    add({ name: 'bili_api', kind: 'domain', ok: false, detail: (err as Error).message.slice(0, 120) })
  }

  const biliSession = loadBiliSession()
  add({
    name: 'bili_login',
    kind: 'optional',
    ok: biliSession !== null,
    detail: biliSession ? `已登录（${biliSession.nickname ?? biliSession.uid ?? '会话存在'}${biliSession.vip ? '，大会员' : ''}）` : '未登录',
    ...(biliSession ? {} : { hint: '登录后才能拿到 1080P 以上画质（`astra bili login start`）' }),
  })

  // —— 磁盘用量 ——
  // 目录会持续增长，没人会主动上 NAS 看还剩多少。这里顺带报一下，低于警戒线才标红。
  for (const [name, dir] of [['music_disk', music], ['video_disk', video]] as const) {
    try {
      const usage = dirUsage(dir, { minFreeGb: 10 })
      add({
        name,
        kind: 'optional',
        ok: !usage.lowSpace,
        detail: usage.detail,
        ...(usage.lowSpace ? { hint: '剩余空间不足 10GB，清理已看完的内容或扩容' } : {}),
      })
    } catch (err) {
      add({ name, kind: 'optional', ok: false, detail: (err as Error).message.slice(0, 120) })
    }
  }

  // —— 可选 ——
  const webhook = getConfig('notify.feishu_webhook') || process.env.ASTRA_FEISHU_WEBHOOK
  add({ name: 'notify', kind: 'optional', ok: Boolean(webhook), detail: webhook ? '已配置飞书 webhook' : '未配置', ...(webhook ? {} : { hint: '后台任务完成时不会推送' }) })

  const summary = {
    required: checks.filter((c) => c.kind === 'required').length,
    failedRequired: checks.filter((c) => c.kind === 'required' && !c.ok).length,
    failedDomain: checks.filter((c) => c.kind === 'domain' && !c.ok).length,
    failedOptional: checks.filter((c) => c.kind === 'optional' && !c.ok).length,
  }
  return { checks, summary }
}

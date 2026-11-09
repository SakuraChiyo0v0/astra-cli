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
import { getConfig } from './config.ts'
import { astraHome } from './paths.ts'
import { runBinary, ffmpegPath } from './ffmpeg.ts'
import { maybeProxiedRequest, proxyConfig } from './proxy.ts'
import { dirUsage } from './disk.ts'
import { loadAllDomains } from './domains-runtime.ts'
import { stateDb } from './state.ts'
import { redact } from './db/index.ts'
import { legacyStatePath, legacyStatePending } from './db/import-state.ts'

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

  // 状态库：0.56.0 起和资产库是同一个库。连得上、状态表在，CLI 才能跑
  try {
    const current = await stateDb()
    const legacy = legacyStatePending(current)
    add({ name: 'state', kind: 'required', ok: true, detail: `${current.dialect.name}：${redact(current.url)}` })
    if (legacy) {
      // 升级上来、老 astra.db 还没搬：曲库 / 任务历史 / 订阅都还在老文件里，新库里看不到
      add({ name: 'state-import', kind: 'optional', ok: false, detail: `老状态库还在：${legacyStatePath()}`, hint: '跑一次 `astra db import-state` 把曲库、任务、订阅搬进当前库' })
    }
  } catch (err) {
    add({ name: 'state', kind: 'required', ok: false, detail: (err as Error).message.slice(0, 160), hint: '检查 `astra db status` 与 db-url' })
  }

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

  // —— 各领域自己的检查（音乐 / B 站 / 漫画 …）——
  // 0.56.0 起由领域在 manifest 里声明 `doctor`，core 不再 import 领域代码
  const disks: Array<[string, string]> = []
  const ctx = { add, checkWritable, ensureExists, watchDisk: (name: string, dir: string) => { disks.push([name, dir]) } }
  for (const d of await loadAllDomains()) {
    if (!d.doctor) continue
    try {
      await d.doctor(ctx)
    } catch (err) {
      add({ name: `${d.name}_doctor`, kind: 'domain', ok: false, detail: `检查本身出错：${(err as Error).message.slice(0, 120)}` })
    }
  }

  // —— 磁盘用量 ——
  // 目录会持续增长，没人会主动上 NAS 看还剩多少。这里顺带报一下，低于警戒线才标红。
  for (const [name, dir] of disks) {
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

  // —— 代理 ——
  const proxy = proxyConfig()
  if (proxy) {
    const included = proxy.include.length > 0 ? proxy.include.join(', ') : '（全部）'
    add({
      name: 'proxy',
      kind: 'domain',
      ok: true,
      detail: `${proxy.url}，走代理：${included}；直连：${proxy.exclude.join(', ') || '（无）'}`,
    })
    // 连通性：拿一个走代理的域名试一下
    const probeHost = proxy.include[0] ?? 'steampowered.com'
    try {
      const result = await maybeProxiedRequest(`https://${probeHost}/`, { timeoutMs: 10_000 })
      add({
        name: 'proxy_reachable',
        kind: 'domain',
        ok: result !== null && result.status < 500,
        detail: result === null ? `${probeHost} 不走代理（检查 proxy.include）` : `经代理访问 ${probeHost} → HTTP ${result.status}`,
        ...(result === null ? { hint: '把这个域名加进 `proxy.include`' } : {}),
      })
    } catch (err) {
      add({ name: 'proxy_reachable', kind: 'domain', ok: false, detail: `经代理访问失败：${(err as Error).message.slice(0, 100)}`, hint: '检查 proxy.url 和代理容器是否在同一个 docker 网络' })
    }
  } else {
    add({ name: 'proxy', kind: 'optional', ok: true, detail: '未配置代理（Steam 这类被墙的域名不可用）', hint: '需要时：`astra config set proxy.url http://<代理>:<端口>`' })
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

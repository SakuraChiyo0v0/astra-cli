/**
 * 分区排行榜。
 *
 * 接口：`/x/web-interface/ranking/v2?rid=<分区id>&type=all|rookie`
 * - 免登录、免签名，实测稳定（2026-11-01）
 * - 一次固定返回约 100 条，`limit` 只是本地截断
 * - rid=0 是全站
 *
 * 分区 id 是 B 站内部编号，不给名字的话只能靠记，所以这里维护一张常用表；
 * 传数字就直接当 rid 用，不在表里也不拦（B 站分区会调整，硬拦反而碍事）。
 */
import { AstraError } from '../core/errors.ts'
import { httpRequest } from '../core/http.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

/** 常用分区（一级分区 + 几个高频二级）。 */
export const RID_MAP: Record<string, number> = {
  全站: 0,
  动画: 1,
  番剧: 13,
  国创: 167,
  音乐: 3,
  舞蹈: 129,
  游戏: 4,
  知识: 36,
  科技: 188,
  运动: 234,
  汽车: 223,
  生活: 160,
  美食: 211,
  动物: 217,
  鬼畜: 119,
  时尚: 155,
  资讯: 202,
  影视: 181,
  娱乐: 5,
  电影: 23,
  电视剧: 11,
  纪录片: 177,
  虚拟UP: 1551,
}

/** 名字或数字 → rid。认不出返回 null，由调用方决定报错还是透传。 */
export function parseRid(input: string): number | null {
  const text = (input ?? '').trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text)
  if (text in RID_MAP) return RID_MAP[text]!
  const lower = text.toLowerCase()
  for (const [name, rid] of Object.entries(RID_MAP)) {
    if (name.toLowerCase() === lower) return rid
  }
  return null
}

export interface RankItem {
  bvid: string
  title: string
  owner: string
  view: number
  like: number
  danmaku: number
  duration: number
  pubdate: number
  /** 综合得分（B 站自己算的排序分） */
  score: number
}

export async function fetchRanking(
  rid: number,
  opts: { limit?: number; rookie?: boolean } = {},
  signal?: AbortSignal,
): Promise<{ rid: number; total: number; items: RankItem[] }> {
  const type = opts.rookie ? 'rookie' : 'all'
  const url = `https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=${type}`
  const options: Parameters<typeof httpRequest>[1] = {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    timeoutMs: 15_000,
    retries: 1,
  }
  if (signal) options.signal = signal
  const response = await httpRequest(url, options)
  if (!response.ok) throw new AstraError('BILI_HTTP', `B 站排行榜返回 HTTP ${response.status}`, { exitCode: 5, retryable: response.status >= 500 })
  const body = (await response.json()) as {
    code: number
    message?: string
    data?: { list?: RawRank[] | null }
  }
  if (body.code !== 0) {
    throw new AstraError('BILI_API_ERROR', `B 站排行榜失败（code=${body.code}${body.message ? `：${body.message}` : ''}）`, {
      exitCode: 5,
      details: { code: body.code },
    })
  }
  const all = (body.data?.list ?? []).map(mapRank)
  const limit = Math.max(1, Math.min(opts.limit ?? 20, all.length || 20))
  return { rid, total: all.length, items: all.slice(0, limit) }
}

interface RawRank {
  bvid?: string
  title?: string
  owner?: { name?: string }
  stat?: { view?: number; like?: number; danmaku?: number }
  duration?: number
  pubdate?: number
  score?: number
}

/** 拍平成 RankItem（纯函数，方便单测）。 */
export function mapRank(row: RawRank): RankItem {
  return {
    bvid: row.bvid ?? '',
    title: (row.title ?? '').trim(),
    owner: row.owner?.name ?? '',
    view: row.stat?.view ?? 0,
    like: row.stat?.like ?? 0,
    danmaku: row.stat?.danmaku ?? 0,
    duration: row.duration ?? 0,
    pubdate: row.pubdate ?? 0,
    score: row.score ?? 0,
  }
}

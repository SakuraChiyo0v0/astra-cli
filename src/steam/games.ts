/**
 * 把用户说的游戏名解析成 AppID。
 *
 * 规则（和 ASF 那边一致，避免误挂）：
 * - 纯数字 → 当 AppID
 * - 否则先找**完全同名**（忽略大小写），再退到包含匹配
 * - 匹配到多个一律报错并列出候选，让用户说得更具体，绝不猜
 */
import { AstraError, invalidInput } from '../core/errors.ts'
import type { OwnedGame } from './api.ts'

export function pickGames(owned: OwnedGame[], tokens: string[]): OwnedGame[] {
  const picked: OwnedGame[] = []
  const seen = new Set<number>()

  for (const token of tokens) {
    const text = token.trim()
    if (!text) continue

    let hit: OwnedGame | undefined
    if (/^\d+$/.test(text)) {
      hit = owned.find((game) => game.appId === Number(text))
      if (!hit) throw invalidInput(`库里没有 AppID ${text}`, '先 `astra steam library` 看看有哪些游戏')
    } else {
      const needle = text.toLowerCase()
      const exact = owned.filter((game) => game.name.toLowerCase() === needle)
      const candidates = exact.length > 0 ? exact : owned.filter((game) => game.name.toLowerCase().includes(needle))
      if (candidates.length === 0) throw invalidInput(`没找到名字包含「${text}」的游戏`, '用 `astra steam library` 看全部名字')
      if (candidates.length > 1) {
        const names = candidates.slice(0, 8).map((game) => game.name).join('、')
        throw new AstraError('STEAM_GAME_AMBIGUOUS', `「${text}」匹配到多个：${names}`, {
          exitCode: 2,
          hint: '说得更具体一点（加引号的完整名字）',
        })
      }
      hit = candidates[0]
    }

    if (hit && !seen.has(hit.appId)) {
      seen.add(hit.appId)
      picked.push(hit)
    }
  }

  if (picked.length === 0) throw invalidInput('没有要挂的游戏', '给至少一个游戏名或 AppID')
  return picked
}

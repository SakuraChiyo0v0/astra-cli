/**
 * 把用户输入收成 album / photo id。
 *
 * 接受：纯数字、JM123、带 /album/ /photo/ 的链接。
 */
import { invalidInput } from '../core/errors.ts'

export type ComicTarget =
  | { kind: 'album'; id: string }
  | { kind: 'photo'; id: string }

export function parseComicTarget(input: string): ComicTarget {
  const raw = input.trim()
  if (!raw) throw invalidInput('缺少漫画编号或链接', '例如 `astra comic get 123456` 或贴一条带 /album/ 的链接')

  const albumMatch = raw.match(/\/album\/(\d+)/i)
  if (albumMatch) return { kind: 'album', id: albumMatch[1]! }

  const photoMatch = raw.match(/\/photo\/(\d+)/i)
  if (photoMatch) return { kind: 'photo', id: photoMatch[1]! }

  const jm = raw.match(/^(?:JM|jm)?(\d+)$/)
  if (jm) return { kind: 'album', id: jm[1]! }

  throw invalidInput(`认不出漫画编号：${raw}`, '给数字车号、JM123，或含 /album/<id> / /photo/<id> 的链接')
}

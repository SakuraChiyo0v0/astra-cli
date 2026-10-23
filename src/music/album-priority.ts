/**
 * 同一首歌出现在多张专辑里时，判断哪张才是"它的原专辑"。
 *
 * 背景（P4#5）：给 Michael Jackson 一次下 5 张专辑，5 个 job 并行。
 * astra 做全局去重（同一首只存一份），但判据只看"这首歌在不在库里" ——
 * 于是胜负由**下载完成顺序**决定，等于随机。
 *
 * 实测后果：HIStory（1995 精选集）抢到了 Billie Jean / Man In the Mirror，
 * 而 Thriller（1982）/ Bad（1987）把这几首判成 skipped。
 * 播放器里点开 Thriller，缺了它最招牌的歌 —— 用户看到的是"专辑不完整"，
 * 不是"重复被去掉了"。
 *
 * 这里给的是一套**与下载顺序无关**的固定优先级。
 */

export interface AlbumCandidate {
  /** 专辑 id。 */
  id: string
  /** 专辑名（只用于日志与说明）。 */
  name: string
  /** 发行时间（毫秒）。null = 不知道。 */
  publishTime: number | null
  /** 专辑类型（`录音室版` / `精选集` / …）。null = 不知道。 */
  type: string | null
  /** 这首歌在这张专辑里的曲目号。 */
  trackNo: number | null
}

/**
 * 专辑类型的分档：数字越小越"原始"。
 *
 * 不认识 / 不知道的类型按**中间档**处理，不放到最前也不放到最后 ——
 * 把未知当成"精选集"会让真·原专辑被它压过，当成"录音室"又会让精选集压过原专辑。
 * 中间档意味着遇到未知时**退回看年份**，那是更可靠的判据。
 */
export function albumTypeRank(type: string | null | undefined): number {
  const t = (type ?? '').trim()
  if (!t) return 2
  // 录音室专辑：最原始
  if (/录音室|studio/i.test(t)) return 1
  // EP / 单曲：通常也是原始发行，但内容少，排在录音室之后
  if (/^EP$|^单曲|single/i.test(t)) return 2
  // 精选 / 合辑 / 现场 / 原声：都是"二手"收录
  if (/精选|合辑|合集|现场|原声|compilation|live|soundtrack/i.test(t)) return 4
  // 其它（Remix / 混音 / 伴奏 / DJ 版…）最靠后
  if (/remix|混音|伴奏|karaoke|instrumental|dj/i.test(t)) return 5
  return 2
}

/**
 * a 是否比 b 更该拥有这首歌。返回 true 表示 a 优先。
 *
 * 判据顺序（清单定的）：
 * 1. **发行年份最早** —— Thriller 1982 胜过 HIStory 1995
 * 2. 同年时：录音室 > EP/单曲 > 未知 > 精选/合辑/现场/原声 > Remix
 * 3. 再相同：tracknumber 靠前
 * 4. 还分不出（比如两张都不知年份、同类型、都无 trackNo）→ false，
 *    保持现状（先占者不动）。**不随机、不因下载顺序翻转。**
 */
export function preferredAlbum(a: AlbumCandidate, b: AlbumCandidate): boolean {
  // 1) 年份
  const aTime = a.publishTime ?? null
  const bTime = b.publishTime ?? null
  if (aTime !== null && bTime !== null && aTime !== bTime) return aTime < bTime
  // 只有一方知道年份时：知道的那方优先（有信息总比没信息强，且年份是硬证据）
  if (aTime !== null && bTime === null) return true
  if (aTime === null && bTime !== null) return false

  // 2) 专辑类型
  const aRank = albumTypeRank(a.type)
  const bRank = albumTypeRank(b.type)
  if (aRank !== bRank) return aRank < bRank

  // 3) 曲目号
  if (a.trackNo !== null && b.trackNo !== null && a.trackNo !== b.trackNo) return a.trackNo < b.trackNo

  // 4) 分不出来：保持现状
  return false
}

/**
 * 从若干候选里挑出"最该拥有这首歌"的那张。
 *
 * 空数组返回 null。全部并列时返回**第一个**（调用方传进来的顺序），
 * 但调用点应当把它当成"没有更优解"处理，而不是"这就是答案"。
 */
export function pickOwnerAlbum(candidates: AlbumCandidate[]): AlbumCandidate | null {
  if (candidates.length === 0) return null
  let best = candidates[0]!
  for (const c of candidates.slice(1)) {
    if (preferredAlbum(c, best)) best = c
  }
  return best
}

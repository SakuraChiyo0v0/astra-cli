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
 * **实测（2026-10-23）网易云的 `type` 字段几乎永远是 `"专辑"`** ——
 * 它并不区分录音室版和精选集。实测 `沈香学(2023)` 和
 * `ZUTOMAYO - 2026 Special Edition` 都返回 `"专辑"`。
 *
 * 所以这个分档在真实数据上基本只能落到"中间档"，**判归属实际靠的是年份**。
 * 保住它是因为：类型一旦能拿到（别的音源、或网易云以后细分），判据就自动生效；
 * 而拿不到时它会返回中间档，自然退回年份比较 —— 不会给出错误结论。
 *
 * 不认识 / 不知道的类型按**中间档**处理，不放最前也不放最后：
 * 放最前会让未知压过真·原专辑，放最后会让精选集压过原专辑。
 */
export function albumTypeRank(type: string | null | undefined): number {
  const t = (type ?? '').trim()
  if (!t) return 2
  // 精选 / 合辑 / 现场 / 原声：都是"二手"收录。**这条要放在"专辑"之前**，
  // 因为"精选集"这种描述里也可能带"专辑"字样
  if (/精选|合辑|合集|现场|原声|compilation|greatest hits|live|soundtrack/i.test(t)) return 4
  // 录音室 / 普通专辑：最原始
  if (/录音室|studio|^专辑$|^album$/i.test(t)) return 1
  // EP / 单曲：通常也是原始发行，但内容少
  if (/^EP$|^单曲|single/i.test(t)) return 2
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
 * 这次下载**是否值得**把已有文件归位到更该拥有它的专辑。
 *
 * 两个条件都必须成立：
 * 1. 已有那份是"二手"专辑（精选 / 合辑 / 现场 / 原声）
 * 2. 现在这张更原始（类型更靠前）或者更早
 *
 * **这只是"值得做"，不是"要做"** —— 实际动不动还要看 `--reassign`。
 * 默认绝不动已落盘的文件（P4#6）：`file_path` 是事实，用户可能已经按它
 * 整理过、备份过、建过播放列表，为了一个推测出来的偏好去改是在赌他的数据。
 */
export function deservesReassign(theirs: AlbumCandidate, mine: AlbumCandidate): boolean {
  // **年份是主要判据**，类型只是补充 —— 实测网易云的 type 几乎永远是"专辑"，
  // 靠它分不出精选集和录音室版。
  //
  // 要求：双方年份都知道，且这张**严格更早**；或者已有那份类型明确是二手。
  const strictlyOlder = theirs.publishTime !== null && mine.publishTime !== null && mine.publishTime < theirs.publishTime
  const mineMoreOriginal = albumTypeRank(mine.type) < albumTypeRank(theirs.type)

  // 类型能区分时才用类型（例如已有的是"精选集"、新的是"专辑"）
  if (theirsSecondary(theirs) && mineMoreOriginal) return true
  // 否则只认年份早。**同年、或任一方不知道年份 → 不动**
  return strictlyOlder
}

/** 已有那份是不是"二手"专辑（精选 / 合辑 / 现场 / 原声）。 */
function theirsSecondary(a: AlbumCandidate): boolean {
  return albumTypeRank(a.type) >= 4
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

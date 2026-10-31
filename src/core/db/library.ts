/**
 * 资产库核心：指纹、入库、对账（scan）、查询。
 *
 * 关键设计：
 * - **身份与位置分离**：asset 是「这首歌/这张图」，file 是「它在哪个盘的哪个相对路径」
 * - **位置永远存相对路径**（相对 root），换挂载点只改 roots.abs_path 一行
 * - **移动靠内容指纹认领**：文件挪走后，用 `size + 前 1MB sha1` 匹配到原记录，改 rel_path 并留事件
 * - **不删记录**：扫不到就标 `missing`，人看清单再决定
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { Database } from './index.ts'

/** 读文件前 1MB 算 sha1。比全量 sha256 快两个数量级，用于「这俩是不是同一个文件」。 */
export async function quickHash(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(file, { start: 0, end: 1024 * 1024 - 1 })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 指纹 = `size-sha1(前1MB)`。size 一起带上，避免不同大小但前 1MB 相同的误判。 */
export async function fingerprint(file: string): Promise<string> {
  const size = statSync(file).size
  const head = await quickHash(file)
  return `${size}-${head}`
}

export interface RootRow {
  id: string
  label: string
  abs_path: string
  note: string | null
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export async function listRoots(db: Database): Promise<RootRow[]> {
  return db.conn.query<RootRow>('select id, label, abs_path, note from roots order by label')
}

export async function addRoot(db: Database, label: string, absPath: string, note?: string): Promise<RootRow> {
  const existing = await db.conn.query<RootRow>('select id, label, abs_path, note from roots where label = ?', [label])
  const abs = path.resolve(absPath)
  if (existing[0]) {
    await db.conn.exec('update roots set abs_path = ?, note = ? where id = ?', [abs, note ?? null, existing[0].id])
    return { ...existing[0], abs_path: abs, note: note ?? null }
  }
  const row: RootRow = { id: newId('root'), label, abs_path: abs, note: note ?? null }
  await db.conn.exec(
    'insert into roots (id, label, abs_path, note, created_at) values (?, ?, ?, ?, ?)',
    [row.id, row.label, row.abs_path, row.note, new Date().toISOString()],
  )
  return row
}

/** 删根。还有 file 引用时拒绝 —— 否则那些记录会变成孤儿。 */
export async function removeRoot(db: Database, label: string): Promise<{ removed: boolean; files: number }> {
  const rows = await db.conn.query<{ id: string }>('select id from roots where label = ?', [label])
  const root = rows[0]
  if (!root) return { removed: false, files: 0 }
  const count = Number((await db.conn.query<{ n: number | string }>(
    'select count(*) as n from files where root_id = ?',
    [root.id],
  ))[0]?.n ?? 0)
  if (count > 0) return { removed: false, files: count }
  await db.conn.exec('delete from roots where id = ?', [root.id])
  return { removed: true, files: 0 }
}

async function event(
  db: Database,
  kind: string,
  assetId: string | null,
  fileId: string | null,
  detail: unknown,
): Promise<void> {
  await db.conn.exec(
    'insert into events (at, kind, asset_id, file_id, detail) values (?, ?, ?, ?, ?)',
    [new Date().toISOString(), kind, assetId, fileId, detail === null ? null : JSON.stringify(detail)],
  )
}

export interface AssetInput {
  platform: string
  nativeId: string
  kind?: string
  title: string
  artists?: string | null
  album?: string | null
  durationMs?: number | null
  meta?: unknown
}

/** 资产 id 用确定性值，重复入库不会产生两条。 */
export function assetId(platform: string, nativeId: string): string {
  return `${platform}:${nativeId}`
}

export async function upsertAsset(db: Database, input: AssetInput): Promise<string> {
  const id = assetId(input.platform, input.nativeId)
  const now = new Date().toISOString()
  // 先查再写，**不要靠捕获主键冲突**：PG 里一条语句报错会把整个事务置为 aborted，
  // 后面的语句全失败（实测 adopt 同内容图片时报 duplicate key 然后整批回滚）。
  const existing = await db.conn.query<{ id: string }>('select id from assets where id = ?', [id])
  if (existing.length > 0) {
    await db.conn.exec(
      'update assets set title = ?, artists = ?, album = ?, duration_ms = ?, meta = ? where id = ?',
      [input.title, input.artists ?? null, input.album ?? null, input.durationMs ?? null,
        input.meta === undefined ? null : JSON.stringify(input.meta), id],
    )
    return id
  }
  await db.conn.exec(
    `insert into assets (id, platform, native_id, kind, title, artists, album, duration_ms, meta, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.platform,
      input.nativeId,
      input.kind ?? 'music',
      input.title,
      input.artists ?? null,
      input.album ?? null,
      input.durationMs ?? null,
      input.meta === undefined ? null : JSON.stringify(input.meta),
      now,
    ],
  )
  return id
}

export interface FileInput {
  assetId: string
  rootId: string
  relPath: string
  size?: number | null
  mtime?: string | null
  hash?: string | null
  sha256?: string | null
}

export async function upsertFile(db: Database, input: FileInput): Promise<string> {
  const now = new Date().toISOString()
  const existing = await db.conn.query<{ id: string }>(
    'select id from files where root_id = ? and rel_path = ?',
    [input.rootId, input.relPath],
  )
  if (existing[0]) {
    await db.conn.exec(
      'update files set asset_id = ?, size = ?, mtime = ?, hash = ?, sha256 = ?, state = ?, last_seen = ? where id = ?',
      [input.assetId, input.size ?? null, input.mtime ?? null, input.hash ?? null,
        input.sha256 ?? null, 'present', now, existing[0].id],
    )
    return existing[0].id
  }
  const id = newId('file')
  await db.conn.exec(
    `insert into files (id, asset_id, root_id, rel_path, size, mtime, hash, sha256, state, first_seen, last_seen)
     values (?, ?, ?, ?, ?, ?, ?, ?, 'present', ?, ?)`,
    [id, input.assetId, input.rootId, input.relPath, input.size ?? null, input.mtime ?? null,
      input.hash ?? null, input.sha256 ?? null, now, now],
  )
  return id
}

/** 下载完成后登记：资产 + 位置 + 事件，一个事务里做完。 */
export async function recordDownload(
  db: Database,
  asset: AssetInput,
  file: Omit<FileInput, 'assetId'>,
  extra?: { sha256?: string | null },
): Promise<{ assetId: string; fileId: string }> {
  return db.conn.tx(async (tx) => {
    const inner: Database = { ...db, conn: tx }
    const id = await upsertAsset(inner, asset)
    const fileId = await upsertFile(inner, { ...file, assetId: id, sha256: extra?.sha256 ?? file.sha256 })
    await event(inner, 'downloaded', id, fileId, { rel_path: file.relPath, size: file.size })
    return { assetId: id, fileId }
  })
}

export interface ScanResult {
  roots: number
  scanned: number
  moved: { assetId: string; from: string; to: string }[]
  missing: { fileId: string; relPath: string }[]
  /** 盘上有、库里没有的文件（不建 asset，只报数量 + 前 50 个） */
  orphans: { relPath: string; size: number }[]
  orphanCount: number
  unchanged: number
  healed: number
  durationMs: number
}

export interface WalkEntry {
  abs: string
  size: number
  dev: string
  ino: string
  mtimeMs: number
}

/**
 * 遍历目录，顺带把 stat 结果带回来。
 *
 * 为什么不在调用方再 stat 一次：`readdir` 已经拿到 dirent，但 size/mtime 还是要 stat；
 * 走一趟就取全，扫描的 syscall 数量少一半（线上 2045 个文件差 1 秒左右）。
 * stat 失败的文件直接跳过——扫不到不等于删了，下次再算。
 */
async function walk(dir: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walk(full)))
      continue
    }
    if (!entry.isFile()) continue
    try {
      const st = statSync(full)
      out.push({ abs: full, size: st.size, dev: String(st.dev), ino: String(st.ino), mtimeMs: Math.round(st.mtimeMs) })
    } catch {
      // 读不到就跳过
    }
  }
  return out
}

/** 有上限的并发 map，避免一次打开几百个文件句柄。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

/** 只读 size，不读内容 —— 绝大多数文件靠 size 就能排除。 */
function sizeOf(file: string): number | null {
  try {
    return statSync(file).size
  } catch {
    return null
  }
}

/**
 * 对账。
 *
 * 性能要点（实测 845 个文件从 62s 降到几秒）：
 * 1. 先按 `rel_path + size` 直接判定「没动」，**不算指纹**
 * 2. size 在库里根本不存在的，直接算孤儿，**不算指纹**
 * 3. 只有「size 撞上了但路径变了」才读前 1MB 算指纹，且并发 8 个
 */
export async function scan(
  db: Database,
  options: { roots?: string[]; concurrency?: number } = {},
): Promise<ScanResult> {
  const started = Date.now()
  const allRoots = await listRoots(db)
  const targets = options.roots && options.roots.length > 0
    ? allRoots.filter((r) => options.roots!.includes(r.label))
    : allRoots
  const concurrency = options.concurrency ?? 8

  // 跨 root 的墓碑：文件从 A 挪到 B 时，A 里是 missing、B 里是孤儿，
  // 只看本 root 的记录永远接不上（抄 git-annex 的 location log 思路：位置可跨库迁移）。
  const tombstones = await db.conn.query<{
    id: string; asset_id: string; rel_path: string; root_id: string; hash: string; state: string
    size: number | string | null
  }>("select id, asset_id, rel_path, root_id, hash, state, size from files where state = 'missing' and hash is not null")
  const tombByHash = new Map(tombstones.map((t) => [t.hash, t]))
  // 墓碑的 size 也要参与「按 size 剪枝」的豁免：否则跨 root 搬家的文件在
  // 目标 root 里 size 对不上任何记录，会被直接判成孤儿，根本走不到指纹那一步。
  const tombSizes = new Set(tombstones.map((t) => Number(t.size)).filter((n) => Number.isFinite(n)))

  const moved: ScanResult['moved'] = []
  const missing: ScanResult['missing'] = []
  const orphans: { relPath: string; size: number }[] = []
  let scanned = 0
  let unchanged = 0
  let healed = 0
  let orphanCount = 0

  for (const root of targets) {
    const rows = await db.conn.query<{
      id: string; asset_id: string; rel_path: string; size: number | null; hash: string | null
      dev: string | null; ino: string | null; mtime_ms: number | null; state: string
    }>('select id, asset_id, rel_path, size, hash, dev, ino, mtime_ms, state from files where root_id = ?', [root.id])
      // PG 的 bigint 走 JSON 是**字符串**（size / mtime_ms 都可能），不转成数字的话
      // `row.size === entry.size` 永远为 false —— 表现是每次扫描都全量重算指纹，
      // 实测第二遍 220 秒，比第一遍还慢。这个坑很隐蔽，必须在这里统一转。
      .then((list) => list.map((r) => ({
        ...r,
        size: r.size === null ? null : Number(r.size),
        mtime_ms: r.mtime_ms === null ? null : Number(r.mtime_ms),
      })))

    const byPath = new Map(rows.map((r) => [r.rel_path, r]))
    const byHash = new Map<string, typeof rows[number]>()
    // inode 只当线索：Filebeat 文档明确说设备号在 LVM / 网络共享 / 容器里会变，
    // 所以命中才认，不命中继续走指纹。
    const byInode = new Map<string, typeof rows[number]>()
    const bySize = new Map<number, number>()
    const bySizeRows = new Map<number, typeof rows>()
    let unknownSize = 0
    for (const r of rows) {
      if (r.hash) byHash.set(r.hash, r)
      if (r.dev && r.ino) byInode.set(`${r.dev}:${r.ino}`, r)
      if (r.size === null) unknownSize += 1
      else {
        bySize.set(r.size, (bySize.get(r.size) ?? 0) + 1)
        const bucket = bySizeRows.get(r.size) ?? []
        bucket.push(r)
        bySizeRows.set(r.size, bucket)
      }
    }
    // 还有 size 未知的行时不能按 size 剪枝（否则「移动 + 未知 size」的文件会被误判成孤儿）
    const canPruneBySize = unknownSize === 0

    const seen = new Set<string>()
    const files = await walk(root.abs_path)

    // 图片在音乐库里是附属（cover.jpg），在 pixiv 库里就是资产本身。
    // 空 root（第一次扫描）没有记录可参考，就看盘上文件的类型分布 ——
    // 否则「往空目录里搬进来一张图」会被当成 sidecar 直接跳过，跨 root 复活永远失败。
    const isImage = (p: string): boolean => /\.(jpe?g|png|webp|gif|bmp)$/i.test(p)
    const isAv = (p: string): boolean => /\.(mp4|mkv|flv|webm|mov|mp3|flac|m4a|wav)$/i.test(p)
    const imageRoot = rows.length > 0
      ? rows.some((r) => isImage(r.rel_path))
      : files.filter((f) => isImage(f.abs)).length > files.filter((f) => isAv(f.abs)).length
    // .nfo/.ass/.srt 这类是 sidecar，永远不是资产
    const skipExt = imageRoot
      ? /\.(tmp|part|log|json|txt|md|nfo|ass|ssa|vtt|srt|db|sqlite|lrc|cue|m3u|m3u8|sfv|url)$/i
      : /\.(tmp|part|log|json|txt|md|jpg|jpeg|png|webp|gif|bmp|nfo|ass|ssa|vtt|srt|db|sqlite|lrc|cue|m3u|m3u8|sfv|url)$/i
    const candidates: { abs: string; rel: string; size: number; dev: string; ino: string; mtimeMs: number }[] = []
    /** inode 命中、直接判为移动的（不读内容）。 */
    const inodeMoves: { entry: WalkEntry; rel: string; row: typeof rows[number] }[] = []

    // 第一遍：路径没变的直接认领（顺带把 size / 指纹 / dev-ino-mtime 补齐）
    const matched: { entry: WalkEntry; rel: string; size: number; row: typeof rows[number] }[] = []
    for (const entry of files) {
      const base = path.basename(entry.abs)
      if (base.startsWith('.')) continue
      if (skipExt.test(base)) continue
      scanned += 1
      const rel = path.relative(root.abs_path, entry.abs)
      const size = entry.size
      const same = byPath.get(rel)
      if (same) {
        matched.push({ entry, rel, size, row: same })
        seen.add(same.id)
        continue
      }
      // 路径变了但 inode 没变 → 同一文件系统内的 rename，零拷贝认回
      const byIno = byInode.get(`${entry.dev}:${entry.ino}`)
      if (byIno && !seen.has(byIno.id)) {
        seen.add(byIno.id)
        inodeMoves.push({ entry, rel, row: byIno })
        continue
      }
      if (canPruneBySize && !bySize.has(size) && !tombSizes.has(size)) {
        // size 在库里根本不存在 → 一定是新文件，不用读内容
        orphanCount += 1
        if (orphans.length < 50) orphans.push({ relPath: rel, size })
      } else {
        candidates.push({ abs: entry.abs, rel, size, dev: entry.dev, ino: entry.ino, mtimeMs: entry.mtimeMs })
      }
    }

    await mapLimit(matched, concurrency, async (item) => {
      unchanged += 1
      const now = new Date().toISOString()
      const identity = [item.entry.dev, item.entry.ino, item.entry.mtimeMs]
      // 原来标了 missing、现在原路回来 —— 也要报，否则「丢了又回来」完全静默
      const wasMissing = item.row.state === 'missing'
      // size + mtime 都没变 → 内容不可能变，跳过读文件（抄 restic / Nextcloud 的判据）
      if (item.row.hash && item.row.size === item.size && item.row.mtime_ms === item.entry.mtimeMs) {
        await db.conn.exec(
          'update files set last_seen = ?, state = ?, dev = ?, ino = ?, mtime_ms = ? where id = ?',
          [now, 'present', ...identity, item.row.id],
        )
        if (wasMissing) {
          await event(db, 'revived', item.row.asset_id, item.row.id, { rel_path: item.rel, root: root.label, via: 'path' })
          moved.push({ assetId: item.row.asset_id, from: item.rel, to: item.rel })
        }
        return
      }
      // 老数据 size 不可信（tracks.bytes 不是文件大小）、指纹也空：这里补齐
      let fp: string | null = null
      try {
        fp = `${item.size}-${await quickHash(item.entry.abs)}`
      } catch {
        fp = null
      }
      if (fp) byHash.set(fp, item.row)
      await db.conn.exec(
        'update files set size = ?, hash = coalesce(?, hash), state = ?, last_seen = ?, dev = ?, ino = ?, mtime_ms = ? where id = ?',
        [item.size, fp, 'present', now, ...identity, item.row.id],
      )
      if (fp && !item.row.hash) healed += 1
      if (wasMissing) {
        await event(db, 'revived', item.row.asset_id, item.row.id, { rel_path: item.rel, root: root.label, via: 'path' })
        moved.push({ assetId: item.row.asset_id, from: item.rel, to: item.rel })
      }
    })

    // inode 命中：同盘 rename，直接改路径，一个字节都不用读
    for (const item of inodeMoves) {
      const from = item.row.rel_path
      await db.conn.exec(
        'update files set rel_path = ?, size = ?, state = ?, last_seen = ?, dev = ?, ino = ?, mtime_ms = ? where id = ?',
        [item.rel, item.entry.size, 'present', new Date().toISOString(),
          item.entry.dev, item.entry.ino, item.entry.mtimeMs, item.row.id],
      )
      // 删除后重建经常复用同一个 inode，所以这里也要区分「移动」和「复活」
      const inodeKind = item.row.state === 'missing' ? 'revived' : 'moved'
      if (inodeKind === 'revived' || from !== item.rel) {
        await event(db, inodeKind, item.row.asset_id, item.row.id, { from, to: item.rel, root: root.label, via: 'inode' })
        moved.push({ assetId: item.row.asset_id, from, to: item.rel })
      }
    }

    // 第二遍：路径不在库里的，算指纹去认领「被移动的文件」
    await mapLimit(candidates, concurrency, async (item) => {
      let fp: string
      try {
        fp = `${item.size}-${await quickHash(item.abs)}`
      } catch {
        return
      }
      const hit = byHash.get(fp)
      if (hit && !seen.has(hit.id)) {
        seen.add(hit.id)
        const from = hit.rel_path
        await db.conn.exec(
          'update files set rel_path = ?, size = ?, hash = ?, state = ?, last_seen = ?, dev = ?, ino = ?, mtime_ms = ? where id = ?',
          [item.rel, item.size, fp, 'present', new Date().toISOString(), item.dev, item.ino, item.mtimeMs, hit.id],
        )
        // 墓碑复活（之前扫不到、现在回来了）与移动都要记进 moved，否则调用方看不到
        const kind = hit.state === 'missing' ? 'revived' : 'moved'
        if (kind === 'revived' || from !== item.rel) {
          await event(db, kind, hit.asset_id, hit.id, { from, to: item.rel, root: root.label, via: 'fingerprint' })
          moved.push({ assetId: hit.asset_id, from, to: item.rel })
        }
        return
      }
      // 刚入库的行还没有指纹（recordDownload 不读内容），
      // size 能唯一对上一条未认领的记录时，就按「移动」处理
      const bucket = bySizeRows.get(item.size) ?? []
      const healable = bucket.filter((r) => !r.hash && !seen.has(r.id))
      if (healable.length === 1) {
        const target = healable[0]!
        seen.add(target.id)
        const from = target.rel_path
        await db.conn.exec(
          'update files set rel_path = ?, size = ?, hash = ?, state = ?, last_seen = ?, dev = ?, ino = ?, mtime_ms = ? where id = ?',
          [item.rel, item.size, fp, 'present', new Date().toISOString(), item.dev, item.ino, item.mtimeMs, target.id],
        )
        await event(db, 'moved', target.asset_id, target.id, { from, to: item.rel, root: root.label, via: 'size-heal' })
        moved.push({ assetId: target.asset_id, from, to: item.rel })
        return
      }
      // 跨 root 复活：这个文件的指纹在别的 root 里是一条 missing 记录
      const tomb = tombByHash.get(fp)
      if (tomb && !seen.has(tomb.id)) {
        seen.add(tomb.id)
        tombByHash.delete(fp)
        const fromRoot = allRoots.find((r) => r.id === tomb.root_id)?.label ?? '?'
        await db.conn.exec(
          `update files set rel_path = ?, root_id = ?, size = ?, hash = ?, state = 'present', last_seen = ?,
                            dev = ?, ino = ?, mtime_ms = ? where id = ?`,
          [item.rel, root.id, item.size, fp, new Date().toISOString(),
            item.dev, item.ino, item.mtimeMs, tomb.id],
        )
        await event(db, 'revived', tomb.asset_id, tomb.id, {
          from: tomb.rel_path, to: item.rel, fromRoot, toRoot: root.label, via: 'fingerprint',
        })
        moved.push({ assetId: tomb.asset_id, from: tomb.rel_path, to: item.rel })
        return
      }
      orphanCount += 1
      if (orphans.length < 50) orphans.push({ relPath: item.rel, size: item.size })
    })

    // 没认领到的标 missing（不删记录）
    //
    // **只报「刚刚丢失」的**：已经 missing 的记录每次扫描都再报一遍，
    // 会让 10 分钟一次的巡检变成复读机（实测 28 个文件刷了一整晚屏）。
    // 它们仍然会被重新检查——文件一旦回来就走上面的 revived 分支。
    for (const r of rows) {
      if (seen.has(r.id)) continue
      if (r.state === 'missing') continue
      await db.conn.exec("update files set state = 'missing' where id = ?", [r.id])
      missing.push({ fileId: r.id, relPath: r.rel_path })
      await event(db, 'missing', r.asset_id, r.id, { rel_path: r.rel_path, root: root.label })
    }
  }

  const result: ScanResult = {
    roots: targets.length,
    scanned,
    moved,
    missing,
    orphans,
    orphanCount,
    unchanged,
    healed,
    durationMs: Date.now() - started,
  }
  // 一次扫描只留一条汇总事件，避免孤儿文件把 events 表刷爆
  await event(db, 'scan', null, null, {
    roots: result.roots, scanned, unchanged, healed,
    moved: moved.length, missing: missing.length, orphans: orphanCount,
  })
  return result
}

export interface AdoptResult {
  dryRun: boolean
  adopted: number
  withBvid: number
  local: number
  skipped: number
  items: { relPath: string; assetId: string; kind: string }[]
}

/** 从同名 .nfo 里抠 BV 号（B 站下载器写的 sidecar）。 */
function bvidFromNfo(nfoPath: string): string | null {
  try {
    const raw = readFileSync(nfoPath, 'utf8')
    const match = raw.match(/BV[0-9A-Za-z]{10}/)
    return match ? match[0] : null
  } catch {
    return null
  }
}

/** 从 nfo 里读标题和 UP 名，读不到就用文件名。 */
function nfoMeta(nfoPath: string): { title: string | null; uploader: string | null } {
  try {
    const raw = readFileSync(nfoPath, 'utf8')
    const title = raw.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? null
    const uploader = raw.match(/<name>([\s\S]*?)<\/name>/)?.[1]?.trim() ?? null
    return { title, uploader }
  } catch {
    return { title: null, uploader: null }
  }
}

/**
 * 认领孤儿文件：给「盘上有、库里没有」的文件建 asset + file。
 *
 * 身份怎么定（重要）：
 * - 有同名 `.nfo` 且里面带 BV 号 → `bili:<BV>_p<分P>`，这是最可靠的
 * - 没有平台 id → `local:<指纹>`。**用内容指纹当 id**，文件挪了也不会变成两条
 *   （代价：重新压制的同一部片子会被当成新资产，这比用路径当 id 好）
 */
export async function adopt(
  db: Database,
  options: { roots?: string[]; kinds?: string[]; dryRun?: boolean; limit?: number } = {},
): Promise<AdoptResult> {
  const allRoots = await listRoots(db)
  const targets = options.roots && options.roots.length > 0
    ? allRoots.filter((r) => options.roots!.includes(r.label))
    : allRoots
  const result: AdoptResult = {
    dryRun: options.dryRun === true, adopted: 0, withBvid: 0, local: 0, skipped: 0, items: [],
  }
  const limit = options.limit ?? Number.POSITIVE_INFINITY

  for (const root of targets) {
    const known = new Set(
      (await db.conn.query<{ rel_path: string }>('select rel_path from files where root_id = ?', [root.id]))
        .map((r) => r.rel_path),
    )
    const files = await walk(root.abs_path)
    for (const entry of files) {
      if (result.adopted >= limit) break
      const abs = entry.abs
      const base = path.basename(abs)
      if (base.startsWith('.')) continue
      const ext = path.extname(base).toLowerCase()
      // 只认领媒体文件；sidecar（nfo/jpg/ass/lrc）跳过
      if (!['.mp4', '.mkv', '.flv', '.webm', '.mov', '.mp3', '.flac', '.m4a', '.jpg', '.jpeg', '.png', '.webp'].includes(ext)) continue
      if (options.kinds && options.kinds.length > 0) {
        const isVideo = ['.mp4', '.mkv', '.flv', '.webm', '.mov'].includes(ext)
        const isAudio = ['.mp3', '.flac', '.m4a'].includes(ext)
        const isImage = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)
        if (!(options.kinds.includes('video') && isVideo)
          && !(options.kinds.includes('audio') && isAudio)
          && !(options.kinds.includes('image') && isImage)) continue
      }
      const rel = path.relative(root.abs_path, abs)
      if (known.has(rel)) {
        result.skipped += 1
        continue
      }

      // B 站下载器的 sidecar 有两套命名：`x.nfo` 和 `x.Metadata.nfo`，都要认
      const stem = abs.replace(/\.[^.]+$/, '')
      const nfoCandidates = [`${stem}.nfo`, `${stem}.Metadata.nfo`]
      let nfo: string | null = null
      let bvid: string | null = null
      for (const candidate of nfoCandidates) {
        if (!existsSync(candidate)) continue
        const found = bvidFromNfo(candidate)
        if (found) {
          nfo = candidate
          bvid = found
          break
        }
        if (!nfo) nfo = candidate
      }
      const meta = nfo ? nfoMeta(nfo) : { title: null, uploader: null }
      const size = entry.size
      const fp = `${size}-${await quickHash(abs)}`

      const kind = ['.mp4', '.mkv', '.flv', '.webm', '.mov'].includes(ext) ? 'video'
        : ['.mp3', '.flac', '.m4a'].includes(ext) ? 'audio' : 'image'

      const assetIdValue = bvid ? `bili:${bvid}_p1` : `local:${fp}`
      const title = meta.title || path.basename(base, ext)
      if (result.dryRun) {
        result.adopted += 1
        if (bvid) result.withBvid += 1
        else result.local += 1
        result.items.push({ relPath: rel, assetId: assetIdValue, kind })
        continue
      }

      await db.conn.tx(async (tx) => {
        const inner: Database = { ...db, conn: tx }
        await upsertAsset(inner, {
          platform: bvid ? 'bili' : 'local',
          nativeId: bvid ? `${bvid}_p1` : fp,
          kind,
          title,
          artists: meta.uploader ?? null,
          meta: { root: root.label, source: bvid ? 'nfo' : 'fingerprint' },
        })
        await upsertFile(inner, { assetId: assetIdValue, rootId: root.id, relPath: rel, size, hash: fp })
        await event(inner, 'adopted', assetIdValue, null, { rel_path: rel, via: bvid ? 'nfo-bvid' : 'fingerprint' })
      })
      known.add(rel)
      result.adopted += 1
      if (bvid) result.withBvid += 1
      else result.local += 1
      result.items.push({ relPath: rel, assetId: assetIdValue, kind })
    }
  }
  return result
}

export interface VerifyResult {
  checked: number
  matched: number
  mismatched: { relPath: string; absPath: string; expected: string; actual: string }[]
  filled: number
  skippedLarge: number
  durationMs: number
}

/** 整文件 sha256（流式，避免把几 GB 的视频读进内存）。 */
export async function fileSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * 抽样校验：确认盘上的内容和库里记的一致（防止「同大小文件被替换」）。
 *
 * 只看 `present` 的文件；`files.sha256` 为空的（下载时没算）就补上，算 filled。
 * 超过 `maxBytes` 的文件默认跳过 —— 视频动辄几 GB，抽样校验不该拖几十分钟。
 */
export async function verify(
  db: Database,
  options: { sample?: number; roots?: string[]; maxBytes?: number } = {},
): Promise<VerifyResult> {
  const started = Date.now()
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024
  const allRoots = await listRoots(db)
  const targets = options.roots && options.roots.length > 0
    ? allRoots.filter((r) => options.roots!.includes(r.label))
    : allRoots

  const result: VerifyResult = { checked: 0, matched: 0, mismatched: [], filled: 0, skippedLarge: 0, durationMs: 0 }

  for (const root of targets) {
    const rows = await db.conn.query<{ id: string; rel_path: string; size: number | null; sha256: string | null }>(
      "select id, rel_path, size, sha256 from files where root_id = ? and state = 'present'",
      [root.id],
    )
    const sample = options.sample && options.sample > 0 ? rows.slice(0, options.sample) : rows
    for (const row of sample) {
      const abs = path.join(root.abs_path, row.rel_path)
      if (!existsSync(abs)) continue
      const size = statSync(abs).size
      if (size > maxBytes) {
        result.skippedLarge += 1
        continue
      }
      const actual = await fileSha256(abs)
      result.checked += 1
      if (!row.sha256) {
        await db.conn.exec('update files set sha256 = ? where id = ?', [actual, row.id])
        result.filled += 1
        continue
      }
      if (actual === row.sha256) {
        result.matched += 1
      } else {
        result.mismatched.push({ relPath: row.rel_path, absPath: abs, expected: row.sha256, actual })
      }
    }
  }

  result.durationMs = Date.now() - started
  await event(db, 'verify', null, null, {
    checked: result.checked, matched: result.matched,
    mismatched: result.mismatched.length, filled: result.filled,
  })
  return result
}

export interface DupeGroup {
  key: string
  count: number
  totalBytes: number
  files: { assetId: string; relPath: string; rootLabel: string; size: number | null }[]
}

/**
 * 找重复内容（同一份内容在多个位置）。
 *
 * **只报告，不删** —— 用户规矩：删前先看清单。
 * 优先按整文件 sha256 分组；没有 sha256 的退回快速指纹（可能把同大小的不同文件并进来，
 * 所以结果里带 key 类型，让调用方知道可信度）。
 */
export async function findDupes(db: Database, limit = 50): Promise<DupeGroup[]> {
  const groups = await db.conn.query<{ k: string; n: number | string; s: number | string; kind: string }>(
    `select coalesce(sha256, hash) as k, count(*) as n, coalesce(sum(size), 0) as s,
            case when sha256 is not null then 'sha256' else 'fingerprint' end as kind
     from files
     where state = 'present' and coalesce(sha256, hash) is not null
     group by coalesce(sha256, hash)
     having count(*) > 1
     order by count(*) desc
     limit ?`,
    [limit],
  )

  const out: DupeGroup[] = []
  for (const g of groups) {
    const files = await db.conn.query<{ asset_id: string; rel_path: string; root_label: string; size: number | null }>(
      `select f.asset_id, f.rel_path, r.label as root_label, f.size
       from files f join roots r on r.id = f.root_id
       where f.state = 'present' and coalesce(f.sha256, f.hash) = ?
       order by r.label, f.rel_path`,
      [g.k],
    )
    out.push({
      key: g.k,
      count: Number(g.n),
      totalBytes: Number(g.s),
      files: files.map((f) => ({ assetId: f.asset_id, relPath: f.rel_path, rootLabel: f.root_label, size: f.size })),
    })
  }
  return out
}

export interface AssetRow {
  id: string
  platform: string
  native_id: string
  kind: string
  title: string
  artists: string | null
  album: string | null
  /** 第一条（优先 present）文件的位置，仅用于展示与二次检索。 */
  rel_path?: string | null
}

export async function findAssets(db: Database, keyword: string, limit = 20): Promise<AssetRow[]> {
  const like = `%${keyword}%`
  // 也搜 rel_path：认领来的文件标题常常只是 `01`、`138993133_p0` 这种文件名，
  // 光搜 assets 会一个都搜不到。路径是「它在哪」，标题是「它是什么」，两个都要能搜，
  // 但**不要把路径塞进 title** —— 那就成了同一事实存两份，早晚不一致。
  return db.conn.query<AssetRow>(
    `select a.id, a.platform, a.native_id, a.kind, a.title, a.artists, a.album,
            (select f.rel_path from files f where f.asset_id = a.id
              order by case f.state when 'present' then 0 else 1 end, f.rel_path limit 1) as rel_path
     from assets a
     where a.title like ? or a.artists like ? or a.album like ? or a.native_id like ?
        or exists (
          select 1 from files f join roots r on r.id = f.root_id
           where f.asset_id = a.id
             and (f.rel_path like ? or r.label like ? or r.abs_path like ?)
        )
     order by a.title limit ?`,
    [like, like, like, like, like, like, like, limit],
  )
}

export interface FileRow {
  id: string
  rel_path: string
  abs_path: string
  size: number | null
  state: string
  last_seen: string
  root_label: string
  root_path: string
}

export async function whereAsset(
  db: Database,
  id: string,
  options: { repair?: boolean } = {},
): Promise<FileRow[]> {
  const rows = await db.conn.query<Omit<FileRow, 'abs_path'>>(
    `select f.id, f.rel_path, f.size, f.state, f.last_seen, r.label as root_label, r.abs_path as root_path
     from files f join roots r on r.id = f.root_id
     where f.asset_id = ? order by f.state, f.rel_path`,
    [id],
  )
  const withAbs = rows.map((r) => ({ ...r, abs_path: path.join(r.root_path, r.rel_path) }))
  if (options.repair !== true) return withAbs

  // 读时自愈（抄 Jellyfin 的「局部扫描」思路）：查到的那一刻就核对磁盘，
  // 存在就顺手把 state 修回 present，不存在就立刻标 missing ——
  // 不等到下一次巡检，查询结果永远不说谎。
  for (const row of withAbs) {
    const exists = existsSync(row.abs_path)
    if (exists && row.state !== 'present') {
      await db.conn.exec("update files set state = 'present', last_seen = ? where id = ?",
        [new Date().toISOString(), row.id])
      row.state = 'present'
      await event(db, 'revived', id, row.id, { rel_path: row.rel_path, via: 'read-repair' })
    } else if (!exists && row.state !== 'missing') {
      await db.conn.exec("update files set state = 'missing' where id = ?", [row.id])
      row.state = 'missing'
      await event(db, 'missing', id, row.id, { rel_path: row.rel_path, via: 'read-repair' })
    }
  }
  return withAbs
}

export async function assetEvents(db: Database, id: string, limit = 30): Promise<Record<string, unknown>[]> {
  return db.conn.query(
    `select at, kind, detail from events where asset_id = ? order by at desc limit ?`,
    [id, limit],
  )
}

export interface Stats {
  assets: number
  files: number
  present: number
  missing: number
  totalBytes: number
  byPlatform: Record<string, number>
}

export async function stats(db: Database): Promise<Stats> {
  const n = async (sql: string): Promise<number> =>
    Number((await db.conn.query<{ n: number | string }>(sql))[0]?.n ?? 0)
  const platformRows = await db.conn.query<{ platform: string; n: number | string }>(
    'select platform, count(*) as n from assets group by platform',
  )
  return {
    assets: await n('select count(*) as n from assets'),
    files: await n('select count(*) as n from files'),
    present: await n("select count(*) as n from files where state = 'present'"),
    missing: await n("select count(*) as n from files where state = 'missing'"),
    totalBytes: await n('select coalesce(sum(size), 0) as n from files'),
    byPlatform: Object.fromEntries(platformRows.map((r) => [r.platform, Number(r.n)])),
  }
}

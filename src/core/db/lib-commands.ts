/**
 * `astra lib …` —— 资产库的日常操作。
 *
 * 和 `db …` 的分工：`db` 是数据库本身的运维（迁移/备份/导出），`lib` 是**内容**的操作
 * （根目录、对账、查询）。
 */
import { AstraError, invalidInput } from '../errors.ts'
import type { Command } from '../command.ts'
import { openDatabase, redact } from './index.ts'
import { MIGRATIONS, appliedMigrations } from './migrations.ts'
import {
  addRoot, assetEvents, findAssets, listRoots, removeRoot, scan, stats, whereAsset,
} from './library.ts'

const REQUIRED = MIGRATIONS.map((m) => m.id)

/** 表没建就明确提示跑迁移，不要让 SQL 错误直接冒出来。 */
async function open(): Promise<Awaited<ReturnType<typeof openDatabase>>> {
  const db = await openDatabase()
  const done = await appliedMigrations(db).catch(() => [])
  const missing = REQUIRED.filter((id) => !done.some((d) => d.id === id))
  if (missing.length > 0) {
    await db.conn.close()
    throw new AstraError('CONFIG', `资产库还没初始化（缺 ${missing.length} 个迁移）`, {
      hint: '先跑 astra db migrate',
      exitCode: 3,
    })
  }
  return db
}

export const libCommands: Command[] = [
  {
    name: 'lib root',
    summary: '管理存储根：add / list / rm',
    usage: 'astra lib root <add|list|rm> [标签] [绝对路径] [--note <说明>]',
    options: {
      note: { type: 'string', valueName: '说明', description: '给人看的备注（如「NAS 视角是 /volume1」）' },
    },
    minArgs: 1,
    notes: [
      'root 是「位置」的基准：files 只存相对 root 的路径，换挂载点只改这里一行',
      'rm 在有 file 引用时会拒绝，避免制造孤儿记录',
    ],
    async run({ positionals, values }) {
      const [action, label, absPath] = positionals
      const db = await open()
      try {
        if (action === 'list') {
          return { data: { roots: await listRoots(db), url: redact(db.url) } }
        }
        if (action === 'add') {
          if (!label || !absPath) throw invalidInput('缺少参数', '用法：astra lib root add <标签> <绝对路径>')
          const note = typeof values.note === 'string' ? values.note : undefined
          return { data: await addRoot(db, label, absPath, note) }
        }
        if (action === 'rm') {
          if (!label) throw invalidInput('缺少参数', '用法：astra lib root rm <标签>')
          const result = await removeRoot(db, label)
          if (!result.removed) {
            throw new AstraError('CONFIG', `root「${label}」还有 ${result.files} 条文件记录，不能删`, {
              hint: '先确认这些文件，必要时手动清 files 表；直接删 root 会留下孤儿记录',
              exitCode: 3,
            })
          }
          return { data: { removed: label } }
        }
        throw invalidInput(`不认识的子命令：${action}`, '用法：astra lib root <add|list|rm>')
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'lib scan',
    summary: '对账：扫存储根，修正被移动的文件、标记丢失',
    usage: 'astra lib scan [--root <标签>]',
    options: {
      root: { type: 'string', valueName: '标签', description: '只扫某个 root，默认全部' },
    },
    notes: [
      '按「size + 前 1MB sha1」认领文件：路径变了就改 rel_path 并记 moved 事件',
      '扫不到的标 missing（不删记录）；没见过的文件记 orphan 事件',
    ],
    async run({ values }) {
      const db = await open()
      try {
        const roots = typeof values.root === 'string' ? [values.root] : undefined
        const result = await scan(db, { roots })
        return { data: { ...result, url: redact(db.url) } }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'lib find',
    summary: '按标题/歌手/专辑/平台 id 搜资产',
    usage: 'astra lib find <关键词> [--limit <条数>]',
    options: {
      limit: { type: 'string', valueName: '条数', description: '默认 20' },
    },
    minArgs: 1,
    async run({ positionals, values }) {
      const keyword = positionals.join(' ')
      const limit = typeof values.limit === 'string' ? Number(values.limit) : 20
      const db = await open()
      try {
        const rows = await findAssets(db, keyword, Number.isFinite(limit) ? limit : 20)
        return {
          data: { keyword, total: rows.length, items: rows },
          table: {
            headers: ['id', '标题', '歌手', '平台'],
            rows: rows.map((r) => [r.id, r.title, r.artists ?? '', r.platform]),
          },
        }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'lib where',
    summary: '查某个资产在哪些位置（含已丢失的）',
    usage: 'astra lib where <资产id>',
    minArgs: 1,
    maxArgs: 1,
    async run({ positionals }) {
      const id = positionals[0]!
      const db = await open()
      try {
        const files = await whereAsset(db, id)
        return {
          data: { id, files },
          table: {
            headers: ['状态', 'root', '相对路径', '大小'],
            rows: files.map((f) => [f.state, f.root_label, f.rel_path, f.size ?? 0]),
          },
        }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'lib events',
    summary: '看某个资产的事件历史（下载/移动/丢失）',
    usage: 'astra lib events <资产id> [--limit <条数>]',
    options: {
      limit: { type: 'string', valueName: '条数', description: '默认 30' },
    },
    minArgs: 1,
    maxArgs: 1,
    async run({ positionals, values }) {
      const id = positionals[0]!
      const limit = typeof values.limit === 'string' ? Number(values.limit) : 30
      const db = await open()
      try {
        return { data: { id, events: await assetEvents(db, id, Number.isFinite(limit) ? limit : 30) } }
      } finally {
        await db.conn.close()
      }
    },
  },
  {
    name: 'lib stats',
    summary: '资产库概览：数量、丢失数、总大小、按平台分布',
    usage: 'astra lib stats',
    async run() {
      const db = await open()
      try {
        const data = await stats(db)
        return { data: { ...data, totalGB: Number((data.totalBytes / 1024 ** 3).toFixed(2)), url: redact(db.url) } }
      } finally {
        await db.conn.close()
      }
    },
  },
]

/**
 * 模块边界：core 不依赖领域，领域只依赖 core 和自己声明过的领域。
 *
 * 为什么要测：边界一旦只靠自觉，下一次「顺手 import 一下」就又缠起来了 ——
 * 0.53.0 之前 media ↔ bili 就是这么成环的。靠扫源码 import 判定，不起进程。
 *
 * KNOWN_CORE_TO_DOMAIN 是还没拆完的老账（config 的派生路径、doctor 的分域检查、
 * sessions 的登录汇总）。**只许删、不许加**：拆掉一条就从这里删一条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { DOMAINS } from '../src/domains.ts'

const SRC = path.resolve('src')
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g

const KNOWN_CORE_TO_DOMAIN = new Set([
  'core/config.ts -> bili',
  'core/doctor.ts -> bili',
  'core/doctor.ts -> comic',
  'core/doctor.ts -> music',
  'core/sessions.ts -> bili',
  'core/sessions.ts -> music',
  'core/sessions.ts -> vr',
])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

/** `src/<top>/...` 的 top；根目录下的文件（main.ts / domains.ts）返回 null。 */
function topOf(abs: string): string | null {
  const rel = path.relative(SRC, abs).split(path.sep)
  return rel.length > 1 ? rel[0]! : null
}

function edges(): { from: string; fromTop: string; toTop: string }[] {
  const out: { from: string; fromTop: string; toTop: string }[] = []
  for (const file of walk(SRC)) {
    const fromTop = topOf(file)
    if (fromTop === null) continue
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2]!
      const toTop = topOf(path.resolve(path.dirname(file), spec))
      if (toTop === null || toTop === fromTop) continue
      out.push({ from: path.relative(SRC, file).split(path.sep).join('/'), fromTop, toTop })
    }
  }
  return out
}

test('每个领域目录都在登记表里，登记表里的都有目录', () => {
  const dirs = readdirSync(SRC).filter((n) => n !== 'core' && statSync(path.join(SRC, n)).isDirectory()).sort()
  assert.deepEqual(DOMAINS.map((d) => d.name).sort(), dirs)
})

test('core 不新增对领域的依赖（老账只许减少）', () => {
  const found = new Set(edges().filter((e) => e.fromTop === 'core').map((e) => `${e.from} -> ${e.toTop}`))
  const added = [...found].filter((e) => !KNOWN_CORE_TO_DOMAIN.has(e))
  assert.deepEqual(added, [], 'core 不能 import 领域；需要领域信息时让领域在清单里提供')
  const gone = [...KNOWN_CORE_TO_DOMAIN].filter((e) => !found.has(e))
  assert.deepEqual(gone, [], '这条老账已经拆掉了，把它从 KNOWN_CORE_TO_DOMAIN 删掉')
})

test('领域只依赖 core 和自己 dependsOn 里的领域', () => {
  const allowed = new Map(DOMAINS.map((d) => [d.name, new Set(['core', ...(d.dependsOn ?? [])])]))
  const bad = edges()
    .filter((e) => e.fromTop !== 'core' && !allowed.get(e.fromTop)?.has(e.toTop))
    .map((e) => `${e.from} -> ${e.toTop}`)
  assert.deepEqual([...new Set(bad)], [], '要用别的领域就在 manifest 里声明 dependsOn；更常见的是该下沉到 core')
})

test('dependsOn 不成环', () => {
  const deps = new Map(DOMAINS.map((d) => [d.name, d.dependsOn ?? []]))
  const visit = (name: string, trail: string[]): void => {
    assert.ok(!trail.includes(name), `领域依赖成环：${[...trail, name].join(' -> ')}`)
    for (const next of deps.get(name) ?? []) visit(next, [...trail, name])
  }
  for (const d of DOMAINS) visit(d.name, [])
})

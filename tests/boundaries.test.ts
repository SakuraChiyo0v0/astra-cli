/**
 * 模块边界：core 不依赖领域，领域只依赖 core 和自己声明过的领域。
 *
 * 为什么要测：边界一旦只靠自觉，下一次「顺手 import 一下」就又缠起来了 ——
 * 0.53.0 之前 media ↔ bili 就是这么成环的。靠扫源码 import 判定，不起进程。
 *
 * KNOWN_CORE_TO_DOMAIN 是还没拆完的老账。0.58.0 已经清零：doctor / login 的分域内容
 * 由领域在 manifest 里提供，B 站画质表下沉到 core。**只许删、不许加**。
 *
 * 懒加载另外一条约束：只有 `src/domains.ts` 能 import 领域的 manifest，而且必须是动态 `import()`
 * —— 任何一处静态 import 都会让「只加载一个领域」退化成全量加载。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { DOMAINS } from '../src/domains.ts'
import type { DomainModule } from '../src/core/domain.ts'

const SRC = path.resolve('src')
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g

const KNOWN_CORE_TO_DOMAIN = new Set<string>([])

async function modules(): Promise<DomainModule[]> {
  return Promise.all(DOMAINS.map((d) => d.load()))
}

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

test('领域只依赖 core 和自己 dependsOn 里的领域', async () => {
  const allowed = new Map((await modules()).map((d) => [d.name, new Set(['core', ...(d.dependsOn ?? [])])]))
  const bad = edges()
    .filter((e) => e.fromTop !== 'core' && !allowed.get(e.fromTop)?.has(e.toTop))
    .map((e) => `${e.from} -> ${e.toTop}`)
  assert.deepEqual([...new Set(bad)], [], '要用别的领域就在 manifest 里声明 dependsOn；更常见的是该下沉到 core')
})

test('dependsOn 不成环', async () => {
  const deps = new Map((await modules()).map((d) => [d.name, d.dependsOn ?? []]))
  const visit = (name: string, trail: string[]): void => {
    assert.ok(!trail.includes(name), `领域依赖成环：${[...trail, name].join(' -> ')}`)
    for (const next of deps.get(name) ?? []) visit(next, [...trail, name])
  }
  for (const d of DOMAINS) visit(d.name, [])
})

test('登记名与清单 name 一致', async () => {
  const mods = await modules()
  assert.deepEqual(mods.map((m) => m.name), DOMAINS.map((d) => d.name))
})

test('懒加载：只有 domains.ts 引用 manifest，且只用动态 import()', () => {
  const STATIC = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"](\.{1,2}\/[^'"]*manifest\.ts)['"]/g
  const DYNAMIC = /import\(\s*['"](\.{1,2}\/[^'"]*manifest\.ts)['"]\s*\)/g
  const bad: string[] = []
  for (const file of [...walk(SRC), path.join(SRC, 'main.ts'), path.join(SRC, 'domains.ts')]) {
    const rel = path.relative(SRC, file).split(path.sep).join('/')
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(STATIC)) bad.push(`${rel} 静态 import ${m[1]}`)
    if (rel !== 'domains.ts') for (const m of text.matchAll(DYNAMIC)) bad.push(`${rel} 动态 import ${m[1]}（只有 domains.ts 能加载领域）`)
  }
  assert.deepEqual([...new Set(bad)], [])
})

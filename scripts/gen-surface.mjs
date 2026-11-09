// 重新生成 tests/fixtures/surface.json（对外表面快照）。只在有意改动命令 / 配置键时跑。
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-surface-'))
const { surface } = await import('../tests/golden/surface.ts')
const out = new URL('../tests/fixtures/surface.json', import.meta.url)
writeFileSync(out, JSON.stringify(await surface(), null, 2) + '\n')
console.log('tests/fixtures/surface.json')

/**
 * 对外表面不变：help 全量清单 + 配置键表，与快照逐字节一致。
 *
 * 有意改了命令或配置键（新增 / 改说明）时，重新生成快照并在提交里写明：
 *   node --disable-warning=ExperimentalWarning scripts/gen-surface.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-surface-'))

test('help 清单与配置键表和快照一致', async () => {
  const { surface } = await import('./golden/surface.ts')
  const actual = JSON.stringify(await surface(), null, 2) + '\n'
  const expected = readFileSync(new URL('./fixtures/surface.json', import.meta.url), 'utf8')
  assert.equal(actual, expected, '对外表面变了；有意改动请重新生成 tests/fixtures/surface.json')
})

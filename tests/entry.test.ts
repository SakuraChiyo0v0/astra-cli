/**
 * 入口判定：`node astra.mjs <命令>` 必须真的执行。
 *
 * 这里测的是打包产物，不是源码 —— 因为踩过的两次坑都在"产物怎么被启动"上：
 * 产物改名（astra-bili.mjs）被判成不是入口，退出码 0、零输出。
 *
 * 第三次是**路径里有空格**：实现用 `new URL(import.meta.url).pathname` 拿到的是
 * `%20` 编码路径，和 argv[1] 永远对不上 —— 同样的静默失败换了个成因又回来。
 * 所以这里直接在带空格和中文的目录里跑产物。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const run = promisify(execFile)
const dist = path.resolve('dist/astra.mjs')
let buildRoot = ''

before(async () => {
  buildRoot = mkdtempSync(path.join(tmpdir(), 'astra-entry-'))
  // 这个文件测的是**打包产物**，所以缺 dist 时自己先打一次包。
  // 以前靠"CI 里先 build 再 test"的隐含顺序，一旦步骤调换（CI 现在是 typecheck → test → build）
  // 就变成 copyFileSync ENOENT，而且报错信息完全看不出是顺序问题。
  if (!existsSync(dist)) {
    console.log('[entry.test] 没有 dist/astra.mjs，先打包一次')
    await run(process.execPath, ['scripts/build.mjs'], { timeout: 120_000 })
  }
})

after(() => {
  if (buildRoot) rmSync(buildRoot, { recursive: true, force: true })
})

/** 跑一份产物副本，返回 stdout 里的 data。 */
async function runCopy(dirName: string, fileName: string): Promise<{ version: string }> {
  const dir = path.join(buildRoot, dirName)
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, fileName)
  copyFileSync(dist, target)
  const { stdout } = await run(process.execPath, [target, 'version'], { timeout: 30_000 })
  assert.notEqual(stdout.trim(), '', '零输出 = 入口没被认出来，这是最糟的失败方式')
  const parsed = JSON.parse(stdout) as { ok: boolean; data?: { version?: string } }
  assert.equal(parsed.ok, true, `命令失败：${stdout.slice(0, 200)}`)
  assert.ok(parsed.data?.version, 'JSON 里没有 data.version')
  return { version: parsed.data.version }
}

test('产物必须先打包（npm run build）', () => {
  assert.ok(existsSync(dist), '没有 dist/astra.mjs：先 npm run build')
})

test('普通路径能执行', async () => {
  const result = await runCopy('plain', 'astra.mjs')
  assert.match(result.version, /^\d+\.\d+\.\d+/)
})

test('产物改名（astra-bili.mjs）能执行', async () => {
  const result = await runCopy('renamed', 'astra-bili.mjs')
  assert.match(result.version, /^\d+\.\d+\.\d+/)
})

test('路径里有空格能执行（URL.pathname 的 %20 陷阱）', async () => {
  const result = await runCopy('with space', 'astra.mjs')
  assert.match(result.version, /^\d+\.\d+\.\d+/)
})

test('路径里有中文和空格能执行', async () => {
  const result = await runCopy('带 空格 的目录', 'astra.mjs')
  assert.match(result.version, /^\d+\.\d+\.\d+/)
})

test('被 import 时不执行 main（不产生 stdout）', async () => {
  // 用一个包装脚本 import 产物：argv[1] 是包装脚本，不是产物
  const dir = path.join(buildRoot, 'imported')
  mkdirSync(dir, { recursive: true })
  const entry = path.join(dir, 'astra.mjs')
  copyFileSync(dist, entry)
  const wrapper = path.join(dir, 'wrapper.mjs')
  const { writeFileSync } = await import('node:fs')
  // Windows 下 import 绝对路径必须写成 file:// URL，否则盘符会被当成协议
  writeFileSync(wrapper, `await import(${JSON.stringify(pathToFileURL(entry).href)})\nconsole.log('WRAPPER-DONE')\n`, 'utf8')
  const { stdout } = await run(process.execPath, [wrapper], { timeout: 30_000 })
  assert.equal(stdout.trim(), 'WRAPPER-DONE', '被 import 时不该自己跑起来')
})

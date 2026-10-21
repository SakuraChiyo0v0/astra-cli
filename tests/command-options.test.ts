/**
 * 所有命令的 usage 里提到的 --选项，必须真的在 options 里声明过。
 *
 * 这条是检修时抓到的真问题：`astra audit` 的 usage 写了 `--limit`、`--domain`、`--failed`、
 * `--since`，但一个都没声明，用户照着用法敲就报 "Unknown option"。
 * 这类"文档和实现对不上"的错误在运行时才暴露，非常适合用测试兜住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { musicCommands } from '../src/music/commands.ts'
import { biliCommands } from '../src/bili/commands.ts'
import { mediaCommands } from '../src/media/commands.ts'
import { vrCommands } from '../src/vr/commands.ts'

const all = [...musicCommands, ...biliCommands, ...mediaCommands, ...vrCommands]

test('usage 里提到的每个 --选项都已声明', () => {
  const problems: string[] = []
  for (const command of all) {
    const used = [...command.usage.matchAll(/--([a-z0-9-]+)/g)].map((m) => m[1]!)
    const declared = new Set(Object.keys(command.options ?? {}))
    const missing = [...new Set(used)].filter((name) => !declared.has(name))
    if (missing.length > 0) problems.push(`${command.name}: ${missing.join(', ')}`)
  }
  assert.deepEqual(problems, [], `这些命令的 usage 提到了没声明的选项：\n${problems.join('\n')}`)
})

test('每个命令都有 usage 与 summary', () => {
  for (const command of all) {
    assert.ok(command.usage.length > 0, `${command.name} 缺 usage`)
    assert.ok(command.summary.length > 0, `${command.name} 缺 summary`)
    assert.ok(command.usage.startsWith('astra '), `${command.name} 的 usage 应以 "astra " 开头，实际：${command.usage}`)
  }
})

test('命令名唯一', () => {
  const names = all.map((c) => c.name)
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  assert.deepEqual([...new Set(dupes)], [], `重复的命令名：${dupes.join(', ')}`)
})

/**
 * 给用户 / AI 的提示里写的命令，必须是能原样执行的。
 *
 * 实际踩到：`vr login` 的两步验证提示写 `astra vr login 2fa <code>`，
 * 照着敲会报「参数太多：2fa 887889」—— 正确写法是 `--code`。
 * 这类文案错误运行时不会暴露，只有真的照着做才会失败。
 */
test('notes / 提示里提到的 --选项必须在对应命令上声明过', async () => {
  const byName = new Map(all.map((c) => [c.name, c]))
  const problems: string[] = []
  for (const command of all) {
    for (const note of command.notes ?? []) {
      for (const match of note.matchAll(/astra ([\w ]+?)(?=\s|$|`|，|。)/g)) {
        const invoked = match[1]!.trim()
        // 只在命令名能对上时才检查，参数占位符等跳过
        const target = byName.get(invoked) ?? byName.get(invoked.split(' ').slice(0, 2).join(' '))
        if (!target) continue
        const declared = new Set(Object.keys(target.options ?? {}))
        for (const opt of note.matchAll(/--([a-z0-9-]+)/g)) {
          if (!declared.has(opt[1]!) && !command.usage.includes(`--${opt[1]}`)) {
            problems.push(`${command.name} 的 notes 提到 --${opt[1]}，但 ${target.name} 没声明`)
          }
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})

// 把 main.ts 里的命令也纳入检查（audit 那个 bug 就在 main.ts）
import { readFileSync } from 'node:fs'
test('main.ts 里的命令也能被这项检查覆盖', () => {
  // main.ts 不方便直接 import（会执行 main），所以用文本方式确认 audit 的 options 存在
  const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const since = src.includes("since: { type: 'string'")
  assert.ok(since, 'audit 命令应声明 --since（这个 bug 修过一次，别再漏）')
})

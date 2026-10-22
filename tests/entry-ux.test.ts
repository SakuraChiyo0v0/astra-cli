/**
 * 入口层体验（P3 4a-4e）。
 *
 * 这几条都不动核心逻辑，但都是"人真正卡住的地方" ——
 * 清单原话：`astra bili --help` 报 UNKNOWN_COMMAND 是唯一真正卡住使用者的地方，
 * 每次新会话都要重新想起 `astra help bili` 这个写法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandGroup, groupCommands, restoreCommandFlags } from '../src/main.ts'
import { renderTable } from '../src/core/output.ts'
import { getConfig, setConfig } from '../src/core/config.ts'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

process.env.ASTRA_HOME = mkdtempSync(path.join(tmpdir(), 'astra-ux-home-'))

test('4a：组名能被认出来，并有子命令', () => {
  assert.equal(commandGroup('bili'), true)
  assert.equal(commandGroup('music'), true)
  assert.ok(groupCommands('bili').length > 20, 'bili 该有二十几个子命令')
  // 单个命令名不是"组"（`astra get` 不该被当成 `get` 组的 help）
  assert.equal(commandGroup('get'), false)
  assert.equal(commandGroup('不存在的组'), false)
})

test('4b：bili.template 与 bili.video-template 读写互通', () => {
  const prev = getConfig('bili.video-template')
  try {
    setConfig('bili.video-template', 'a/{title}.{ext}')
    assert.equal(getConfig('bili.template'), 'a/{title}.{ext}', '老名该读到新名写进去的值')
    assert.equal(getConfig('bili.video-template'), 'a/{title}.{ext}')

    // 反过来用老名写，新名也要读到
    setConfig('bili.template', 'b/{title}.{ext}')
    assert.equal(getConfig('bili.video-template'), 'b/{title}.{ext}')
  } finally {
    setConfig('bili.video-template', prev)
  }
})

test('4e：中文与英文混排时列仍对齐', () => {
  // 故意选"字符数相同、显示宽度不同"的两行：
  //   `中文歌名` 4 个字符、显示宽 8
  //   `abcd`     4 个字符、显示宽 4
  // 用 `length` 算宽度时两行会"看起来对齐"，但终端里中文占两格，实际是歪的。
  // 所以判据不能是"字符数相等"，必须是**第二列的显示列号相等**。
  const out = renderTable({
    headers: ['名', '数'],
    rows: [['中文歌名', 1], ['abcd', 22]],
  })
  const lines = out.split(String.fromCharCode(10))

  // 判据：**第二列的值前后各有几个空格**。
  //   `中文歌名  1`  → 「中文歌名」显示宽 8，整列宽 8，再加 2 空格分隔
  //   `abcd      22` → 「abcd」显示宽 4，补 4 空格到列宽 8，再加 2 空格分隔
  // 也就是说，**从行首到第二列内容的显示距离必须相同**。
  //
  // 用"从行首数到第二列内容的显示宽度"来算，不靠字符下标 —— 中文占两格，
  // 字符下标和显示列号不是一回事。
  const displayWidthBeforeSecondValue = (line: string, value: string): number => {
    const at = line.lastIndexOf(value)
    if (at < 0) return -1
    let w = 0
    for (const ch of line.slice(0, at)) {
      const code = ch.codePointAt(0) ?? 0
      const wide = (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xff00 && code <= 0xff60)
      w += wide ? 2 : 1
    }
    return w
  }

  const cjkRow = displayWidthBeforeSecondValue(lines[2]!, '1')
  const asciiRow = displayWidthBeforeSecondValue(lines[3]!, '22')

  assert.equal(
    cjkRow,
    asciiRow,
    `中文行与英文行的第二列起点不一致（显示列 ${cjkRow} vs ${asciiRow}）：\n${out}`,
  )
})

test('4e：null 显示成短横线，不是 "null"', () => {
  const out = renderTable({ headers: ['a'], rows: [[null]] })
  assert.match(out, /^-$/m)
  assert.doesNotMatch(out, /null/)
})

test('--json 只在命令自己声明时才补回去（回归：music lyric 踩过）', () => {
  const declares = { name: 'x', options: { json: { type: 'boolean' } } } as never
  const notDeclares = { name: 'y', options: {} } as never
  assert.deepEqual(restoreCommandFlags(['x', '--json'], declares, ['a']), ['a', '--json'])
  assert.deepEqual(restoreCommandFlags(['y', '--json'], notDeclares, ['a']), ['a'])
  assert.deepEqual(restoreCommandFlags(['x'], declares, ['a']), ['a'])
})

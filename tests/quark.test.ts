/**
 * `astra quark` 的纯逻辑部分。
 *
 * 不碰网络：只测「分享链接怎么解析」「cookie 怎么归一化」「命令清单」这三件容易悄悄错掉的事。
 * 真实下载靠 `astra quark get --dry` 和手工跑一次验，不放进单测（依赖 cookie 和上游）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseShareUrl } from '../src/quark/api.ts'
import { normalizeCookieInput, saveQuarkCookie, loadQuarkCookie, clearQuarkCookie } from '../src/quark/auth.ts'
import { classifyDir } from '../src/quark/fs.ts'
import { quarkCommands } from '../src/quark/commands.ts'

test('分享链接解析：带 # 的网页链接', () => {
  assert.deepEqual(parseShareUrl('https://pan.quark.cn/s/e92c3b3afb31#/list/share'), {
    pwdId: 'e92c3b3afb31',
    passcode: '',
  })
})

test('分享链接解析：带查询参数与提取码', () => {
  assert.deepEqual(parseShareUrl('https://pan.quark.cn/s/abc123?pwd=7k2m'), {
    pwdId: 'abc123',
    passcode: '7k2m',
  })
})

test('分享链接解析：裸 id 直接用', () => {
  assert.deepEqual(parseShareUrl('e92c3b3afb31'), { pwdId: 'e92c3b3afb31', passcode: '' })
})

test('分享链接解析：乱七八糟的输入要报错，而不是猜', () => {
  assert.throws(() => parseShareUrl('   '), /看不懂/)
})

test('cookie 归一化：去掉 Cookie: 前缀并压缩空白', () => {
  assert.equal(normalizeCookieInput('Cookie:  a=1;   b=2 ;'), 'a=1; b=2 ;')
  assert.equal(normalizeCookieInput('a=1; b=2'), 'a=1; b=2')
})

test('cookie 存取：写进去能读出来，文件必须是 600', () => {
  const home = mkdtempSync(join(tmpdir(), 'astra-quark-'))
  const prev = process.env.ASTRA_HOME
  process.env.ASTRA_HOME = home
  try {
    saveQuarkCookie('b-user-id=x; __puus=y')
    const loaded = loadQuarkCookie()
    assert.equal(loaded, 'b-user-id=x; __puus=y')
    const mode = statSync(join(home, 'quark.json')).mode & 0o777
    assert.equal(mode, 0o600)
    assert.equal(clearQuarkCookie(), true)
    assert.equal(loadQuarkCookie(), null)
  } finally {
    if (prev === undefined) delete process.env.ASTRA_HOME
    else process.env.ASTRA_HOME = prev
  }
})

test('命令清单：ls / get / cookie / doctor 都在', () => {
  assert.deepEqual(
    quarkCommands.map((c) => c.name),
    [
      'quark ls', 'quark get', 'quark tree', 'quark mkdir', 'quark mv', 'quark rm',
      'quark du', 'quark find', 'quark dup', 'quark clean', 'quark tidy',
      'quark plan', 'quark apply', 'quark cookie', 'quark doctor',
    ],
  )
})


test('目录归类：关键词命中 + 分类目录自身不再归类', () => {
  assert.equal(classifyDir('Qwen3-TTS'), 'AI模型')
  assert.equal(classifyDir('新海诚全系列'), '影视')
  assert.equal(classifyDir('Paradox Interactive'), '游戏')
  assert.equal(classifyDir('Adobe全家桶'), '软件')
  assert.equal(classifyDir('高品质材质贴图库'), '素材')
  assert.equal(classifyDir('绝版古籍电子书合集'), '文档')
  // 分类目录自身必须返回 null，否则会「移动到自身」
  assert.equal(classifyDir('软件'), null)
  assert.equal(classifyDir('AI模型'), null)
  assert.equal(classifyDir('rt'), null)
})

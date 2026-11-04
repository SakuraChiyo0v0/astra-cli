/**
 * 云盘抽象层：路径工具、凭证脱敏、命令注册。
 *
 * 不打真实网盘（夸克要 cookie、百度要 access_token，跑测试的机器上两者都没有），
 * 只测纯函数和注册关系——网络行为靠 `astra cloud ls` 手工验证。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseName, joinPath, normalizePath, parentPath } from '../src/cloud/types.ts'
import { maskSecret } from '../src/cloud/auth-store.ts'
import { cloudCommands } from '../src/cloud/commands.ts'

test('normalizePath 合并斜杠、去尾斜杠', () => {
  assert.equal(normalizePath('/'), '/')
  assert.equal(normalizePath(''), '/')
  assert.equal(normalizePath('a/b'), '/a/b')
  assert.equal(normalizePath('/a//b/'), '/a/b')
  assert.equal(normalizePath('/a\\b'), '/a/b')
  assert.equal(normalizePath('/a/./b'), '/a/b')
})

test('normalizePath 拒绝越界 ..', () => {
  assert.throws(() => normalizePath('/a/../b'), /不允许/)
  assert.throws(() => normalizePath('..'), /不允许/)
})

test('parentPath 与 joinPath 互逆', () => {
  assert.equal(parentPath('/a/b/c'), '/a/b')
  assert.equal(parentPath('/a'), '/')
  assert.equal(parentPath('/'), '/')
  assert.equal(joinPath('/', 'x'), '/x')
  assert.equal(joinPath('/a', 'x'), '/a/x')
  assert.equal(joinPath('/a/', '/x/'), '/a/x')
})

test('baseName 取末段', () => {
  assert.equal(baseName('/a/b/c.zip'), 'c.zip')
  assert.equal(baseName('/a'), 'a')
  assert.equal(baseName('/'), '/')
})

test('maskSecret 不泄漏完整凭证', () => {
  assert.equal(maskSecret(undefined), '（未配置）')
  assert.equal(maskSecret('abcd1234'), 'ab***')
  const long = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const masked = maskSecret(long)
  assert.ok(masked.startsWith('abcd'))
  assert.ok(masked.includes('6789'), '尾部 4 位要保留')
  assert.ok(!masked.includes('abcdefghij'))
})

test('cloud 命令都注册了，且 usage 里带 drive 的说明与实现一致', () => {
  const names = cloudCommands.map((c) => c.name).sort()
  assert.deepEqual(names, [
    'cloud auth-url',
    'cloud get',
    'cloud login',
    'cloud logout',
    'cloud ls',
    'cloud mkdir',
    'cloud mv',
    'cloud rm',
    'cloud stat',
    'cloud status',
  ])
  for (const cmd of cloudCommands) {
    assert.ok(cmd.usage.startsWith('astra '), `${cmd.name} 的 usage 要以 astra 开头`)
    assert.ok(cmd.summary.length > 4, `${cmd.name} 缺 summary`)
  }
  // 带 --drive 的命令必须真读它，否则用户以为能切盘其实没切
  for (const cmd of cloudCommands.filter((c) => c.options?.drive)) {
    assert.ok(cmd.run, `${cmd.name} 没有 run`)
  }
})

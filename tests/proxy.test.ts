/**
 * 按域走代理的判定。
 *
 * 背景：NAS 上 Steam 全域名不通（实测超时），但有 mihomo 容器提供代理。
 * 不能全局走代理 —— B 站对代理 IP 更敏感，而且多绕一跳更慢。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldProxy, type ProxyConfig } from '../src/core/proxy.ts'

const config: ProxyConfig = {
  url: 'http://mihomo:7890',
  include: ['steampowered.com', 'steamcommunity.com'],
  exclude: ['bilibili.com', 'music.163.com'],
}

test('没配置代理时一律直连（包括 null）', () => {
  assert.equal(shouldProxy('api.steampowered.com', null), false)
  assert.equal(shouldProxy('api.steampowered.com', { url: '', include: [], exclude: [] }), false)
})

test('命中 include 的走代理', () => {
  assert.equal(shouldProxy('api.steampowered.com', config), true)
  assert.equal(shouldProxy('store.steampowered.com', config), true)
  // 精确等于也算（后缀匹配要能匹配自身）
  assert.equal(shouldProxy('steampowered.com', config), true)
  assert.equal(shouldProxy('steamcommunity.com', config), true)
})

test('不在 include 里的直连', () => {
  assert.equal(shouldProxy('www.bilibili.com', config), false)
  assert.equal(shouldProxy('example.com', config), false)
})

test('exclude 优先于 include', () => {
  const overlapping: ProxyConfig = { url: 'http://p:7890', include: ['com'], exclude: ['bilibili.com'] }
  assert.equal(shouldProxy('www.bilibili.com', overlapping), false, 'exclude 要先判')
  assert.equal(shouldProxy('store.steampowered.com', overlapping), true)
})

test('后缀匹配不能误伤：baidu.com 不该匹配 ai.com', () => {
  const c: ProxyConfig = { url: 'http://p:7890', include: ['ai.com'], exclude: [] }
  assert.equal(shouldProxy('api.ai.com', c), true)
  assert.equal(shouldProxy('baidu.com', c), false, 'baidu.com 不该被 ai.com 匹配')
})

test('include 为空 = 全部走代理（除了 exclude）', () => {
  const all: ProxyConfig = { url: 'http://p:7890', include: [], exclude: ['bilibili.com'] }
  assert.equal(shouldProxy('anything.example', all), true)
  assert.equal(shouldProxy('www.bilibili.com', all), false)
})

test('大小写不敏感', () => {
  assert.equal(shouldProxy('API.STEAMPOWERED.COM', config), true)
})

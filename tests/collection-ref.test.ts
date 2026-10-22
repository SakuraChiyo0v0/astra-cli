/**
 * 合集 / 系列 / 收藏夹 ref 的三种写法。
 *
 * 回归目标：v0.12.0 之前 `season:<sid>` 这条简写会报 `-503`，v0.12.2 修好了。
 * 这类"以前能用的写法突然不能用了"最容易悄悄退化，所以把全部入口钉住。
 *
 * 实测（2026-10-21）：`seasons_archives_list` 只给 season_id 也能返回，
 * mid 是可选的 —— 之前以为必须两个参数，是因为当时用的 sid 本身不存在，
 * 404 被误读成"缺 mid"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCollectionRef, assertCollectionRef } from '../src/bili/collection.ts'

test('合集：三种写法都认', () => {
  // 1. 纯 sid 简写（v0.12.0 前会 -503 的那种）
  assert.deepEqual(parseCollectionRef('season:1049571'), { kind: 'season', mid: null, seasonId: '1049571' })
  // 2. 带 mid 的复合写法（subscribe list 回显的就是这个形状，必须能直接复用）
  assert.deepEqual(parseCollectionRef('season:1060544882/1049571'), { kind: 'season', mid: '1060544882', seasonId: '1049571' })
  // 3. collectiondetail 链接
  assert.deepEqual(
    parseCollectionRef('https://space.bilibili.com/1060544882/channel/collectiondetail?sid=1049571'),
    { kind: 'season', mid: '1060544882', seasonId: '1049571' },
  )
})

test('合集的其它等价写法', () => {
  assert.deepEqual(parseCollectionRef('collection:1049571'), { kind: 'season', mid: null, seasonId: '1049571' })
  assert.deepEqual(
    parseCollectionRef('https://space.bilibili.com/1060544882/lists/1049571?type=season'),
    { kind: 'season', mid: '1060544882', seasonId: '1049571' },
  )
})

test('系列：写法和合集区分得开', () => {
  // seriesdetail 与 collectiondetail 是两套接口，不能互相认错
  assert.deepEqual(parseCollectionRef('series:1049571'), { kind: 'series', mid: null, seriesId: '1049571' })
  assert.deepEqual(parseCollectionRef('series:1060544882/1049571'), { kind: 'series', mid: '1060544882', seriesId: '1049571' })
  assert.deepEqual(
    parseCollectionRef('https://space.bilibili.com/1060544882/channel/seriesdetail?sid=1049571'),
    { kind: 'series', mid: '1060544882', seriesId: '1049571' },
  )
})

test('收藏夹：ref 与链接', () => {
  assert.deepEqual(parseCollectionRef('fav:123456'), { kind: 'fav', id: '123456' })
  assert.deepEqual(
    parseCollectionRef('https://space.bilibili.com/1060544882/favlist?fid=123456&ftype=create'),
    { kind: 'fav', id: '123456' },
  )
})

test('认不出的输入返回 kind: null，而不是抛错或猜一个', () => {
  for (const bad of ['', '随便什么', 'BV1xx411c7mD', 'season:', 'season:abc']) {
    assert.equal(parseCollectionRef(bad).kind, null, bad)
  }
})

test('assertCollectionRef 对坏输入给出可执行的提示', () => {
  assert.doesNotThrow(() => assertCollectionRef('season:1049571'))
  assert.throws(() => assertCollectionRef('这不是ref'), /认不出|收藏夹/)
})

test('三个入口对 ref 的接受/拒绝集合必须一致', async () => {
  // 上面那些都是纯函数测试 —— 它们证明"解析器认得这些写法"，
  // 但证明不了"三个命令真的用了它"。要是哪天某个入口自己写一份正则，
  // 上面的测试照样绿，而那个命令已经认不出 season:<sid> 了。
  //
  // 判据不看错误文案（文案可能被改、也可能恰好撞词），而是看
  // **同一个输入在三个入口上是被接受还是被拒绝，必须完全一致**。
  // 输入先落到"发起网络请求"那一步 —— 用 AbortSignal 把它掐掉，
  // 于是"解析通过"表现为一个 abort/网络类错误，"解析失败"表现为输入校验错误。
  const { biliCommands } = await import('../src/bili/commands.ts')
  const commands = ['bili collection', 'bili bulk', 'bili subscribe add'] as const
  const inputs = [
    'season:1049571',
    'season:1060544882/1049571',
    'https://space.bilibili.com/1060544882/channel/collectiondetail?sid=1049571',
    'fav:123456',
    'series:1049571',
    '这不是任何 ref',
    'BV1xx411c7mD',
  ]

  /** 这个输入在这个命令上"解析过了"还是"被拦住了"。 */
  const outcome = async (name: string, input: string): Promise<'accepted' | 'rejected'> => {
    const cmd = biliCommands.find((c) => c.name === name)
    assert.ok(cmd, `命令 ${name} 应当存在`)
    try {
      await cmd.run({ positionals: [input], values: {}, signal: AbortSignal.abort() } as never)
      return 'accepted'
    } catch (err) {
      const message = (err as Error).message ?? ''
      // 输入校验类的错误 = 被拦住了；abort / 网络 / 其它 = 已经走到请求那步，即解析通过
      return /认不出|只能|需要|不合法|必须要/.test(message) ? 'rejected' : 'accepted'
    }
  }

  // **合集类输入**三个入口必须判断一致。普通视频（BV 号）是例外：
  // `bili bulk` 支持"普通视频 + --all-pages/--pages"，另两个只认合集/系列/收藏夹，
  // 这是有意设计（bulk 的 usage 里就写着"视频链接"），不是不一致。
  const collectionInputs = inputs.filter((i) => !/^BV|bilibili\.com\/video/i.test(i))
  for (const input of collectionInputs) {
    const results = await Promise.all(commands.map(async (name) => [name, await outcome(name, input)] as const))
    const verdicts = new Set(results.map(([, v]) => v))
    assert.equal(
      verdicts.size,
      1,
      `输入「${input}」在三个入口上判断不一致：${results.map(([n, v]) => `${n}=${v}`).join('，')}`,
    )
  }

  // 反过来把"bulk 独有"这条钉住：它认 BV，另两个不认。
  // 哪天 bulk 不再支持普通视频，这条会提醒去改 usage 和验收说明。
  assert.equal(await outcome('bili bulk', 'BV1xx411c7mD'), 'accepted', 'bulk 应当支持普通视频（配 --all-pages/--pages）')
  assert.equal(await outcome('bili collection', 'BV1xx411c7mD'), 'rejected', 'collection 只列合集，不认单个视频')
})

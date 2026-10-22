# 2026-10-23 `bili audio` 批量转库 / audio-dir / 专辑名

清单 v0.12.18 复测后的四条（2d / 2f / 2g / 2h），加上三条实测反馈。

## 2g：`bili audio`

用户给 o叔 建音乐子库时，319 首是在**外部循环**调 `astra bili get` 干的，
中间还得：

1. 临时改 `ASTRA_MUSIC_DIR` 把文件导到别处（否则落进 `音乐/流媒体`）
2. 事后数「应有 319 vs 实际 280」，发现同名冲突丢了 39 首
3. 写补下脚本重下缺失的 39 首
4. 再写脚本重刷 `TALB` / `TIT2`

换一个 UP 就重来一遍。

`bili audio` 把这套串起来。每一步用的都是**已有能力**：
`spaceVideos` 拿投稿、`downloadPage --audio-only` 下载、
`resolveTargetPath` 消歧（2e 做的）、`writeTags` 写标签。

### 设计取舍

**增量判断不自己扫目录**。交给 `downloadPage` 里的 `resolveTargetPath`：
它先按模板算目标路径，再用「文件名 bvid → 标签 SOURCE_ID」认归属。
这套逻辑在 2e 已经验过，这里再实现一遍只会分叉。

但有个细节：`downloadPage` 遇到同 bvid 会**照常重下一遍覆盖自己**
（这是 `--force` 的语义）。从外面看不出"下了"和"本来就在"的区别，
所以 `bili audio` 在下载前**先探一次**：

```ts
const preview = await previewTargetPath(info, page, album)
if (preview.exists && preview.ownedByBvid) return { kind: 'skip' }
```

实测：连跑两次，第二次 `downloaded: 0, skipped: 2`，文件数不变。

**`--exclude` 写错抛错，不静默**。"排除 322 / 待下 0" 看着像正常，
实际是正则坏了。这种静默比报错糟得多。

## 2d：`bili.audio-dir`

B 站那批大量是 UP 主自己调的 AI 翻唱 / 翻弹，性质与流媒体音源不同，
用户想分开存。

留空退回 `ASTRA_MUSIC_DIR`（老行为不变）。

## 三条实测反馈

### `--to bili` 用错模板

```
实测 → 视频/oskarpianist/炫技高燃完整版《暗香》…/01.mp3
```

套的是视频模板 `{title}/{page:02} {part}`。**模板与根目录是两件事**，
我把它们混在一个 `if` 里了：

```ts
// 错：toMusic 决定一切
const toMusic = audio && (options.audioTo ?? 'music') === 'music'
if (toMusic) { ...用 audio-template... }
return { ...用 bili.template... }   // ← 音频走到这里
```

改成：只要是音频就走 audio-template，只有**根目录**看 `--to`。

### `--sidecar` 对音频无效

之前我写了「只对视频生成 —— 音频进音乐库后靠内嵌标签」。那是**替用户做了决定**：
`--sidecar cover` 明确要一张同名 jpg 时，音频也该有（有的播放器不读内嵌封面）。

显式要了就给，不猜。

### `bili.concurrency` 帮不上批量

用户实测：

```
concurrency=1 → 16s
concurrency=3 → 21s   （反而更慢）
```

因为瓶颈是 **319 次进程启动**，不是单次请求。`bili.concurrency` 管的是
单命令内部的分 P 并发，跨视频的批量得靠 `bili audio` 这种批量入口 ——
2g 顺带解决了这个。

## 2f：专辑名

`--album` / 订阅的 `--audio-album`。默认仍是 UP 名。

用户会把同一个 UP 的作品按大类分专辑（`O叔流行` / `O叔古典` / `O叔现场`），
靠 TALB 在播放器里分组 —— 否则 300 多首全堆在一个专辑下没法看。

## 验证

真跑，不只是单测：

```
第一次: downloaded: 2, skipped: 0    → 东洋雪莲/5_20AM.mp3、莫愁乡.mp3（平铺）
第二次: downloaded: 0, skipped: 2    → 文件数仍是 2

--exclude '《': total 20, excluded 18, planned 2
--exclude '[unclosed': INTERNAL "--exclude 不是合法正则"

--album 'O叔测试'  → ffprobe: album = O叔测试
bili.audio-dir 配置后 → 落到 w/bili-audio/，music/ 下零新增
订阅 --audio-album → list 回显 audioOnly: true, audioAlbum: O叔测试
```

`npm run check` 343 项全过。两条核心防线验过能变红：
`--to bili` 退回视频模板 → 1 条红；非法正则改静默 → 1 条红。

## 没做的

- **风控降速是简化版**：撞到 412 就把后续批次降到 1，没有指数退避。
  够用（实测一次 batchSize 降下来后面就顺了），但不算精细
- **没有断点续跑文件**：靠"跳过已存在"天然续跑。如果一首下载到一半被杀，
  目标文件是 `rename` 之后才出现的，所以不会留下假的"已完成"

---

## v0.12.19 实测反馈：伴生文件命名

Hermes 复测 v0.12.19，抓到一条我的错：

```
实测：暗香.mp3.jpg        暗香.mp3.Metadata.nfo
应为：暗香.jpg            暗香.Metadata.nfo
```

Emby / Jellyfin / Kodi 的刮削规则是 `<stem>.<ext>` —— 同目录下同名、
不同扩展名的文件才被认成同一条。`暗香.mp3.jpg` 不会被当成 `暗香.mp3` 的封面，
它是个孤儿文件，刮削器根本不去看它。

### 为什么错了

我实现时写的是：

```ts
return `${videoPath}${suffix}`   // 追加
```

文件头注释还理直气壮地写着：

> 也就是说扩展名**追加**在视频文件名后面，不是替换 —— `a.mp4` → `a.mp4.Metadata.nfo`。
> 一开始容易写成 `a.Metadata.nfo`（替换扩展名），那样播放器认不出是同一条。

**这段注释是错的，而且写得很确定。** 我当时没有验证过刮削器的实际规则，
是从"文件名要一致"这个模糊印象推出来的。错误的注释比没有注释更糟 ——
它让人不再去查。

### 测试为什么没抓到

原来的测试断言写的就是追加：

```ts
assert.equal(sidecarPath('/v/01 绿色.mp4', 'nfo'), '/v/01 绿色.mp4.Metadata.nfo')
```

**测试照着错误实现写，当然全绿。** 这是"测试确认了假设"而不是"测试验证了行为"。

现在断言改成替换形式，并且指向真实的规则（`<stem>.<ext>`），
不再只是复述实现。

## 另一个发现：测试污染了真实配置

修这条时发现 `npm run check` 有 3 条失败，查下去是**测试写进了用户的全局配置**：

```json
// ~/.astra/config.json
{ "bili.audio-template": "", "bili.audio-dir": "/m/bili-audio" }
```

`bili-sidecar.test.ts` 和 `bili-audio-sync.test.ts` 里有用例会调 `setConfig`
验证配置优先级，但没设 `ASTRA_HOME` —— 于是写到了真实的家目录。

后果是所有"落盘根目录"类断言全挂（音频莫名其妙往 `/m/bili-audio` 跑）。

修法：两个测试文件顶部设一个临时的 `ASTRA_HOME`。

**教训**：测配置相关的行为，隔离 `ASTRA_HOME` 是必须的，
不是"记得就加"的选项。这类污染还会留在机器上，影响之后所有会话。

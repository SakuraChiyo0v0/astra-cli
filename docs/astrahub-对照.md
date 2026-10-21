# astra ↔ astrahub 能力对照

> 更新：2026-10-21（astra v0.7.0，astrahub 283 个操作）
>
> astrahub 在 `../../astrahub/`。它是**信息查询为主**的能力平台（下载只有 2 个操作），
> astra 是**下载到本地为主**。所以对照的重点不是"照抄功能"，而是"哪些查询能力能喂给下载流程"。

## 一、音乐（网易云）

| astrahub | astra 现状 | 备注 |
|-|-|-|
| `netease.search.songs/albums/artists/playlists` | ✅ `music search` | 我们合并成一条命令 + `--type` |
| `netease.song.details` | ✅ `music info` | |
| `netease.playlist.tracks/details` | ✅ `music info` / `get` | |
| `netease.user.playlists` | ✅ `music playlists` | |
| `netease.recommend.daily` | ✅ `music daily` | 我们额外带"为什么推给你" |
| `netease.song.liked` / `liked-check` | ✅ `music liked` | |
| `netease.lyric` | ✅ 内嵌 + `.lrc` + `.word.lrc` | 我们**多了逐字**（酷狗 KRC），astrahub 没有 |
| `netease.song.url` | ✅ 取链（三路线） | 我们是**实测音质**后择优，它不是 |
| `netease.song.download(-batch)` | ✅ `music get` / 后台任务 | |
| `netease.account.get` / `vip.info` | ✅ `music account` | |
| `netease.radio.get`（私人 FM） | ⬜ | 价值一般，音频流不是下载目标 |
| `netease.scrobble`（刷歌打卡） | ❌ 明确不做 | 本质刷数据 |
| `netease.yunbei.sign` / `daily.tasks` / `music.sign` | ❌ 明确不做 | 同上 |
| `netease.partner.status`（音乐合伙人） | ❌ 不做 | 冷门 |

**结论：音乐域覆盖完整，且逐字歌词与音质择优比 astrahub 强。**

## 二、B 站

astrahub 有 31 个操作，astra 有 13 条命令（含 1 个内部 worker，对外 12 条）。

### 已有

| astrahub | astra 现状 |
|-|-|
| `bilibili.video.details` | ✅ `bili info` |
| `bilibili.video.download(-batch)` | ✅ `bili get` / `bili bulk` |
| `bilibili.video.streams`（只看取流地址） | ✅ `bili info --probe` |
| `bilibili.video.normalize`（链接规范化） | ✅ `bili/target.ts`（内部） |
| `bilibili.fav.folder` / `resources` | ✅ `bili bulk fav:<id>` |
| `bilibili.collection.videos` | ✅ `bili bulk`（合集） |
| `bilibili.auth.session.check` | ✅ `bili account` |

### 值得补（按价值排序）

| astrahub | 价值 | 说明 |
|-|-|-|
| `bilibili.video.danmaku` | **高** | 弹幕。下视频时顺手存 XML，可转 ASS 跟着视频走 |
| `bilibili.video.popular` / `weekly-list` | 高 | 综合热门 / 每周必看。能让 AI 回答"这周有什么值得看的"，直接喂下载 |
| `bilibili.watch-later.list/add/remove/clear` | 高 | 稍后再看。你在 B 站点一下，AI 就能批量下 |
| `bilibili.history.list/remove/clear/shadow` | 中 | 观看历史 |
| `bilibili.user.videos` / `user.collections` | 中 | **注意**：`x/space/wbi/arc/search` 实测返回风控 HTML（带不带 wbi 签名都一样），要另找路子 |
| `bilibili.search.videos` | 中 | 搜索视频；B 站搜索接口签名要求更高 |
| `bilibili.video.comments` | 低 | 评论区。跟下载关系不大 |
| `bilibili.user.card` / `relations` | 低 | 用户名片 / 关注关系 |
| `bilibili.bangumi.index` / `season` | 低 | 番剧索引。astrahub 自己也没做番剧下载（那是 `anime.*` 域） |
| `bilibili.fav.mine` / `favoured` | 低 | 我的收藏夹列表 |

### 不打算做

- `bilibili.history.shadow.set` —— 影子历史是 astrahub 内部机制，astra 不需要
- `bilibili.watch-later.*` 的写操作要谨慎：这类会改你 B 站账号的数据，AI 误操作代价高

## 三、其它域

| 域 | astrahub 操作数 | astra 要不要做 | 理由 |
|-|-|-|-|
| **media**（ffmpeg 处理） | 24 | **值得挑着做** | 剪裁、转码、抽音轨、缩略图、GIF。下完视频想剪一段时用得上 |
| **VRChat** | 67 | 不做 | 除非你真的用 VRChat |
| **Steam** | 47 | 不做 | 你已用 ASF 跑挂卡，重复 |
| **anime**（番剧规则引擎） | 15 | 不做 | 规则引擎维护成本高，收益不确定 |
| **chat**（消息策略 / 飞书卡片） | 9 | 不做 | Hermes 自己管消息，不需要再来一层 |
| **xiaoheihe** | 6 | 不做 | 冷门 |
| **mail**（自实现 SMTP） | 5 | 不做 | 通知已走飞书 webhook |
| **image**（传声筒渲染） | 5 | 不做 | 特定用途 |
| **remotedoc**（配置加密备份） | 5 | 不做 | astra 的状态目录拷走就是备份 |
| **downloads**（下载历史登记） | 5 | 部分 | 我们的曲库表已经承担这个职责 |
| **credentials**（保险箱） | 5 | 不做 | 会话文件权限 600 够用 |
| **booth** | 4 | 不做 | 特定用途 |

## 四、如果继续做的推荐顺序

1. **B 站弹幕**（半天）—— 和现有下载流程结合最紧，下视频时顺手存
2. **B 站热门 / 每周必看 / 稍后再看**（一天）—— 打通"发现 → 下载"闭环，AI 才能主动推荐
3. **媒体处理挑 4 个**（一天）—— `extract-audio`、`cut`、`transcode`、`thumbnail`
4. B 站用户视频 / 搜索（需先解决风控签名，可能做不成）

## 五、借鉴时要注意的

- **astrahub 用 TypeBox + JSON Schema 描述每个操作**，参数校验严格。astra 用 `util.parseArgs` + 手写校验，更轻但契约没那么形式化
- **astrahub 的错误码分得很细**（`NETEASE_INVALID_INPUT` / `NETEASE_UPSTREAM_ERROR`…）。astra 只有十几个通用码，够用但检索性差
- **astrahub 的运行时不支持懒安装**，astra 依赖全内置（`node:sqlite` / `node:vm` / `fetch`），单文件即可部署 —— 这是 astra 更适合塞进 Hermes 容器的原因
- astrahub 的 `docs/` 里每个操作都有验收记录，**踩坑细节比代码本身更有价值**，参考时优先读那些

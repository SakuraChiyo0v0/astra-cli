# astra

给 AI 调用的个人能力 CLI。一条命令办完一件事，stdout 永远只有一个 JSON。

目标场景：NAS 上的 Hermes 收到飞书消息"下一首晴天"，调 `astra music get 晴天 周杰伦`，把结果回给你；
你说"这个视频离线存一下"，它调 `astra bili get <链接>`。

**不依赖任何其它服务**：没有数据库服务、没有常驻进程，状态全在一个目录里。

## 现在有什么

| 能力域 | 能做什么 | 命令数 |
|-|-|-|
| **音乐**（网易云） | 找歌 → 判断版本 → 取最高音质 → 写标签/封面/歌词 → 存进曲库 → 存量重排 | 35 |
| **B 站** | 视频 / 分 P / 收藏夹 / 合集 / UP 主投稿下载，音视频合并，字幕，弹幕，热门 | 26 |
| **媒体处理** | 抽音轨、裁剪、转码、截图、拼接、水印（对本地文件） | 7 |
| **Steam** | 愿望单（带价格/折扣）、公开库存、玩家资料 | 8 |
| **VRChat** | 好友、通知、世界、实例、群组、头像、收藏、经济 | 32 |
| 基础设施 | 统一输出、配置、飞书通知、自检、后台任务、备份、审计 | 10 |

规模：118 条命令（不含内部 worker），约 15900 行 TS，40 个测试文件 268 项测试。

**代理**：`proxy.url` / `include` / `exclude` 按域名决定哪些请求走代理，
Steam 这类被墙的域名走代理，B 站和网易云保持直连（它们对代理 IP 更敏感）。
注意 `proxy.include` **留空表示全部走代理**，与"谁都不走"相反。

### 音乐

```sh
astra music get 晴天 周杰伦          # 拿得准就下完，拿不准返回候选
astra music get wy:186016           # 用候选里的 ref
astra music get <专辑/歌单/歌手链接>  # 自动开后台任务
astra music daily --download        # 今日推荐全下
astra music subscribe add playlist:3778678 --every 6h   # 订阅追更
astra music have --low              # 哪些音质还能更好
astra music retag                   # 按当前规则重排已下好的歌（先预览，确认后才动）
```

取音质是**三条路线择优**：官方账号通道（VIP 能拿 24bit/Hi-Res）→ 洛雪音源（网易云）→ 酷我同曲。
音质只信实测字节，不信档位名；写法按采样率 > 位深 > 码率比较。

落盘规则改过好几轮（合作曲归主艺术家、群星合辑归到 `合辑/`），这些改动只对新下载生效。
`music retag` 把它们补到存量文件上：**默认只预览**，返回"哪些要搬、搬去哪"和一次性令牌，
带 `--confirm` 才真动手。有冲突（目标被占、两首歌算出同一路径）就整批拒绝，
写标签前后比对音频哈希，同名 `.lrc` 跟着走。

### B 站

```sh
astra bili get BV17x411w7KC --page 3     # 单个分 P
astra bili get <链接> --audio-only        # 只要音频
astra bili bulk fav:123456 --limit 20    # 收藏夹批量
astra bili info <链接> --probe            # 看实际能拿到什么画质
astra bili subtitle <链接>                # 字幕转 srt
astra bili danmaku <链接>                 # 弹幕转 ASS
astra bili popular --limit 10             # 综合热门
astra bili weekly                          # 每周必看
```

### 媒体处理

对**已下载到本地**的文件加工，不联网：

```sh
astra media info <文件>                    # 时长 / 编码 / 分辨率 / 码率 / 帧率
astra media audio <视频> --format mp3      # 抽音轨
astra media cut <文件> --start 10 --duration 5   # 裁剪
astra media transcode <文件> --width 720   # 转码 / 改分辨率
astra media thumbnail <视频> --at 30       # 截一帧当封面
```

输出路径**绝不会等于输入**——这是硬约束，`--overwrite` 也绕不过。默认不覆盖已存在的文件。

DASH 的音视频是**分开的两个流**，下完用 ffmpeg 合并 —— 所以 B 站能力需要 ffmpeg（音乐那边不需要）。

### Steam

只做对"AI 代替我"有实际意义的两类：**愿望单**和**库存**。商店查询、评测、成就没做，那些自己看更合适。

```sh
astra steam auth set-user 7656xxxxxxxxxxxxx   # 设置默认 SteamID64
astra steam wishlist --sort discount          # 愿望单：名字、价格、折扣、加入日期
astra steam wishlist --no-details             # 只要 appid，快（不查商店）
astra steam inventory --app 730               # CS2 库存
astra steam me                                # 玩家资料（需要 Web API key）
astra steam doctor                            # 网络 / 代理 / 凭据自检
```

愿望单的 appid 列表**不需要 key**，只要账号的"游戏详情"是公开的。
补名字和价格要查 `store.steampowered.com`，那个域名必须走代理。
`steamcommunity.com`（库存）也走代理 —— 库存接口对共享代理 IP 限流很严，会 429。

## 输出约定

stdout 只有一个 JSON，进度和诊断走 stderr：

```jsonc
{ "ok": true, "data": { "status": "downloaded", "quality": "24bit", "downgraded": false }, "warnings": [] }
{ "ok": false, "error": { "code": "NO_SOURCE", "message": "...", "hint": "下一步该做什么", "retryable": false } }
```

`error.hint` 直接告诉 AI 下一步做什么。`retryable: true` 表示稍后重试可能成功。
退出码：0 成功 / 2 参数错 / 3 需要配置或登录 / 4 没找到 / 5 上游或网络 / 130 取消。

`data.status` 的常见值：`downloaded` / `already_have` / `ambiguous`（附 candidates）/ `job_started`。

## 数据目录

| | 默认 | 覆盖 |
|-|-|-|
| 状态（配置、曲库 `astra.db`、会话、音源、任务日志） | `~/.astra` | `ASTRA_HOME` |
| 音乐 | `<ASTRA_HOME>/music` | `ASTRA_MUSIC_DIR` 或 `astra config set music.dir` |
| 视频 | `<ASTRA_HOME>/video` | `ASTRA_VIDEO_DIR` 或 `astra config set bili.dir` |

需要登录的能力（私人歌单、日推、B 站高画质）各自存一份会话文件，权限 600：
`netease-session.json` / `bili-session.json`。两者都是扫码登录，二维码出 PNG。
Steam 的凭据（Web API key + SteamID64）同样权限 600，存在 `steam-credentials.json`。

音源脚本不进仓库：`astra music source add <文件>` 导入，导入前会试加载。

## 开发

需要 Node ≥ 24（直接跑 `.ts`，用到 `node:sqlite`）。B 站能力另需 ffmpeg。

```sh
npm install
npm run astra -- music get アイドル YOASOBI
npm run check      # 类型检查 + 测试 + 打包
```

打包产物 `dist/astra.mjs` 是单文件（约 240KB），进容器只要一个 Node。

部署见 [部署手册](deploy/部署手册.md)（照着做）与 [架构说明](deploy/README.md)；
Hermes 用的 skill 在 [skills/music/SKILL.md](skills/music/SKILL.md)、[skills/bili/SKILL.md](skills/bili/SKILL.md)、
[skills/steam/SKILL.md](skills/steam/SKILL.md) 和 [skills/vrchat/SKILL.md](skills/vrchat/SKILL.md)。

## 目录

```
src/core/    输出约定、错误、配置、HTTP、按域代理、SQLite、飞书通知、命令框架、通用任务骨架、路径模板、二维码
src/lx/      洛雪音源宿主（vm 沙箱）与音源管理
src/music/   网易云接口、版本判断、酷我同曲匹配、取链、下载、标签、曲库、订阅、逐字歌词
src/bili/    B 站接口、wbi 签名、DASH 下载与合并、收藏夹/合集/UP 投稿、扫码登录
src/steam/   Steam 愿望单、库存、玩家资料、凭据
tests/       node:test；夹具是真实抓取的响应和 ffmpeg 生成的真实音视频
docs/        归档（每件事的"踩过的坑"）、PLAN（进度与待办）
```

## 设计取向

1. **一条命令办完一件事**：按用户意图切命令，不按上游 API 切
2. **拿不准就返回候选，不替用户选**：版本判断（翻唱 / Live / 伴奏）用真实搜索结果兜底
3. **只信实测**：音质看字节、时长看文件头、B 站画质看服务端实际给的
4. **宁可没有，也不给错的**：逐字歌词时长对不上就放弃；下错歌比不下更糟
5. **长任务不占住 AI**：批量走后台任务，命令立刻返回 job id

## 还可以做什么

大多数能力在 [astrahub](../astrahub/) 里已经有实现可以借鉴，对照见 [docs/astrahub-对照.md](docs/astrahub-对照.md)。
最近补完的是 B 站弹幕 / 热门 / 每周必看和整个媒体处理域。
还值得做的：B 站稍后再看（需登录）、图片处理、媒体拼接与水印。

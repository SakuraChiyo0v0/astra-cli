---
name: astra-bili
description: Use when fetching Bilibili media, rankings or trend data.
version: 0.1.0
author: SakuraChiyo0v0, Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Video, Download, Bilibili]
    category: media
prerequisites:
  commands: [astra]
required_environment_variables:
  - name: ASTRA_HOME
    prompt: astra 数据目录
    help: 部署时在容器环境里设好，例如 /opt/astra/home
  - name: ASTRA_VIDEO_DIR
    prompt: 视频下载目录
    help: 部署时在容器环境里设好，例如 /volume1/视频
---

# Astra Bilibili Skill

用 `astra` CLI 下载 B 站视频：自动选清晰度、合并音视频、核验时长。
不负责在线播放，也不做 B 站以外的事。

## When to Use

- 用户发来 B 站链接（`bilibili.com/video/BV...`、`b23.tv/...`）说"下载 / 存下来 / 离线看"
- 用户发 BV 号、av 号
- 用户问"这个视频有几集 / 多大 / 能下多清晰"
- 用户要某类图集：专栏（`read/cvXXX`）里的表情包 / 画师合集 / 壁纸清单

## Prerequisites

`astra` 在 PATH 里，并且**装了 ffmpeg** —— B 站把画面和声音分成两个流，不合并就没有声音。
`astra bili doctor` 能看到 ffmpeg 是否可用。

## How to Run

stdout 只有一个 JSON。`ok:true` 看 `data`，`ok:false` 看 `error.code` / `error.message` / `error.hint`。

## Quick Reference

| 想做的事 | 命令 |
|-|-|
| 下载（链接 / BV / av） | `astra bili get <...>` |
| 指定分 P | `astra bili get <...> --page 3` 或 `--page 2,5-8` |
| 指定画质 | `astra bili get <...> --quality 1080p`（4k/1080p60/1080p/720p/480p/360p） |
| 只要音频 | `astra bili get <...> --audio-only`（默认 mp3，自动写歌名 / UP 主 / 封面 / BV 号） |
| 先看有什么 | `astra bili info <...>`（加 `--probe` 看实际能拿到什么画质） |
| 存字幕 | `astra bili subtitle <...> [--page 1]` |
| 看某 UP 的图文动态 | `astra bili dyn <UP链接\|mid:xxx> --limit 20` |
| 抓某 UP 的相簿（官方海报/立绘） | `astra bili album <UP链接\|mid:xxx> --limit 40` |
| 看视频评论 | `astra bili comments <...> [--limit 20] [--sort hot\|time] [--replies]` |
| 找 UP 的 mid | `astra bili search <名字> --type user` |
| **查某 UP 最新投稿（有没有发新东西）** | `astra bili space <mid> --videos --limit 20` |
| 分区排行榜 | `astra bili ranking [--rid 游戏] [--limit 20] [--rookie]` |
| 收藏夹（读） | `astra bili fav list` |
| 收藏夹（写） | `astra bili fav add\|remove <...> --folder <收藏夹id>` |
| 关注 / 粉丝 / 黑名单数 | `astra bili relation [--mid <uid>]` |
| 关注列表 | `astra bili following [--limit 50] [--mid <uid>]` |
| 粉丝列表 | `astra bili fans [--limit 50] [--mid <uid>]` |
| 关注分组（有哪些组） | `astra bili groups` |
| 某分组里都有谁 | `astra bili group <组名\|tagid> [--limit 50]` |
| 建/删收藏夹 | `astra bili fav mkdir <名称> [--private]` ｜ `astra bili fav rmdir <id>` |
| 把图存下来 | 上面两条加 `--images --out <目录>` |

## Procedure

1. 用户发链接时，原样交给 `astra bili get <链接>`。
2. 看 `data.results`：
   - `downgraded: true` 表示**实际画质低于请求**。这时要明确告诉用户"你请求 1080P，实际只拿到 360P"，
     并说明原因：**未登录时 B 站封顶 360P**，登录（尤其大会员）才可能拿到 1080P60 / 4K。
   - 多分 P 时会返回 `warnings` 提示"只下了第 1 个"。用户要全部时用 `--page 1-10` 或逐个指定——
     **不要自作主张一次下几百集**，先问清楚。
3. 下载完成后告诉用户：文件路径、实际分辨率、时长、大小。

## 查某个 UP 主「最近发新东西了吗」

用户问「XX 出新歌了没 / 最近发什么了」时，三步，**顺序不能省**：

```bash
astra bili search <名字> --type user          # ① 名字 → mid（同名/近似名很多，按 name 精确匹配那个）
astra bili space <mid> --videos --limit 20    # ② 投稿列表，自带 pubdate，**最新在前**
astra bili info <bvid>                        # ③ 拿时长/简介/原曲等细节
```

- **同名 UP 靠名字是消不掉的，别拿第一个当目标**：搜 `大麦哥` 一次回 10 个账号，名字分别叫
  `大麦哥` / `Michael大麦哥` / `B站大麦哥` / `滨江大麦哥` …，但粉丝数从 **1 到 160,586**、视频数从 0 到 233。
  做法：按 `fans` + `videos` 排序，把**唯一一个量级明显不同的**挑出来，报「我理解你指的是 <名字>（粉丝 X、投稿 Y 条）」，
  让用户点一下再往下走；同名号全部列出来更省沟通。判据是「量级悬殊」不是「名字完全匹配」——
  用户口头说的昵称通常就是有感号的那个，冷号不会有人提。
- **`astra bili space <mid>` 不带 `--videos` 只回合集/系列（seasons / series），一条视频都看不到**——
  这是最容易卡住的一步，别据此判断「这个 UP 没投稿」。反过来，用户说「他有个合集 / 我想按系列听」时
  **这句就是正解**：带 `--videos` 才会列单条视频，两边正好互补。
- **问「合集」时要列成表再问他挑哪个**：每个 season 给 `title` / `count` / `description`（`ref=season:<id>`）。
  一个 UP 常常同时有主题合集 + 训练日志 + 旅行 vlog 之类的杂项合集（实测 6 个，最大 94 条、最小 1 条），
  只报「有 6 个合集」等于没说。列完再按「条数 × 平均时长」估一下体积（音频 FLAC 与 MP3 分两档估），
  然后停在「下哪个」这一步——**不要顺手把整季开下**，几百条的批量任务必须先拍板。
- **`astra bili collection season:<id>` 的返回顺序不是按时间**：合集里首尾都可能是旧稿，
  拿它判「最新一期」必错。判断新旧只看 `space --videos` 的 `pubdate`。
- 判定「有没有新东西」要给日期而不是「有」：报「最新一条是 <日期>，标题 <标题>，时长 <时长>」，
  用户要的是能不能马上听/看，不是一个布尔值。
- 音乐区 UP 的「新歌」通常就是一条普通投稿（改编翻唱），`--audio-only` 存 mp3 即可，封面会自动内嵌。

## 抓图文（dyn / album）

两个接口的可靠性差一个量级，别混用：

| 命令 | 接口 | 给什么 | 稳定性 |
|-|-|-|-|
| `bili album` | `draw/doc_list` | **完整图集**（官方号实测 1920×1080、1080×2853 竖版海报） | 免签名免登录，实测无风控 |
| `bili dyn` | `opus/feed/space` | 正文 + **一张封面图**，**无发布时间** | 要 buvid + wbi，有频率风控 |

**网页版那个 `polymer/feed/space` 在 Node 的 fetch 下恒返回 `code 0` + 空列表**（按客户端指纹的软拦截，
同样参数用 Python 能拿到）；加 `origin` / `accept-language` 不会绕过，反而升级成 `-412`。
所以 `dyn` 走的是兄弟接口 `opus/feed/space`。遇到空结果先怀疑风控，别改参数硬试。

**要官方高清图优先用 `album`**：`astra bili album mid:1636034895 --limit 40 --images --out /path`
（1636034895 是绝区零官号）。`dyn` 更适合要**文案**的场景，图片只是封面。

## 抓专栏（`read/cvXXX`）里的图

视频 / 动态 / 相簿之外还有一类图库：**专栏**。找成套原尺寸图集（表情包、画师合集、壁纸清单）
时它命中率最高，但三个坑是连着的：

1. **搜**：`x/web-interface/search/type?search_type=article&keyword=...` 要 **wbi 签名**
   （`nav` 取 `wbi_img` 的 img/sub key → 按 `mixinKeyEncTab` 重排取前 32 位 → 参数排序 + key 做 MD5 得 `w_rid`），
   裸拼参数返回 `-403`。现成脚本：`/opt/data/scripts/bili_article_search.py "关键词"`
2. **正文抓不到**：`https://www.bilibili.com/read/cv<id>/` 是客户端渲染，HTML 里只有 JS/CSS，
   正则 `<img>` 一张都拿不到；`x/article/viewinfo` 只给封面和作者，`origin_image_urls` 经常是
   一张「[图片][图片]…」的占位截图，别把它当图集
3. **真图在 `x/article/view?id=<cvid>` 里，且必须带登录 cookie**，匿名返回 `-509`。
   cookie 在 `/opt/astra/home/bili-session.json` 的 `cookie` 字段（约 400 字符，含 SESSDATA）。
   现成脚本：`/opt/data/scripts/bili_article_fetch.py <cvid> --out DIR`

```python
headers = {"User-Agent": UA, "Referer": "https://www.bilibili.com/", "Cookie": cookie()}
url = f"https://api.bilibili.com/x/article/view?id={cv}"
content = json.loads(urlopen(Request(url, headers=headers)).read())["data"]["content"]
imgs = re.findall(r"(?:https?:)?//[\w.\-]*hdslb\.com/bfs/(?:article|new_dyn|archive)/[^\"'\\\s)]+", content)
```

- 图片 URL 可能带 `@0.jpg` / `@480w` 之类后缀，去掉后缀再拼才拿到原尺寸
- **一篇专栏常混好几套画风**（搬运合集）：按图片尺寸分组是最省事的切分依据（同一套往往统一
  1000×1000，其它套尺寸杂），再抽一组给视觉模型确认是不是同一系列

## 评论 / 排行榜 / 收藏夹

三块接口的鉴权要求各不相同，别互相套：

| 能力 | 接口 | 鉴权 |
|-|-|-|
| 评论 | `/x/v2/reply/wbi/main` | **必须 wbi 签名**（老的无签版已废弃）；`mode=3` 热门、`mode=2` 时间倒序；`ps` 单页最多 49，`pn` 从 1 起；二级回复只给前 3 条 |
| 分区排行 | `/x/web-interface/ranking/v2?rid=&type=all\|rookie` | **免签免登录**；一次固定约 100 条，`limit` 只是本地截断 |
| 热门榜（当下） | `/x/web-interface/popular?ps=50&pn=N` | 免签免登录；**只有当前快照，没有历史** |
| 每周必看（历史） | `/x/web-interface/popular/series/one?number=N` | **必须 wbi 签名**，裸请求 `-352` |
| 收藏夹读 | `/x/v3/fav/folder/created/list-all?up_mid=` | 登录 |
| 收藏夹写 | `POST /x/v3/fav/resource/deal` | 登录 **+ csrf** |
| 关注列表 | `/x/relation/followings?vmid=<mid>&pn=&ps=50&order=desc` | 登录（看自己的）；`total` 在 `data.total`，`ps` 最大 50 |
| 粉丝列表 | `/x/relation/fans?vmid=<mid>&pn=&ps=50&order=desc` | 登录；对方设了隐私会拦，回 `-403`（不是风控，重试无用） |
| 关注/粉丝/黑名单数 | `/x/relation/stat?vmid=<mid>` | 免签免登，回 `following` / `follower` / `black` |

- **只有 `ranking/v2` 是活的**。老接口 `/x/web-interface/ranking?rid=&day=` 仍然能返回 `code 0` +
  100 条，但内容是**冻结快照**：全站 `day=1` / `day=30` 给的是 2020 年的视频，分区 `day=3` 停在一年多前。
  想确认榜单是否新鲜，抽一条去查 `view?bvid=` 的 `pubdate`，别信接口自己的 `note`。
  所以「日榜 / 周榜 / 月榜」这类需求**没有现成接口**，要么每天存一份 `ranking/v2` 快照自己攒，
  要么按发布时间搜索再本地排序——不要接老接口，它只是没下线，不是在更新。
- **排行榜接口不返回 `score`**：别自己编一个「综合分」填进输出，空着就行（早先版本输出全是 0，会被当成排序 bug 查半天）。
- **写操作的 csrf 就是 cookie 里的 `bili_jct`**；form 参数是 **`rid` = 视频 aid**、
  **`add_media_ids` / `del_media_ids` = 收藏夹 id**、`type=2`(视频)、`csrf`。
  **这两个位置容易写反，写反了接口照样回 `code: 0`、什么都不发生**。缺 csrf 返回 `-111`，未登录 `-101`，权限不对 `-403`。
- **`data.success_num` 恒为 0**，成功失败都一样，不能当判据。唯一可靠的验证是**读回收藏夹视频数**
  （`/x/v3/fav/resource/list?media_id=<fid>&ps=1` 的 `info.media_count`）：写前读一次、写后每 500ms 轮询、
  最多 8 次（有最终一致性延迟，实测 1 秒内生效），数字没按预期 ±1 就判定失败。
  `/x/v3/fav/resource/ids?aid=` 对私密收藏夹返回空、`resource/list?keyword=` 也搜不到，两者都别拿来判成员关系。
- **自测自己建夹自己删**：`bili fav mkdir <名> --private` → add → 读回 → remove → 读回 → `bili fav rmdir <id>`，
  全程不碰用户真实收藏夹；只拿一个不存在的 folder id 跑一次（回 `11010`）只能证明鉴权通了，**不能证明写入生效**。
- 写操作有频率限制，一次一条，不要批量刷；评论/排行连调多次会 `-352`，等几分钟再试。

- **关系类三条命令（`relation` / `following` / `fans`，0.31.2 起）**：默认 50 条、上限 500，
  每页 50 翻页，**翻页之间隔 2 秒**（实测 434 个关注 9 页 10 次请求零风控）。`--mid` 可查别人。
- **隐私和风控必须分成两个错误码**：对方设了「列表仅自己可见」时接口回 `-403`，重试无用，直接告诉用户
  看不到；`-352` / `-412` 才是风控，标 `retryable` 等几分钟。混成一个 `BILI_API_ERROR`，用户没法判断该等还是该放弃。
- `relation/stat` 对**别人**也准且免登录；两个列表要带自己账号的 cookie，匿名只能拿到极少数公开账号。
- 注销账号的 `uname` 是空字符串，列表里要退回 `mid<n>`，别让名字变空（用纯函数单测锁住，真实账号复现不出来）。
- B 站**不提供关注时间**，列表顺序就是「最近关注在前」，不要自己编一个 `followedAt` 字段。
- **关注分组（0.31.3 起：`bili groups` / `bili group <名字|tagid>`）**走 `/x/relation/tags`（列表，带
  `count`）和 `/x/relation/tag?tagid=&pn=&ps=`。两个必须记住的点：
  - `/x/relation/tag` 的 `data` 是**扁平数组**，**没有 `total`、没有 cursor** —— 总数只能取 `/tags` 里的
    `count`，循环「翻到空页」为止。照 `/followings` 那样读 `data.total` 会永远拿到 0。
  - 名字匹配到多组时必须报歧义并列出来，**不能返回第一个匹配**：`内容频道` 同时命中
    「文字内容频道 / 视频内容频道」，挑错了用户会以为看的是另一组。`tagid -10`（特别关注）、`0`（默认分组）
    是内置的，不能删也不能改名。
  - 用户已有分组时，先 `bili groups` 把「每组人数」摆出来再谈归类建议；默认分组里剩的人就是没归类的。
  - 写分组（移动成员 / 建组 / 改组名）会改用户账号数据，**先出清单让他审，别直接批量移动**。
    移组走 `POST /x/relation/tags/moveUsers`（表单 `beforeTagids` / `afterTagids` / `fids` / `csrf`；
    **csrf 字段名就叫 `csrf`**，值取 cookie 里的 `bili_jct`）。`beforeTagids=0` 是「从默认分组移出」、
    `afterTagids=0` 是「移回默认分组」——**移组不是取关**；`addUsers` 只加不移（会同时留在多个组），
    换组必须用 `moveUsers`。
  - 铺批量前先拿一个人做往返（移入 → 读回 → 移回 → 读回）确认接口真生效，再按组逐个移动并**重读
    `count` 对照预期**，不要拿 `code: 0` 当验收；期望值每轮重新读，别用循环外的旧快照算。
  - 分类有争议的个别人用 `--override 名字=组名` 单独纠正，**不要回头调关键词权重**——
    权重一动会伤到已经判对的人。现成脚本：`/opt/data/scripts/bili_move_group.py --batch <归类JSON> [--apply]`
    （不加 `--apply` 只打印计划）。
  - **批量归类的判据用「投稿标题关键词」，别指望拿分区名**：`space/wbi/arc/search` 的 `vlist` 只有
    数字 `typeid`，`view?bvid=` 的 `tname` 实测是空串，`v2/region/index` 直连 `-400`、
    `web-interface/newlist` 返回 0 条、视频页 HTML 是 SPA 空壳 —— 所以硬编码一张 id→分区名表就是在猜。
    流程：`scripts/bili_suggest_groups.py`（按 tagid 拉人 + 每人最近 20 个投稿标题，落 JSON）→
    `scripts/bili_classify_groups.py`（离线按键词打分归类，不再发请求，可反复调规则）。
  - **打分要区分「具体组」和「泛词组」**：`我的世界 / 二次元游戏 / AIGC / 数码 / 饭饭 / VRC / 音乐`
    命中一次记 2 分，`游戏 / 科技 / 视频内容` 这类泛组记 1 分 —— 否则「单根 DDR5 内存，游戏帧数差距有多大」
    会被判成游戏区。另外单字关键词（`吃`、`面`）必须剔除，它会把犯罪纪实、社会杂谈整个吸进美食组。
  - 归类结果要带**原文证据**（命中的那条标题）并保留「无法判断」一档：只有 3 条标题时误判不低，
    用户要能逐条核对；只给组名的清单等于不给他反驳的机会。
- **`ranking/v2` 的 `rid=13`（番剧）回 `-400`**：番剧走 PGC，不进这个接口。批量抓分区时遇到 `-400`/`-404`
  要**跳过这一项继续**，不要整批中止 —— 一条不支持的 rid 会让后面十几个分区全丢。

## 热门榜与「每周必看」：想要历史数据只能靠这两条

`popular`（热门）和 `ranking/v2`（综合榜）是两个完全不同的池子，别混：

| | 热门 | 综合榜 |
|-|-|-|
| 范围 | 全站一个池 | 每个分区各 100 条 |
| 容量 | 约 500–600 条（`ps=50` 翻到第 11 页就空，`pn=15` 已无数据） | 每分区约 100 条（冷门分区 70–97） |
| 排序 | 平台热度（无分数） | 官方综合分（不返回 `score`） |
| 时效 | 极新：实测 68% 是最近两天，最早只到 7 天前 | 较宽，仍有几天前的老稿 |
| 字段 | 带完整 `stat`（view/like/coin/favorite/share/reply/danmaku）+ `pubdate` + `tname` | `stat` 较全，无 `pubdate` |
| 重叠 | 实测与综合榜 1731 个视频只重叠 74 个 | — |

- **热门没有历史接口**：`popular` 没有日期参数，只返回「此刻」。任何「过去 30 天的每日热门」都拿不到，
  只能每天存一份快照自己攒；不要为了「补历史」去翻各种第三方镜像，数据对不上。
- **唯一能回溯的官方历史榜是「每周必看」**：`popular/series/list` 给期数（实测 396 期，从第 1 期到最新），
  每期 `series/one?number=N` 回 40–100 条，带 `stat` + `pubdate` + `tname` + `subject`。
  **这个接口必须 wbi 签名**，裸请求恒 `-352`（`ranking/v2` 免签，别把经验套过来）。
- 近 30 天的历史数据 ≈ 最近 4–5 期周榜；「日」粒度历史数据不存在，只能靠快照积累。
- **用户说「就是做个实验 / 随便跑跑」时，讲清口径 + 跑一次就停，不要再推销 cron 定时采集**：
  给他「想要就得从今天开始攒」这个事实，然后把决定权留给他；反复提自动化会让实验变成任务。
- **用户问「这个榜是什么 / 原理是啥」时，先把口径讲清再动手抓**：排序依据（官方综合分 vs 热度，均不返回分数）、
  容量、时效窗口、能不能回溯。他关心的往往不是能不能抓到，而是「这份数据能回答什么问题」，
  直接开跑再解释会被打断重问。

批量采集的限速配方（实测 33 次请求 2 分钟，零风控）：
```
请求间隔   sleep(2.5 ~ 3.5 秒) 随机
-352/-799  等 120 秒重试，最多 3 次
-412       立即中止（IP 级风控，硬刚会升级封禁）
-400/-404  跳过这一项，继续后面的
```

现成脚本（都是「抓 → 拼 upsert SQL → `astra db exec --write`」一条龙，幂等可重跑）：

```bash
python3 /opt/data/scripts/bili_rank_collect.py --popular-pages 12   # 22 分区综合榜 + 热门
python3 /opt/data/scripts/bili_weekly_collect.py --issues 8         # 最近 8 期每周必看
python3 /opt/data/scripts/bili_suggest_groups.py --tagid 0          # 某分组的人 + 各自最近投稿
python3 /opt/data/scripts/bili_classify_groups.py                   # 离线归类建议（不发请求）
python3 /opt/data/scripts/bili_move_group.py --batch /…/group_suggest2.json --apply   # 按清单移组
```

落库位置是 PG 的 `crawl` schema（迁移在 `<ASTRA_HOME>/db/migrations/`，`astra db schema apply` 应用）：

| 表 | 内容 | 主键 |
|-|-|-|
| `crawl.bili_video` | 视频维度（bvid / title / owner / first_seen / last_seen） | bvid |
| `crawl.bili_rank_entry` | 分区榜快照（snap_date / rid / rank / view / like / danmaku / duration） | (snap_date, rid, rank) |
| `crawl.bili_popular` | 热门快照（pos / 完整 stat / pubdate / tname） | (snap_date, pos) |
| `crawl.bili_weekly` | 每周必看（issue / pos / 完整 stat / pubdate / subject） | (issue, pos) |

事实表都带 `bvid` 外键，所以**先插 `bili_video` 再插事实表**，否则整批回滚。
已经验证过的一组分析 SQL（投币率、双榜重叠、时长分布、UP 霸榜、周榜更替）见
`references/ranking-analysis.md`。

## Pitfalls

- **`-352` / `-412` 是风控**，不是参数写错：排行榜连调几次、评论翻页太快都会触发，等几分钟即可；
  这类错误要标 `retryable` 并给「等几分钟」的 hint，否则下一次会当成 bug 去改代码。

- **未登录画质封顶 360P**，这不是 bug。想拿高画质需要 `astra bili login start` 扫码（二维码是 PNG，
  用 `MEDIA:<data.qrImage>` 发图，然后轮询 `astra bili login poll`）。
- 多分 P 视频默认**只下第 1 个**，避免一口气下几百集。
- `BILI_API_ERROR` 里 code `-403` 是私密或地区限制，`-404` 是视频不存在。
- **裸 `x/web-interface/view?bvid=` 返回 `HTTP 412 Precondition Failed` 是风控**，不是视频下架：
  补 `Cookie`（同 `/opt/astra/home/bili-session.json`）+ `Referer: https://www.bilibili.com/video/<BVID>/`
  + 浏览器 UA 即正常返回 `code 0`。同样适用于 `x/article/view`（匿名 `-509`）。
- 番剧 / 部分老视频没有 DASH 分轨，成品可能画质选项少，`warnings` 会说明。
- 下载体积可能很大（4K 一集几百 MB），用户没说要高画质时默认 1080p 就够。
- **`dyn` 和 `album` 别指望有日期**：`opus` 接口 `pub_time` 恒空、`opus/detail` 被 -352 挡，
  所以 `dyn` 的 `date` 是 null、存图名是 `undated_<opusId>_<n>`；`album` 有 `ctime`。
- **`dyn` 报 `BILI_DYN_RISK`** 是频率风控，等几分钟再试；抓几百张图时用 `album`（无风控），
  大批量抓完再抓动态，否则会把动态接口打到 -412。

## Verification

`astra bili doctor` 里 api 和 ffmpeg 都是 ok。下载完成后 `data.results.durationSec` 与分 P 记录的时长一致。

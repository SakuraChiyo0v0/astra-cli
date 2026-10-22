# Changelog

## 0.12.9 — 2026-10-22

**新增 `music lyric`：只取歌词，不下载音频**

- **新增**：`astra music lyric <关键词|ref> [--word] [--out <路径>] [--duration <秒>]`。
  给库里已有音频、想补歌词的场景用 —— 典型是 `bili get --audio-only` 下来的翻唱 mp3，
  重下会重复占盘，还会打乱已经整理好的文件名和标签
- 默认给逐行 LRC；`--word` 额外取酷狗逐字增强 LRC。`--out` 按既有约定落盘：
  `.lrc` 放逐字、`.line.lrc` 放逐行
- **`--duration` 是关键**：库里是 B 站音频时它不是网易云记录，逐字的时长校验
  必须用实际音频时长，否则三道闸门全对不上
- **不替用户选版本**：搜「年轮」第一条是汪苏泷 4:06 的男声版，张碧晨原版 4:35 排第二。
  歌名并列时报 `LYRIC_AMBIGUOUS` 并列出候选，带上歌手或 `wy:<id>` 才继续。
  逐字取不到不算失败 —— 返回 `word: null` 加一句原因，逐行照常给
- **修**：酷狗 KRC 的 `[total:0]` 被当成真实时长，与任何歌都差出几分钟，
  把**正确**的逐字歌词整批丢掉。0 现在按"读不到"处理
- **修**：KRC 里的「作词 / 作曲 / 编曲」行会被播放器当成第一句歌词高亮，现在过滤掉

## 0.12.8 — 2026-10-22

**改标签后 Kura 挂载盘上永远显示旧标签 —— 因为写出来的文件大小没变**

- **修（严重）**：重写标签时 padding 是固定长度（MP3 1024、FLAC 4096），改个标题
  文件总大小纹丝不动。而 rclone / WinFsp 挂载判断"远程文件变没变"**只比大小**
  （WebDAV 没有内容哈希，`vfsMeta` 里的 `Fingerprint` 就是字节数），于是挂载盘上
  一直是旧标签，刷新、重启都不管用。实测：原地覆盖成同样大小的新内容、mtime 明明
  变新了，挂载盘读到的仍是旧内容；差 1 个字节才会重新下载。日常最常发生的就是
  `年轮` → `花海` 这种**等字节长度**的改名，必中
- 现在 padding 由标签内容的 sha256 决定，落在 `[512, 1535]`。同一份标签算出同一个值
  （`retag` 重跑不会反复改文件），不同标签几乎必然算出不同值，总大小也就跟着变
- 那个 `_寒夜剩我一个人等清晨_《年轮》_AI東 雪蓮` 的长标题就是因为这个才一直不消失
- 测试：`tests/tags.test.ts` 加 3 项。**第一版写错了** —— 拿长短不同的标题去比，
  长度本来就会变，撤掉修复照样绿。改成两个**等字节长度**的标题（`年轮`/`花海`）后
  才真正抓到：撤掉修复，MP3 和 FLAC 两条都变红
- 注释：`embeddedIdentity` 只读前 64KB，大封面（B 站实测 148KB）会把 `TIT2` 挤出去，
  此时返回 null 表示"不知道"而非"不是这首"；`identityMismatch` 因此放行。行为本来就对，
  但没写清楚，容易被后来人"顺手修成"拒绝

## 0.12.1 — 2026-10-21

**修复 v0.12.0 的代理实现，其中一条会在配了代理之后静默改坏所有写请求。**

- **修（严重）**：经代理的请求一律被写成 `GET`、body 被丢弃。`proxy.include` 留空表示
  "全部走代理"，所以只设 `proxy.url` 不设 `include` 时，网易云登录轮询、红心、飞书 webhook
  全部变成无 body 的 GET —— 上游报错，但看不出原因。现在方法 / body / Content-Length 原样带过去，
  并新增 `PUT` / `DELETE` 的覆盖。`proxiedGet` → `proxiedRequest`
- **修**：经代理的请求绕过了 `retries`，5xx 不再重试。现在直连和代理走同一套重试
- **修**：代理连不上时错误漏成 `INTERNAL` / exitCode 1 / 不可重试。现在归一为
  `NETWORK_ERROR` / exit 5 / `retryable: true`，hint 指向代理网络
- **修**：入口判定在**路径含空格**时静默失效（退出码 0、零输出）。`URL.pathname` 是百分号编码
  路径，和 `argv[1]` 永远对不上；改用 `fileURLToPath` + `realpathSync`
- **修**：`steam-credentials.json` 没进 `.gitignore`（仓库是公开的），一个 `git add .` 就会把
  Web API key 推上去
- **修**：经代理时的 gzip/chunked 解压后没有同步 `Content-Length`，调用方会误判正文长度
- **修**：`appDetails` 的注释写"一次最多 50 个、内部分批"，实际是逐个请求并发 4，没有上限
- 测试：新增 `tests/proxy-transport.test.ts`（12 项，本地起真代理）与 `tests/entry.test.ts`
  （6 项，在带空格/中文目录里跑打包产物）。两条都验证过"撤掉修复会变红"
- 文档：README 补 Steam 与代理、更新规模数字；新增 `skills/steam/SKILL.md`；
  `deploy/README.md` 补 `proxy-net` 的前提与配置；`docs/PLAN.md` 勾掉 P4-1；
  `config list` 里写清 `proxy.include` 留空 = 全部走


## 0.12.7 — 2026-10-23

**修 `bili subtitle` 会返回别的视频的字幕 —— 同一个 BV 每次结果还不一样**

- **修（严重）**：字幕列表走的是不带签名的 `x/player/v2`。实测同一个 `bvid+cid` 连调 6 次：
  1 次返回**空的 `subtitle_url`**、1 次丢掉 `zh-CN`，URL 还停在过期的 CDN 值上不刷新
  —— 那个路径上的内容可能早换给别人了。改用 `x/player/wbi/v2`（带 wbi 签名）后，
  4 次调用内容哈希完全一致
- **新增自检**：字幕末条时间**超过**分 P 时长就判为串台、丢弃并给 `warnings`
  （原先 2 分 37 秒的视频配上了 28 分 36 秒的旅游 vlog 字幕）。只卡上限不卡下限 ——
  《年轮》4:32 的字幕止于 4:01 是正常的，片尾纯音乐本来就没词
- 空的 `subtitle_url` 直接过滤掉，不再让调用方 `fetch('')` 抛错
- 人工字幕（`zh-CN`）排在 ASR（`ai-zh`）前面写，两份都保留
- 返回值补 `cid` / `durationSec`，每份字幕补 `lastCueSec`，方便人工核对
- **顺带修**：`bili get --audio-only` 碰上非 DASH 的整段流（番剧、部分老视频）时，
  把**带画面的整段流**直接存成 `.mp3` —— 扩展名说谎、没有标签、没有 BV 号。
  现在这条路也过音频管道

## 0.12.6 — 2026-10-23

**B 站音频写入 BV 号：离开下载目录后还能追回原视频**

- **新增**：`bili get --audio-only`（`bili.tag=true`）现在额外写两个字段 ——
  `BILIBILI_BVID`（BV 号）与 `BILIBILI_URL`（可直接点开的视频地址）。
  MP3 走 ID3 的 `TXXX`，FLAC 走同名 Vorbis 键
- **背景**：`SOURCE_ID` 里本来就有 BV 号，但那个键名播放器不显示；音频一旦被转码、重命名、
  拖进别的库，就再也追不到是哪条视频了（提需求的人原话是要能回原视频补歌词 / 换画质）
- `music/tags.ts` 的 `TagData` 新增 `extra` 自定义字段表，两个域共用一套写法；键名统一大写
- `bili get --help` 与 `skills/bili/SKILL.md` 更正：`--audio-only` 输出的是
  `bili.audio-format` 决定的格式（默认 mp3），不是文档里一直写的 m4a
- 测试：`tags` 与 `bili-audio-tag` 两条都加了 BV 号断言，并验证过"撤掉修复会变红"

## 0.12.5 — 2026-10-23

**歌词文件改名：逐字写 `.lrc`，逐行兜底 `.line.lrc`**

- **修**：逐字歌词一直写成 `.word.lrc`，而播放器 / Navidrome 只按 `<歌名>.lrc` 找 sidecar ——
  换个扩展名等于永远不被读取，逐字歌词写了也没用。现在 `.lrc` 放逐字（增强 LRC 是普通 LRC 的超集，
  认普通 LRC 的播放器也能读），另存一份逐行的 `.line.lrc` 给不认逐字标签的播放器兜底
- 返回值新增 `lineLyricFile`；旧的 `wordLyricFile` 保留（指向同一份），不打断已有脚本
- **修**：任务项状态词统一为 `downloaded`（原 `done`）。`job --items` 与单曲 `data.status`
  现在同一套词，按 `== "downloaded"` 过滤不会再拿到空集合。带一条迁移把历史 `done` 改写成 `downloaded`
- 兼容：`.word.lrc`（存量文件名）仍然识别，`retag` 搬文件时三种命名都跟着走


## 0.12.4 — 2026-10-23

**内嵌歌词改为同步格式（Navidrome 不再显示"无歌词"）**

- **修**：写进文件的歌词是剥掉时间戳的纯文本，播放器解析不出滚动歌词。
  现在优先用逐字歌词（`<mm:ss.xx>`），其次普通 LRC（`[mm:ss.xx]`），纯文本只作最后兜底
- **修**：逐字歌词原本在**写标签之后**才取，内嵌永远拿不到它。改到写标签之前取一次，两处复用
- **新增** `music.lyric` 取值：`embed` / `embed-synced`（默认行为，带时间戳）、
  `embed-plain`（纯文本，给不认时间戳的老播放器）、`lrc` / `both` / `none`
- **修**：音乐订阅未指定音质时写死 `flac`，没有继承 `music.quality` 配置
- **新增** `astra music template`：列出全部模板变量与取值示例，可 `--set` 改模板。
  这些变量原先挤在 `config list` 一行描述里，说不清 `{albumartist}` 在合辑/合作曲上的差异
- **改进**：音乐订阅 list 的 `quality` 为 null 时输出 `qualityNote`，说明实际用哪个档位
- **新增** `astra music retag`：把已下好的歌按当前规则重写标签和落盘路径。
  默认只预览，带一次性令牌确认才动手；先算完全部目标路径、确认无冲突才改，
  写标签前后比音频哈希。这就把「合作曲归主艺术家」「群星合辑归 合辑/」等改动
  补到了存量文件上
- **修**：`retag` 重写标签时把老文件里的纯文本歌词原样写回去，等于抵消本次修复。
  改为优先读同目录的 `.word.lrc` / `.lrc` 换成带时间戳的，都没有才沿用原值
- **修**：`retag` 会拿曲库里过期的 `native_id` 去查专辑，而网易云的 id 会被另一首歌复用 ——
  实测随手编的 `999001` 是 Anouar Brahem 的《Claquem les voiles》。不看一眼就会把文件
  搬进完全不相干的歌手目录。现在先核对标题 + 首位歌手，对不上就整组跳过并说明原因
- **修**：`retag` 的预览里 `summary` / `sample` 被令牌结构里的 `preview` 字段顶掉了，
  调用方看不到"要动几个、动到哪"
- 测试：retag 冲突检测（同目标 / 目标被占 / 大小写不敏）、音频载荷哈希不变、
  `.lrc` 跟随、曲库路径同步、id 对不上时拒绝迁移


## 0.12.3 — 2026-10-23

**修合作曲被拆成假歌手目录（P0），以及一批一致性问题**

- **修（P0）**：合作单曲落盘到「Lady Gaga, Bruno Mars」这种假歌手目录。两处一起改：
  1. 源头：`albumInfo` 优先取专辑的 `artists` 复数字段，而网易云会把**曲目歌手**灌进这个字段。
     改为单数 `artist` 优先，复数只兜底
  2. 下游：`albumArtistsFor` 去掉"专辑级有多个就 join"的分支，**永远只返回一位**。
     只修源头不够 —— 专辑级真的写了多个名字时仍会拼
  实测 `Lady Gaga/A Star Is Born Soundtrack/12 Shallow.flac`、`Lady Gaga/Die With A Smile/01 ...`
- **修**：`bili subscribe list` 增加 `ref` 字段，可直接喂给 `collection` / `bulk` / `subscribe add`
  （原字段 `target` 保留，不打断现有脚本）
- **修**：`vr login` 两步验证的提示写 `astra vr login 2fa <code>`，照着敲会报「参数太多」。改为 `--code`
- **修**：`bili bulk` 新增 `--pages 1,3-5`，按分 P 选择性下载（原来只能全下或只下 P1）
- **新增**：模板变量 `{artist_list}`（分号分隔）与 `{source}`（音源标识）
- **改进**：`help` 的 conventions 写清两套 status 的区别 —— 单次操作用 `downloaded`，
  后台任务项用 `done` / `skipped`。混用会静默得到空集合
- **改进**：订阅的 `quality` 为 null 时输出 `qualityNote`，说明运行时实际用哪个档位
- 测试：新增合集 ref 三种写法的回归测试（防 `season:<sid>` 再退化）、`--pages` 解析测试、
  专辑艺术家取值测试


## 0.12.2 — 2026-10-23

**音乐：合辑归到一处，专辑艺术家不再拼一串**

- 合辑（网易云专辑歌手是「群星」）落到 `合辑/<专辑>/`，不再每个歌手各起一个目录。
  目录名可用 `music.compilation-dir` 改，设成 `Various Artists` 就让 Navidrome 按惯例归类
- 合辑的 `album_artist` 标签写 `Various Artists`（Navidrome / Plex 认的标准值，「群星」它们不认）
- 新增模板变量 `{primary_artist}`：只取第一位歌手。原来的 `{artist}` 仍拼全部歌手
- 合辑只影响新下载；已下好的文件不动


## 0.12.0 — 2026-10-21

**新增 Steam 域 + 代理基础设施**

- `steam wishlist`：愿望单，带名字/价格/折扣/加入日期。实测 111 个条目
- `steam inventory`：公开库存（CS2、Steam 卡牌等）。**当前被 Steam 限流（429）**，功能完整但环境不通
- `steam me` / `steam doctor`：玩家资料与自检
- `steam auth set-user/set-key/clear`：凭据存在本机，权限 600，key 只显示 8 位指纹
- **按域走代理**：`proxy.url` / `proxy.include` / `proxy.exclude`。Steam 走代理，B 站网易云直连
- 零依赖实现 HTTPS CONNECT 隧道（`core/proxy.ts`），自己解 chunked 与 gzip

**基础设施解耦**：mihomo 从 `asf_default`（ASF 项目的网络）抽到独立的 `proxy-net`。
之前代理的可用性被绑在挂卡服务上，ASF 一重建就断。

**修**：`https.request` 在已握手的 socket 上会二次握手，导致 Steam 返回 400；429 现在标为可重试并给提示


## 0.10.7 — 2026-10-21

- 修正上下文阈值：`threshold_tokens` 从 8 万放宽到 40 万（1M 窗口的 40%）。
  实测 WorkBuddy2API 支持 prompt cache、第 2 次起命中 99.9%，"重读历史"并不等于付全价，
  早压缩的收益远小于丢掉有用历史的损失。换模型提醒的阈值同步放宽到 40 万


## 0.10.6 — 2026-10-21

- Hermes 配置加上下文成本控制：`compression.threshold_tokens: 80000`（到 8 万就压缩，不等比例阈值）、
  `model.switch_context_confirm_tokens: 100000`（换模型时提醒）
- 飞书链路实测通过：用户在飞书里发 `/model` 得到正常响应与提醒


## 0.10.5 — 2026-10-21

- 修：`astra audit` 的 usage 里写了 `--domain / --failed / --since / --limit`，但这四个选项一个都没声明，
  照着用法敲会报 "Unknown option"。已补上声明
- 新增命令一致性测试：所有命令的 usage 提到的 `--选项` 必须在 options 里声明过，
  并检查命令名唯一、usage/summary 齐全
- 部署侧：清掉 NAS 上重复的旧 skill 目录（`vrchat` 与 `astra-vrchat` name 相同）、
  把 `bili` 统一成 `astra-bili`，三个 skill 的目录名现在与 frontmatter 的 name 一致


## 0.10.4 — 2026-10-21

**UP 主全量投稿做成了。**

- `bili space <mid> --videos [--keyword 词] [--limit N] [--download]`
- 走 `series/recArchivesByKeywords`（`keywords` 留空即全部），**免签名免登录**。
  实测「老番茄」返回 682 个投稿，带关键词能按标题筛
- 之前放弃是只盯着 `space/wbi/arc/search` 加参数（签名/设备指纹/浏览器头全试过）。
  方向错了：**换个功能相近但风控不同的接口**才是解法。线索来自社区文档存档里的
  "另见 根据关键词查找视频，功能基本相同，暂未发现风控校验"


## 0.10.3 — 2026-10-21

- 新增 `bili space <UP链接|mid:546195>`：列出某个 UP 的**合集与系列**
- **全量投稿接口做不了**：`space/wbi/arc/search` 试了 wbi 签名、完整浏览器头、设备指纹
  （`buvid3`/`buvid4`）、移动端接口，一律 `-352` / `-412`。参数越像浏览器封得越狠，不硬啃
- 替代方案实测可用：`seasons_series_list` **免签名**就能列合集/系列，
  而 UP 的视频绝大多数按合集组织，所以"列合集再逐个下"覆盖了大部分需求
- 补：系列名要单独查 `/x/series/series`；UP 名要查 `/x/web-interface/card`（合集 meta 里的 name 是合集名）


## 0.9.3 — 2026-10-21

- 部署：放开 `/opt/astra/skills` 写权限，让 Hermes 能自己维护技能文档
  - 挂载去掉 `:ro`；写入白名单用**环境变量** `HERMES_WRITE_SAFE_ROOT`（不是 `config.yaml` 的键）
  - 实测判定：skills 下可写，`/opt/hermes` 代码与 `/etc/passwd` 仍被拒


## 0.10.2 — 2026-10-21

- 新增 `astra backup [list|restore]`：曲库数据库（VACUUM INTO 一致快照）与三个会话文件，
  默认留 7 份；`restore` 会先把当前库改名保留，有任务在跑时拒绝
- 新增写操作审计：红心 / VRChat 的加好友、退群、收藏、改状态等都留痕，
  `astra audit [--domain|--failed|--since]` 可查，`audit prune` 只留最近 1000 条
- 修：审计的 detail 原本按字符截断 JSON，切成半个字符串导致整条记录读不出来；改成超长时记明确的截断标记


## 0.10.1 — 2026-10-21

- `astra login` 现在也列 VRChat 的登录状态；新增 `astra login clear [域]` 清理坏掉的会话文件
  （会话文件权限不对、内容坏了导致 logout 都进不去时用）
- `doctor` 增加磁盘用量：音乐 / 视频目录各占多少、所在文件系统还剩多少，剩余低于 10GB 会告警
- 实测 NAS：音乐 501MB/34 文件、视频 277GB/240 文件、磁盘剩 2.5TB


## 0.10.0 — 2026-10-21

按使用反馈补 P2 两项。

- **`bili search`**：视频 / UP 主搜索（wbi 签名）。**不给列某 UP 的全部投稿** ——
  `space/wbi/arc/search` 带签名也返回 -352 风控（实测）
- **`bili collection`**：只列合集 / 系列 / 收藏夹清单，每项带 `downloadWith`
- **`bili subscribe add/list/set/remove/run`**：定时盯合集 / 系列 / 收藏夹，出新视频自动下。
  复用音乐的 `subscriptions` 表；第一次跑只记基线（否则会把整个合集当新视频一次下几百个）


## 0.9.3 — 2026-10-21

- 新增跨域统一任务入口：`astra jobs` 一次列出所有域的任务（带 domain 标签与按域统计），
  `astra job <id>` 不用先知道任务属于哪个域就能查进度 / 取消 / 继续
- 修：`jobs.quality` 原本是 NOT NULL，导致没有"档位"概念的任务（如 VRChat 类）建不出来。
  迁移重建了这张表，`quality` 改为可空；已在真实数据库上验证（4 个任务、23 项全部保留）


## 0.9.3 — 2026-10-21

按实际使用反馈补的两项（合集链接的 P0 已由 20a6827 修复）。

- **`bili get --audio-only` 一条龙**：转码 → 写标签（title/artist/album/date）→ 内嵌封面。
  新配置 `bili.audio-format`（mp3 默认）/ `bili.audio-bitrate` / `bili.tag`。
  分 P 视频用分 P 名当 title；结果里 `coverEmbedded` 标明封面已内嵌，`videoCodec` 不再把封面误报成视频流
- **`music upgrade [--scan N] [--apply]`**：先问"现在能拿到什么"，确实更好才列入。
  与 `have --low` 的区别：低规格 ≠ 能升级 —— 实测曲库里 12 首"低于 24bit"，
  逐首问官方后没有一首真能升（母带就是 16bit）。并区分"查不了"与"升不了"


## 0.9.0 — 2026-10-21

按实际使用反馈补的三项。

**P0 修：合集链接**
- `bili bulk` 现在认 `collectiondetail?sid=` / `seriesdetail?sid=` / `lists/<id>` 链接，
  以及 `season:<sid>` / `collection:<sid>` / `series:<mid>/<sid>` 简写
- 实测发现 **mid 其实可省略**（`seasons_archives_list` 只给 season_id 也能返回）；
  之前那次 404 是 sid 本身不存在，被误读成"缺 mid"

**P1 音频下载一条龙**
- `--audio-only` 现在自动完成：转码 → 写标签（title/artist/album/date）→ 内嵌封面
- 新配置 `bili.audio-format`（mp3 默认 / flac / m4a）、`bili.audio-bitrate`、`bili.tag`
- 分 P 视频用分 P 名当 title（那才是"这首"的名字）
- 结果里 `coverEmbedded` 标明封面已内嵌，`videoCodec` 不再把封面误报成视频流

**P1 音质升级**
- `music upgrade [--scan N] [--apply]`：先问"现在能拿到什么"，**确实更好**才列入
- 与 `have --low` 的关键区别：低规格 ≠ 能升级。实测曲库里 12 首"低于 24bit"，
  逐首问官方后没有一首真能升（母带就是 16bit）
- 区分"查不了"（未登录/网络）与"升不了"（母带就这样）


## 0.9.0 — 2026-10-21

补完 B 站、媒体、音乐三处缺口。

- `bili later`：稍后再看，可 `--download` 一键批量下（需登录）
- `bili history`：观看历史，同上
- `media concat`：按顺序拼接；参数一致时直接拷流，不一致自动重编码并提示
- `media watermark`：文字 / 图片水印，自动找中文字体
- `music covers`：给专辑目录补 `cover.jpg`（从文件内嵌封面提取，不联网）
- `music m3u`：导出 M3U8（用 UTF-8 而非本地编码，中文路径不乱码）
- 修：封面提取漏跳 FLAC PICTURE 的 desc 与宽高字段，永远返回 null
- 修：水印位置公式用 `w/h`（画面尺寸）而非 `text_w/text_h`，水印被推出画面外
- 修：拼接重编码时 scale 定义了却没接进 filter 链，concat 报参数不匹配


## 0.8.5 — 2026-10-21

- VRChat 补群组：`vr groups info`（详情 + 成员 + 角色 + 启用权限 + 公告）、`vr groups member`、
  `vr groups join` / `vr groups leave`（写操作，走确认）
- 加入需审批的群只会变成「申请中」，命令说明里提醒用 `groups member` 再确认


## 0.8.4 — 2026-10-21

- VRChat 补经济类：余额改用正确的 `GET /user/<built-in function id>/balance`（原先是 `/user/subscription`），
  `vr economy` 顺带给出各类型收藏上限，新增 `vr transactions` 交易明细
- 只读，不发起任何交易；余额缺失时是 null 不是 0


## 0.8.3 — 2026-10-21

- VRChat 补三块：收藏分组的建/删、头像切换与回退、平台系统信息与权限位清单
- `vr system` 不用登录就能看在线人数和上游时间；`vr permissions` 要登录，返回的是**平台定义了哪些权限**而非本账号的权限
- 删收藏分组前会先报出分组里有几个收藏（删分组会连带没掉）


## 0.8.2 — 2026-10-21

- 新增 `astra login`：一次看所有域的登录状态（谁登了、哪个会话文件坏了、怎么登）
- 会话文件坏了（空 / 权限过宽 / 非法 JSON）单独报 `stale_file`，而不是笼统说"未登录"——
  后者会让人去重新扫码，但真正的问题是权限
- 修测试：`withHome` 写成同步包装，`finally` 在 `await` 前就删了目录，几项断言其实没生效


## 0.8.1 — 2026-10-21

- 修：`bili bulk` 的 help 说支持合集链接，实际只认 BV / av / 视频链接，传
  `space.bilibili.com/<mid>/channel/collectiondetail?sid=xxx` 会报 `BILI_BAD_TARGET`。
  现在支持 collectiondetail 与新版 lists 链接，以及 `season:<mid>/<sid>`
- 合集拉取需要 **mid + season_id 两个参数**，只给 sid 接口会 404（实测）


## 0.8.1 — 2026-10-21

- 新增 VRChat 域（`astra vr ...`）：登录（含两步验证）、账号、好友、通知、世界、实例、群组、头像、收藏、余额
- 写操作（加/删好友、收藏、邀请、改状态、通知已读）统一走**预览 + 一次性令牌**二次确认
- 抽出 `core/confirm.ts` 作为通用的写操作确认机制，音乐域的红心也走同一套规矩
- 实测要点：VRChat 必须带 User-Agent（缺了被 Cloudflare 拦成 403）；`/health` 需要登录，探活改用 `/config`


## 0.8.0 — 2026-10-21

新增媒体处理域，并补齐 B 站三个能力。

- **`media` 新域**：`info`（读实际参数）、`audio`（抽音轨）、`cut`（裁剪）、`transcode`（转码/换容器）、`thumbnail`（截图）
- **铁律**：输出路径绝不能等于输入。抽音轨曾因扩展名推断错误 + `--overwrite` 把源视频截成 5 秒
- 同格式转码自动加 `.transcoded` 后缀，裁剪用 `.cut`
- `bili danmaku`：弹幕转 ASS（滚动、颜色、描边），默认只留滚动弹幕、按时间分摊避免刷屏
- `bili popular` / `bili weekly`：综合热门与每周必看
- ffmpeg 执行器抽到 `media/run.ts`，B 站与媒体处理共用


## 0.7.0 — 2026-10-21

- 任务体系抽到 `core/jobs.ts`，音乐与 B 站共用：各域只注册"一项怎么处理"，生命周期（起进程、并发、取消、恢复、通知）统一管
- B 站批量任务：`bili bulk`（收藏夹 / 合集 / 一个视频的全部 P），`bili job / jobs / job cancel / job resume`
- 修复重复判定只认 id 的问题：新增"标题 + 歌手 + 时长分桶"指纹，同一首歌换 id 出现时不再重下覆盖
- `music have --refresh` 顺带全量重算指纹
- 新配置 `bili.concurrency`（1..3，默认 1）
- 不支持按 UP 主主页批量：B 站投稿接口返回风控页


## 0.6.0 — 2026-10-21

- 新增红心 / 取消红心：`music liked --like <ref>` / `--unlike <ref>`
- **写操作必须二次确认**：第一次只返回预览和一次性令牌（5 分钟、单次有效），必须带 `--confirm <token>` 才真正执行。AI 没法一句话就把用户的歌单改了
- 已经是目标状态的歌自动跳过；下架歌如实报「下架歌曲无法收藏」
- 实测批量接口不可用（`trackIds` 数组返回 400），改为一首一首执行，单首失败不中断整批


## 0.5.0 — 2026-10-21

- 曲库记录母带规格：采样率 / 位深 / 声道，以及封面、歌词、逐字歌词是否齐全。老记录用 `music have --refresh` 回读文件补齐
- `music have` 显示规格与码率；`--low` 直接列出有损或低于 24bit 的歌（回答"哪些还能升级"）
- 统计按真实规格分组（`44.1k/16`、`96k/24`），不再只看档位名
- 新增订阅：`music subscribe add/list/set/remove/run`。定时盯歌单 / 专辑 / 歌手，出新歌自动下
- 订阅用**曲目集合差集**判断新歌（平台的上架时间不可靠）；第一次只记基线，不会把整个歌单重下一遍

新增第二个能力域：**B 站视频下载**。

- `bili get`：BV 号 / av 号 / 视频链接 / b23.tv 短链；多分 P 用 `--page 2,5-8` 指定，`--audio-only` 只取音频
- DASH 音视频分流下载后 ffmpeg 合并（`-c copy` 不重编码），自动在 baseUrl / backupUrl 间回退
- 下完用 ffprobe 核时长与流，报告实际分辨率与编码
- `bili login start / poll / account / logout`：扫码登录。**未登录画质封顶 360P**，登录后才可能到 1080P60 / 4K
- `bili info`（`--probe` 看实际可得画质）、`bili subtitle`（字幕转 srt）、`bili doctor`
- wbi 签名（`w_rid` + `wts`）
- 把路径模板抽到 `core/template.ts` 供音乐与视频共用；修掉"空变量残留 `01 .mp4`"的问题
- 修：入口文件判断原来只认固定文件名，产物改名后会静默不执行


## 0.4.0 — 2026-10-21

- 新增逐字歌词：网易云没有逐字（`klyric` 实测恒为空），改从酷狗取 KRC，解出后另存 `.word.lrc`（增强 LRC）
- KRC 解码：`krc1` 头 + 16 字节循环密钥 XOR + zlib。不是流传的"整体异或 0x64"，那种解不开
- **错位防护三道闸门**：搜索候选时长（±3s）→ krcs 候选时长（±3s）→ KRC 头 `[total:]`（±5s）。任何一道不过就放弃逐字、保留逐行，宁可没有也不给错的
- 修：搜索候选找不到时长匹配时原本会回退到第一条，等于绕过闸门 —— 改成直接放弃
- 新配置 `music.wordLyric`：`auto`（默认）/ `off`


## 0.3.1 — 2026-10-21

- 取最优：不再"拿到请求档位就收"。官方按 24bit → flac 的顺序问，音源也往最高档找，最后在所有路线里挑最好的（采样率 > 位深 > 码率 > 格式）
- 修：原来只看码率，会选到 44.1kHz 高码率而丢掉 96kHz/24bit 的版本
- 官方已经是 24bit 时直接收工，不再问音源


## 0.3.0 — 2026-10-21

- 新增官方取链通道：用登录账号向网易云要播放地址，排在洛雪音源之前。VIP 账号实测能直接拿到 24bit FLAC（3.2Mbps / 86MB）
- 下载结果里的 `source` 现在会显示 `official` / `qdy@wy` / `qdy@kw`，能看出是不是走了官方
- 官方不给地址不算失败：下架 / 地区限制时自动回落到音源，把理由写进 `attempts`
- 修：刚签发的官方地址立刻请求可能 403，加了退避重试


## 0.2.0 — 2026-10-21

- 新增网易云扫码登录：`music login start / poll / wait / account / logout`。二维码出 PNG 文件（自带编码器，零依赖），交给 Hermes 用 `MEDIA:` 发图
- 新增 `music playlists`（我的歌单，自建 + 收藏）、`music daily`（每日推荐，可 `--download` 直接开任务）、`music liked`（我喜欢的音乐 / `--check` 批量查红心）
- 所有网易云请求带上会话 cookie：私人歌单、日推这类账号内容现在可见
- 加密模块 `crypto.ts`（weapi / eapi），补了确定性测试

## 0.1.3 — 2026-10-21

- deploy/hermes 增加派生镜像 Dockerfile：官方镜像运行期装不了飞书 SDK，必须预装 lark-oapi
- 部署文档补上权限、PATH、白名单与换模型的坑

## 0.1.2 — 2026-10-21

- 部署方案改为 Hermes（飞书长连接）+ astra 同容器，模型走同机 WorkBuddy2API：`deploy/hermes/` 下给出 compose、Hermes 的 config.yaml 与两份 env 模板
- skill 声明 `ASTRA_HOME` / `ASTRA_MUSIC_DIR`，Hermes 过滤子进程环境变量时会放行

## 0.1.1 — 2026-10-21

- 修复：酷我同曲路线可能拿到另一首歌（实测 アイドル 的直链是 夜に駆ける）。拿到文件后核对自带标题与 FLAC 实际时长，对不上就放弃这条路线
- `job` 结果加上音质分布；成功项的提醒（音质降级等）改放 `note`，`error` 只在失败时出现
- 输出被管道提前关闭（`| head`）时不再抛 EPIPE 堆栈

## 0.1.0 — 2026-10-21

首版：音乐下载。

- `music get`：关键词 / 网易云链接 / 短链 / ref 一条命令下完；拿不准时返回候选（带翻唱 / Live / 伴奏等标记），不替用户选
- 同一首歌收录在多张专辑时优先原专辑，其余作为 `otherVersions` 返回
- 取直链：洛雪音源 × 网易云 / 酷我同曲两条路线 × 档位从高到低，每个地址实测格式与码率；`quality` 是实测值，没达到请求档位时 `downgraded: true`
- 下载后写标签（ID3v2.4 / FLAC Vorbis Comment）、1200px 封面、歌词（内嵌 + 双语 .lrc），写前写后校验音频字节不变
- 曲库去重：已下过的返回 `already_have`
- 专辑 / 歌单 / 歌手 / 多首：后台任务，`job` 查进度、`--wait` 等待、`cancel` / `resume`，中断可恢复
- `music source add/list/remove/enable/disable/test` 管理音源脚本
- 后台任务结束可推送到飞书群机器人 webhook
- `help` / `--help` 输出给 AI 读的命令说明；`doctor` 自检

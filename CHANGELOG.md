# Changelog

## 0.19.0 — 2026-10-29

**新增 `comic` 域：纯 TS 漫画下载（不依赖本机其它容器）**

- 命令：`comic get` / `info` / `search` / `doctor`
- 移动端 API：token、AES-256-ECB 解密、域名刷新、cookies、章节与图片 CDN
- 图片竖条解混淆用 ffmpeg（与 B 站共用），不引入 sharp 等原生依赖。裁切前先转 `rgb24` 并无损写出，避免 YUV 抽样在接缝留亮线
- 配置：`comic.dir` / `comic.template` / `comic.concurrency`；环境变量 `ASTRA_COMIC_DIR`
- Hermes skill：`skills/comic/SKILL.md`

## 0.19.1 — 2026-10-29

**pixiv：敏感作品按分级分流到独立目录（+ help 说明）**

- 新增 `pixiv.sensitive-dir`：配上之后，`xRestrict>0` 或 `sl>=4` 的作品落到该根目录，
  其余仍落 `pixiv.dir`。判定口径与「能不能发到普通群」完全一致，避免两套标准。
- `--out` 显式指定时优先，不再分流（用户已经指明了目的地）。
- 生效范围：`pull` / `user --pull` / `sub run` 三条下载路径。
- `astra help pixiv pull` 补上分流说明——0.19.0 之前功能藏起来了。
- 新增 `tests/pixiv-sensitive-dir.test.ts`（429 全过）。

## 0.18.11 — 2026-10-29

**pixiv rank 支持 R-18 日榜/周榜；顺手修 `original` 榜**

- 新增 `--mode daily_r18` / `--mode weekly_r18`。实测 pixiv 只有这两个 R-18 榜，
  `monthly_r18` / `male_r18` / `female_r18` / `rookie_r18` 在 `ranking.php` 上全是 404。
- R-18 榜**需要 cookie**：匿名请求直接 403。现在会给出可读提示，而不是原始 HTTP 错误。
- 修 `--mode original`：`content=illust` 会 404，必须 `content=all`。之前这个榜一直是坏的。

## 0.18.10 — 2026-10-29

**pixiv search / top 支持按 sl 等级筛选**

- `--sl 2` / `--sl 2,4` 精确选等级，`--min-sl` / `--max-sl` 取闭区间，可组合（交集）。
  等级：`2` 一般（匿名可见）/ `4` 轻度 / `6` 敏感。
- **为什么是本地过滤**：pixiv 搜索接口不接受 `sl` 参数（实测 `&sl=4` 被忽略，
  返回的 sl 集合不变）；唯一有效的服务端粗筛是 `mode=r18`（只出 sl=6）。
  好在搜索结果每条自带 `sl`，所以本地过滤不增加任何请求。
- `search` 带 `--sl` 时和 `--type` 一样会自动多翻几页凑够 `--limit`。
- `top` 的输出多了 `sl` / `xRestrict` 两个字段，表格也多一列。
- 新增 `tests/pixiv-sl-filter.test.ts`（6 例，424 全过）。

## 0.18.9 — 2026-10-29

**pixiv info 增加 `sl`（安全等级）**

- `sl` 决定作品能不能发到普通群：`2` 一般 / `4` 轻度 / `6` 有性表现。
  匿名访客连缩略图都拿不到 `sl>=4` 的作品（这是「匿名拿不到 urls」的真正原因）。
- 之前只有 `xRestrict`（R-18 开关），分不出 `sl=4` 和 `sl=6`，做内容分流时判断不了。

## 0.18.8 — 2026-10-29

**pixiv：R-18 放行改成配置项**

- 新增 `pixiv.r18`（默认 `false`）：设为 `true` 后 `pull` / `user --pull` / `sub run` / `top`
  都不再跳过 `xRestrict != 0` 的作品。命令行 `--r18` 仍然有效，两者取并集。
- 之前只有命令行开关，定时任务没法继承，等于每次都得在脚本里硬塞 `--r18`。

## 0.18.7 — 2026-10-29

**pixiv：带 cookie 时改走 curl 子进程（绕开 Cloudflare 指纹判定）**

- 根因：Cloudflare 按 TLS/HTTP 指纹认客户端。**同一个 cookie**，Node 的 undici 请求
  `www.pixiv.net` 回 403，`curl` 回 200（2026-10-28 实测，当天日报 50 张只下到 16 张、
  34 条 403 就是它造成的）。
- 新增 `pixiv.transport` 配置：`auto`（默认，有 cookie 用 curl、匿名用 fetch）/ `fetch` / `curl`。
- `curlArgs()` 纯函数 + `pickTransport()`；curl 走 `-sS --compressed`，UA / Referer / Cookie /
  `-x <proxy>` 由 `core/proxy.ts` 的 `shouldProxy()` 决定，与 fetch 通道同一套代理规则。
- 效果：astra 终于能带 cookie 干活——`sl=4`/`sl=6` 的作品（匿名拿不到 `urls.original`）现在能正常取。
  日报里那 14 个「astra 失败 → python 兜底」也可以省掉（兜底先留着当保险）。
- 新增 `tests/pixiv-curl-transport.test.ts`（5 例，418 全过）。

## 0.18.6 — 2026-10-28

**bili 新增两条命令：`dyn`（图文动态）与 `album`（相簿）**

- 之前 `bili` 只能拿视频（get / info / space / collection / bulk / audio / subscribe），
  图文动态和官方海报拿不到。补两条：
  - `astra bili dyn <UP|mid:xxx> [--limit 20] [--images] [--out 目录]`
  - `astra bili album <UP|mid:xxx> [--limit 40] [--images] [--out 目录]`
- **两个接口的可靠性差一个量级，所以拆成两条命令**：
  - 相簿 `/x/dynamic/feed/draw/doc_list`：免签名免登录，实测无风控，给**完整图集**
    （官方号实测 1920×1080、1080×2853 竖版海报）。
  - 动态 `/x/polymer/web-dynamic/v1/opus/feed/space`：要 `buvid3/buvid4` + wbi 签名，
    给**正文 + 一张封面图**，**不返回发布时间**（`pub_time` 恒空，`opus/detail` 又被 -352 挡），
    所以 `date` 为 null、存图名是 `undated_<opusId>_<n>`。
- **踩到的坑（值得记）**：网页版动态接口 `/x/polymer/web-dynamic/v1/feed/space`
  在 Node 的 fetch 下**恒返回 `code:0` + 空 items**，同样参数用 Python 请求能拿到 12 条 ——
  按客户端指纹做的软拦截。加 `origin` / `accept-language` 不但没用，反而升级成 `-412`。
  换 `opus/feed/space` 后 Node 下一次 20 条正常。所以命令走 opus 入口。
- 频率风控的另一半：取完 wbi key 立刻请求会被挡，隔 1.5 秒以上才稳；每次重试换新 buvid + wbi key。
- `--images` 落盘 `<前缀><日期|undated>_<id>_<序号>.<ext>`，< 20KB 的图标自动跳过。
- 无新增测试（纯网络 IO）；`npm test` 413 个全过，typecheck 干净。

## 0.18.5 — 2026-10-27

**bili 音频：标题里没有《》时，TIT2 用干净的文件名**

- 0.18.4 只处理了「歌名 + 版本标记」的撞名。另一类没管：B 站标题里**根本没有《书名号》**时，
  `songTitleOf()` 只能退回整条标题，于是播放器里显示成
  `【补档】东雪莲の兔子洞（全年龄版）/AI東 雪蓮`、`「カサネテク」（千层套路）/AI東 雪蓮`
  这种带 UP 名后缀、装饰引号的原始标题（实测 28 个）。
- `tagTitleFor()` 增加第一条规则：**文件名比歌名更短就用文件名**。落盘时的文件名本来就是干净的
  （`东雪莲の兔子洞（全年龄版）`），比整条标题短得多；文件名更长时（87 字那种）仍然保持歌名。
- 新增 2 个测试（413 全过）。

## 0.18.4 — 2026-10-27

**bili 音频：TIT2 撞名时带上版本标记**

- 根因：`songTitleOf()` 取标题里最后一个《》，把版本标记丢了。库里实测 **19 组 / 39 个文件
  「不同 bvid、同名 TIT2」**（`清姬` vs `清姬（DJ）`、`苦茶子` vs `苦茶子（日语填词）`…），
  播放器里显示成两条一模一样的记录，看着像重复下载。
- 新增 `tagTitleFor()`：文件名以歌名开头、后面只跟 ≤14 字的括号修饰时，TIT2 用文件名；
  否则保持歌名。用户手工削过的短名（不以歌名开头）不受影响。
- 新增 `tests/bili-tag-title.test.ts`（6 例）。

## 0.18.3 — 2026-10-27

**bili 视频：把溯源标签写进容器（对齐音频侧）**

- **视频侧以前一条标签都不写**（只有 B 站原片里的 `Packed by Bilibili XCoder`），
  认文件只能靠文件名 —— 改一次 `bili.video-template` 就全对不上，跟音频 0.18.2 修的
  「整批重下」是同一个病。现在 `mux` 里顺带写：`title` / `artist`(UP 主) / `album`(视频标题) /
  `date`(投稿日) / `comment`(视频链接) + `SOURCE` / `SOURCE_ID` / `BILIBILI_BVID` / `BILIBILI_URL`，
  键名与音频完全一致，日后按 bvid 判重/去重可以直接复用。
- **`-movflags +use_metadata_tags` 是必须的**：mp4 muxer 默认只认白名单键
  （title/artist/album/date…），`BILIBILI_BVID` 这种自定义键会被**静默丢掉** ——
  第一次实现就是这样，ffprobe 只剩 5 个标准键，加上这个 flag 才写进 `mdta`。
- **`-map_metadata -1` 先清空输入元数据**：否则 B 站那句 junk description 会被带过来，
  还会把 `major_brand` / `compatible_brands` 复制成重复的 mdta 条目
  （实测出现 `isomiso2avc1mp41;isomiso2avc1mp41iso5`）。
- 多 P 时 `title` 用分 P 名、`album` 用视频标题；分 P 名为空退回视频标题。
- 新增 `tests/bili-video-metadata.test.ts`（4 例）。实测：`bili get BV19K421a7kx` →
  ffprobe 拿到全部 10 个键，156s / h264+aac / 45MB，抽帧解码正常。

## 0.18.2 — 2026-10-27

**bili audio：按 BVID 判重，改模板不再整批重下**

- **`bili audio` 判重从「目标路径」改成「BVID」**：以前只认模板算出来的那个路径，
  用户改一次 `bili.audio-template` 老文件就全对不上，整批重下一遍。
  实测 `season:1049571`：408 个文件里 **200 个是同 BVID 重复（49%）**，码率还退化了
  （旧的 180kbps 与新下的 320kbps 并存）。现在落盘前按目录内音频标签的
  `BILIBILI_BVID` / `SOURCE_ID` 建一次索引（懒加载、只读头 512KB + 尾 128KB），
  命中即 `skipped` 并回 `existingPath`。同一合集连跑第二次实测 `downloaded: 0 / skipped: 202`
- **`ownerBvidOf` 认 `BILIBILI_BVID`**：之前只匹配 `SOURCE_ID`，而音频标签两个都写；
  只写 `BILIBILI_BVID` 的文件会被当成「别人的」，于是走消歧分支再存一份 —— 这是重复的直接来源
- **`{title}` 里的 `/` 已由 `sanitizeSegment` 处理**（本次复核确认，无需改动）：
  `打火机（…《打火机》/AI東 雪蓮` → `…《打火机》_AI東 雪蓮`。历史目录里残留的伪子目录
  是旧构建留下的，用 `fix_bili_dir.py` 迁回即可

## 0.18.1 — 2026-10-26

**pixiv：提速 + 「静默空结果」防护**

- **`pixiv top` 收藏数并发 12 → 24**：同一命令（`--pages 2`）实测 11.7s → 3.6–6.5s。
  实测 **48 会翻车**：突发之后 pixiv 返回 HTTP 200 + 空结果（`total:0`），看起来像「这个词没有作品」
- **防护静默空结果**：带 cookie 搜索全空时，自动去掉 cookie 再搜一轮；命中就返回匿名结果并标
  `cookieStale: true`。`userWorks` 同样处理（否则订阅会永远「没有新作品」，一声不响）
- **新增 `pixiv cookie check`**：用固定关键词分别带/不带 cookie 各搜一次，
  带 cookie 0 条而匿名有条 → cookie 失效；两边都是 0 → 判不了（网络/限流），不误报
- **`pixiv user --pull` 支持 `--quality regular`**：之前只有 `pixiv pull` 有，批量下原图一张 138s，
  20 张能跑 7 分钟还超时
- **`pixiv search` / `pixiv top` 输出加 `cookieStale`**

### 慢在哪（实测数据，留档）

| 环节 | 耗时 |
|---|---|
| 进程启动 | 0.18s |
| 单个 pixiv ajax 请求（走 mihomo 代理） | 0.38s（TLS 0.15 + TTFB 0.31） |
| `pixiv search`（1 次请求） | 1.1s |
| `pixiv top --pages 1`（60 候选 → 60 次详情） | 3.5s（batch=12）→ 1.8s（batch=24） |
| `pixiv pull` 原图 4000×6000 | 138s/张 |
| `pixiv pull --quality regular` | 20s/张 |

结论：慢的不是 CLI 本身，是 **`top` 的请求数 = 页数 × 60**（每个作品要单独查 `bookmarkCount`）
和 **原图下载**。前者靠并发（已到 24，再高触发限流），后者只能靠 `--quality regular`。

## 0.18.0 — 2026-10-26

**`pixiv search`：查不到自动放宽 tag 匹配 + `--type` 分类 + `relatedTags`**

- **新增回退**：精确 tag → 部分 tag（`s_tag`）→ 标题/说明（`s_tc`）→ 按 `・`/空格/斜杠拆词逐个查。
  返回里带 `matchedBy`（`tag` / `tag_partial` / `caption` / `token`）和 `matchedKeyword`，
  放宽了会明说，不静默
- **为什么需要**：pixiv 的 tag 是全词精确匹配，而角色 tag 经常不是角色全名。
  实测 `カエサル・キング`（绝区零凯撒的全名）**total=0**，真实 tag 是 `キング・シーザー`/`CaesarKing`，
  搜 `绝区零 凯撒` 有 44 条。以前这种情况只会返回空列表，不报错也不提示
- **新增 `--type all|illust|manga|ugoira`**（`search` 和 `top` 都支持）：**本地过滤**。
  pixiv ajax 的 `type` 参数实测被忽略 —— `type=illust` 和 `type=manga` 返回完全相同的数据
  （同一批 id，illustType 同时包含 0 和 1），所以只能按结果里的 `illustType` 自己筛
- **新增 `relatedTags`**：pixiv 返回的真实标签列表，找别名/同义词看这里
- **`pixiv top`** 同样走回退，且第一页解析出「真正命中的词 + 匹配模式」后，后续翻页沿用同一组，
  不会翻到第 3 页因为换回精确 tag 而断流
- **翻页不做分词回退**：`--page 2` 之后只试原词的三种匹配模式，避免换词导致页数语义错乱

## 0.17.0 — 2026-10-26

**`pixiv top`：按收藏数看热门（绕开会员的「人気順」）**

- **新增**：`pixiv top <关键词> [--pages 3] [--limit 20] [--r18]` ——
  先拉最近 N 页新作（每页 60），再逐个取 `bookmarkCount`，本地倒序输出
- **为什么这么做**：Pixiv 搜索的 `order=popular_d`（人気順）是会员功能，
  非会员调用**不会报错**，而是静默忽略、返回的仍是新着順 —— 实测 `popular_d` 与 `date_d`
  返回完全相同的 60 条。所以改成「本地按收藏数排序」，不需要会员
- **限制**：候选池仍是最近的作品（与 search 共用），老作品收藏再高也不会出现
- **`pixiv info` 增加 `bookmarks`** 字段（一次额外详情请求）

## 0.16.2 — 2026-10-26

**`pixiv pull --quality regular`：直接取 1200px**

- **新增**：`--quality regular` 直接下 1200px 版本，不再先试原图。
  实测同一个 4000×6000 作品：原图 138s → 1200px 20s。原图（默认 `original`）行为不变
- **用途**：日报、预览、缩略图这类根本用不上原图的场景

## 0.16.1 — 2026-10-26

**`pixiv pull --pages N`：多页作品只下前 N 页**

- **新增**：`pull` / `user --pull` 支持 `--pages N`，`--pages 1` 只取首图。
  日报场景实测：某个 10 页作品单独要 3 分钟，限 1 页后 17 秒
- **重构**：`pull` 命令改走 `pullWorks()`，与 `user --pull` / `sub run` 完全同一条路径

## 0.16.0 — 2026-10-26

**Pixiv：画师批量下载 + 订阅追新**

- **新增**：`pixiv user <userId> --pull` —— 直接把这个画师的作品批量下下来（`--limit/--out/--r18/--dry`）
- **新增**：`pixiv sub add <userId>` / `sub remove` / `sub list` / `sub run` ——
  订阅表存 `<ASTRA_HOME>/pixiv-subs.json`（600），只记 userId、画师名、已见过的最大作品 id
- **订阅只拉新的**：加入时把当前最新 id 记成基线，`sub run` 只处理 id 更大的作品，
  重复跑不会重复下载，没新作品时 `newWorks: 0`
- **重构**：`pull` / `user --pull` / `sub run` 共用同一套下载逻辑，行为（R-18 跳过、原图回落 1200px、
  已存在跳过、按 `<userId>/<illustId>_p<N>` 落盘）保持一致

## 0.14.0 — 2026-10-26

**新增 `astra model`：模型资产下载（Civitai / HuggingFace / 直链）**

- **新增**：`model find <关键词> [--type Checkpoint|LORA] [--limit] [--period]` —— 搜 Civitai，按下载量排序
- **新增**：`model info <modelId>` —— 版本、文件名、大小、现成的 pull 命令
- **新增**：`model pull <civitai:版本id | hf:org/repo/文件 | https://…> --out 目录 [--threads N]` ——
  分片并行下载、边下边写盘（不把大文件攒在内存里）、可续传、sha256 校验
- **新增**：`model token set/show/clear` —— Civitai token 存 `<ASTRA_HOME>/civitai.json`（600），
  只回显前后各 4 位；环境变量 `CIVITAI_TOKEN` 优先
- **为什么单独一个域**：模型目录因整合包而异，写死路径只会错，所以落点由 `--out` 指定，CLI 只管「找到 → 拉下来」

## 0.15.0 — 2026-10-26

**新增 `astra pixiv`：Pixiv 查询 + 单作品下载（走 web/ajax，不依赖 refresh-token）**

- **新增**：`pixiv info <illustId>` —— 作者、页数、尺寸、标签、是否 R-18。只读
- **新增**：`pixiv rank [--mode daily|weekly|monthly|rookie|original|male|female] [--pages N]` —— 排行榜 id 列表
- **新增**：`pixiv user <userId> [--limit N]` —— 画师作品 id 列表（插画 + 漫画，新的在前）
- **新增**：`pixiv search <关键词> [--page N]` —— 按时间倒序搜作品
- **新增**：`pixiv pull <illustId> [--out 目录] [--r18] [--dry]` —— 下载单作品全部页。
  落盘 `<目录>/<userId>/<illustId>_p<N>.<ext>`（只存不可变标识，不建系列目录）；
  原图优先、失败回落 1200px；已存在跳过；R-18 默认跳过
- **新增**：`pixiv cookie set/show/clear` —— cookie 可选，只在看登录可见内容时需要；
  存 `<ASTRA_HOME>/pixiv-cookie.txt`（600），只回显有没有 `PHPSESSID`
- **新增配置**：`pixiv.dir`（留空则 `pull` 必须给 `--out`，不瞎写默认路径）
- **为什么走 ajax 而不是 App API**：App API 要 refresh-token，30 秒窗口的 OAuth 在聊天里基本拿不到；
  web/ajax 匿名就能查作品/画师/排行/搜索，原图在 `i.pximg.net` 上带 `Referer` 即可直下（2026-10 实测）
- **注意（部署）**：容器直连 pixiv.net 超时，需要把 `pixiv.net,pximg.net` 加进 `proxy.include`
- **修（多页）**：换页号要匹配 `_p<N>` 后跟 `.` 或 `_`，否则 `_p0_master1200.jpg` 这类 1200px 地址换不掉
  （单测覆盖，没修的话多页作品每一页都会下成 p0）

## 0.13.0 — 2026-10-23

**原生挂时长：`astra steam login` + `astra steam idle`，不再依赖 ASF 容器**

- **新增**：`steam login` 扫码登录（steam-session，SteamClient 平台）。二维码 PNG 落到
  `<ASTRA_HOME>/steam-qr.png` 并返回路径 + 原始 URL；命令只等二维码生成就返回，
  扫码结果用 `steam login status` 跟。只存 refreshToken（600），**不存密码**。
  二维码默认 10 分钟有效（`--timeout` 可调），登录成功时顺手把 SteamID64 存下来
- **新增**：`steam login --user <账号> --password-stdin` —— 账号密码登录的兜底路径。
  密码从**终端**读（不回显、不进 argv、不进 shell 历史、不落盘），需要 Steam Guard 时
  同一窗口按提示输验证码；成功后同样只存 refreshToken
- **新增**：`steam idle start <游戏...>` 起一个分离进程常驻，登录 CM → 在线 →
  `gamesPlayed([appid])`，掉线 `autoRelogin` 自动重连并记 `reconnects`。
  命令会等「真的上线」再返回（`--wait`，默认 30s）。`steam idle status` 读状态文件
  （进程没了但状态还是 online → 报 `interrupted`），`steam idle stop` SIGTERM 收尾
- **新增**：`steam library`（GetOwnedGames）按名字解析 AppID；纯数字当 AppID 直接挂；
  名字匹配到多个**报错并列候选**，不猜。单账号最多 32 个游戏（Steam 限制）
- **改（构建）**：单文件 bundle 现在能吃下 `steam-user`。它留了两个坑，都在 `scripts/build.mjs` 里处理：
  ① `@doctormckay/stdlib` 在函数体里动态 `require('crypto')` → ESM 产物没有 require，
  banner 里用 `createRequire` 补一个；② `@doctormckay/steam-crypto` 按 `__dirname` 读
  `system.pem` → 用 esbuild 插件把这个 pem 内联成字符串。产物 8.6 MB，仍是单文件
- **说明**：挂时长是**客户端会话**，同一账号在别处登录会把这边踢掉（ASF 也一样），
  所以和 ASF 不能同时用；ASF 容器已停，配置保留，`docker start asf` 可随时回来
- **不做**：挂卡（ASF 的核心逻辑，本轮明确不做）

## 0.12.25 — 2026-10-23

**修并发迁移炸库（`duplicate column name`），并让代理配置可临时覆盖**

- **修（严重，会直接失败）**：两个 astra 进程同时在一个新库上启动时，第二个必炸
  `INTERNAL: duplicate column name: channels`。实测 `music get album:… & bili get … &`
  并行就复现。根因是版本号在事务**外**读：两边都读到旧版本，第二个拿到写锁后照样执行
  同一条 `alter table … add column`。现在整个迁移序列放进一个 `begin immediate`，
  并在拿到写锁后**重读** `user_version`，第二个进程直接跳过。
  新增 `tests/db-migrate-concurrent.test.ts`（4 个进程同时迁移），拿掉修复即红
- **修**：`proxy.include` / `proxy.exclude` 支持环境变量覆盖
  （`ASTRA_PROXY_INCLUDE` / `ASTRA_PROXY_EXCLUDE`）。原先只能读配置，
  机器上配了 include（例如只让 steam 走代理）时，代理相关用例会永远绿不了 ——
  `tests/proxy-transport.test.ts` 现在显式清空这两个变量，用例不再依赖本机配置

## 0.12.24 — 2026-10-22

**文件不可变：默认永不移动已落盘的文件**

- **改（P4#6 最终形态）**：0.12.23 仍会在"精选→原专辑"时删旧文件。现在**默认一律不移动** ——
  只有显式 `music get <专辑> --reassign` 才归位。理由：`tracks.file_path` 是**事实**不是缓存，
  用户可能已按它整理、备份、建过播放列表；为一个推测出来的偏好去改，是在拿他的数据赌
- 重复曲目一律 `skipped` 并返回 `duplicateOf: { album, albumYear, path, reassignable }` ——
  调用方能据此解释"这张专辑为什么少一首"，而不是以为下载失败了
- **修（严重）**：`album_year` 存成了 `55399` 这种离谱值 —— `track.publishTime` 是**秒**、
  `album.publishTime` 是**毫秒**，混着用还都乘 1000。年份正是判归属第一判据，错了就全错
- **修**：`albumTypeRank` 只认 `录音室版` / `精选集` 这些**想象的标签**。实测网易云
  `type` 几乎永远是 `"专辑"`（`沈香学(2023)` 和 `2026 Special Edition(2026)` 都是），
  判据实际只能靠年份。改为认得 `专辑`，并把年份提为主要判据
- 端到端验证：下完精选集后原专辑仍是 13 首、`残機` 仍在 `沈香学/` 下

## 0.12.23 — 2026-10-22

**修归位时的真丢歌（P4#6），统一 job_started 结构（P4#7）**

- **修（严重，0.12.22 的回归）**：归位时**先删旧文件再下载新的**。中间任何失败
  （网络断、磁盘满、Ctrl-C）都会让文件真的没了 —— 实测丢了 2 首，只能重下整张专辑补回。
  现在改成**先下好、确认落盘、再清理旧位置**；清理失败只给 warning，不影响结果
- **收紧归位方向**：只允许"精选/合辑/现场 → 录音室原专辑"这一个方向动文件。
  反方向（把原专辑的歌搬进精选集）会把用户整理好的目录打乱，
  实测调用方从目录看到"新专辑里有、旧专辑没了"，误判成重复副本删掉，原文件彻底丢失
- 判据要求"两端信息都在"才动：年份缺失、类型未知、同年 → 一律不动。
  在不确定时搬别人的文件，代价远大于"这首歌暂时待在精选集里"
- 库里新增 `album_type`，判"是不是二手专辑"才有依据（只看年份不够：
  同年出的重混版不该把原版挤走）
- **修（P4#7）**：`music subscribe add` / `bili subscribe run` 的返回补上
  `data.job.id`（与其它起任务的命令一致），旧字段 `jobId` 保留
- help 的 conventions 写清：起任务的命令统一看 `data.job.id`，
  等待用 `astra job <id> --wait <秒>`

## 0.12.22 — 2026-10-22

**同曲多专辑按固定优先级归属，不再由下载顺序决定（P4#5）**

- **修（P4#5）**：并行下 Michael Jackson 的 5 张专辑时，全局去重让**先下完的那张**占住重复曲目。
  结果 HIStory(1995 精选集) 抢到了 Billie Jean / Man In the Mirror，
  Thriller(1982) / Bad(1987) 把这几首判成 skipped —— 播放器里点开 Thriller
  缺了最招牌的歌，用户看到的是"专辑不完整"，不是"重复被去掉了"
- 现在按**与下载顺序无关**的固定优先级归属：发行年份最早 → 录音室 > EP > 未知 >
  精选/合辑/现场/原声 > Remix → tracknumber 靠前
- 已有那份属于"更差的专辑"时，这一轮会把它**搬**到原专辑（删旧记录与文件后重下），
  并记 `music.reassign` 进度事件
- 分不出来时**保持现状**（不因顺序翻转）—— 这是保证"与顺序无关"的底线，
  有专门的对称性测试钉住
- 库里新增 `album_id` / `album_year`，判归属不用每次再查专辑接口
- 专辑类型（`录音室版` / `精选集`…）网易云接口一直有，之前没解析
- **修（4f）**：doctor 的 audio-template 示例写成 `示例分P`，会让人以为音频模板里有
  `{part}`。改用带《》的示例标题，音频那条展开成 `示例歌名`；视频模板给两个分 P，
  `{part}` 才看得出效果

## 0.12.21 — 2026-10-22

**入口层体验（P3 4a–4e）：`astra bili --help` 不再报未知命令**

- **修（4a）**：`astra bili` / `astra bili --help` / `astra bili -h` 三者都等价于
  `astra help bili`。之前只有 `astra help bili` 能用 —— 那个写法没人猜得到，
  清单说是"唯一真正卡住使用者的地方"。未知子命令（`astra bili foo`）的 hint
  也改为提示该组子命令，不再是全局顶层清单
- **新增（4b）**：`bili.video-template` 作为正式名，`bili.template` 保留为别名，
  读写互通（写老名会同时写新名，老版本 astra 回退时不丢配置）
- **新增（4c）**：`doctor` 增加 `bili.paths` —— 把两套模板**展开成示例路径**。
  之前改完 `bili.audio-dir` / `--to bili` 只能真下一个文件才知道落点对不对，
  `--to bili` 用错模板那次就是这么漏过去的
- **新增（4d）**：`astra help bili` 里加分流说明（单条 get / 一批 bulk / 整个 UP 用 audio）
- **新增（4e）**：`--table` 给人看的表格视图，作用于 `jobs` / `music have` /
  `music subscribe list` / `bili subscribe list` / `bili audio`。
  **默认仍是 JSON，且 `table` 不进 `data`** —— 不加开关时输出与以前完全一致
- 表格按**字符显示宽度**排版（中文占两格）；分隔线用 ASCII `-`，
  用 `─` 的话按列宽重复会变成两倍宽

## 0.12.20 — 2026-10-22

**修伴生文件命名：替换扩展名，不是追加**

- **修**：产出的是 `暗香.mp3.jpg` / `暗香.mp3.Metadata.nfo`，而 Emby / Jellyfin / Kodi
  的规则是 `<stem>.<ext>`（同目录同名、不同扩展名）—— `暗香.mp3.jpg` 不会被当成
  `暗香.mp3` 的封面，是个孤儿文件，刮削器根本不看。现在产出 `暗香.jpg` / `暗香.Metadata.nfo`
- 这条错在我：代码和注释都写着"扩展名追加，不是替换"，**注释写得太肯定，反而掩盖了错误**。
  实测被 Hermes 抓出来
- 测试：新增隔离 —— 有几个用例会调 `setConfig`，之前没设 `ASTRA_HOME`
  会写进真实的 `~/.astra/config.json`，污染过一次（`bili.audio-dir` 被写成 `/m/bili-audio`，
  之后所有落盘断言全挂）
- `bili audio` 的并发参数保持默认 4 不变：实测 20 首 4分58秒（15s/首），
  比串行 9.4s/首还慢 —— 瓶颈是单文件带宽（0.6MB/s），不是并发度。
  这条不是缺陷，加并发解决不了

## 0.12.19 — 2026-10-22

**新增 `bili audio` 批量转音乐库；`bili.audio-dir`；专辑名可指定**

- **新增 `bili audio <mid|合集|season:...>`**：一条命令把一个 UP 整体转成音乐库。
  之前是外部循环调 `bili get`，还得临时改 `ASTRA_MUSIC_DIR`、事后数文件对账、写补下脚本
- 先报数再下载：`投稿 322 / 排除 3 / 待下 319`；`--dry` 只看计划
- **增量**：已存在（同 bvid）跳过 —— 连跑两次第二次 `downloaded: 0, skipped: N`
- 返回 `downloaded / skipped / failed / renamed / missing`，能直接对账
- `--exclude <正则>` 过滤非内容投稿；**正则写错会抛错**，不会静默排除全部
- **新增 `bili.audio-dir`**：B 站音频独立根目录，留空则同 `ASTRA_MUSIC_DIR`
- **修**：`--to bili` 套的是视频模板（`{title}/{page:02}`），音频被塞进子目录。
  模板与根目录是两件事，现在音频一律用 `bili.audio-template`
- **修**：`--sidecar` 对 `--audio-only` 无效。显式要了就生成，不替用户判断"音频不需要"
- **新增 `--album` / 订阅的 `--audio-album`**：指定 TALB。默认仍是 UP 名
- `bili get --concurrency`：多分 P 时并行（单 P 无收益，仍走直路）

## 0.12.18 — 2026-10-22

**修批量下载同名文件静默覆盖（P0#2e）—— 322 首丢 39 首**

- **修（严重）**：落盘前不检查目标路径是否已存在，`rename` 直接覆盖。
  `{title}` 抽出来的歌名会重复（水星记 ×4、原神 ×6…），
  实测 319 首只落地 280 首，**丢了 39 首**，而且 `failed: 0`、没有任何警告
- 现在同名时自动消歧，优先级：分 P 名 `（纯享版）` → bvid `（BV1xxx）` → 序号 `（2）`。
  **同一个 bvid 重复下载不算冲突**，覆盖自己是预期行为
- 返回里加 `renamed: [{ bvid, page, from, to }]`，并给一句 warning；
  单个文件的 `renamedFrom` 也在 `results` 里
- 判断"这个文件是谁的"：先看文件名里的 `（BVxxx）`，再看标签里的 `SOURCE_ID`
  （两者都是我们写进去的明文）。**都读不出就当别人的** —— 多留一个带后缀的文件
  只是丑，覆盖掉别人的文件是丢数据
- 新增 8 条测试，两个方向都验过"撤掉会变红"

## 0.12.17 — 2026-10-22

**修 `--rescan-pages` 触发全量重下；B 站音频专用模板；TIT2 取歌名**

- **修（严重，0.12.16 的回归）**：`--rescan-pages` 会清空该订阅的全部分 P 记录，
  而 0.12.16 把"无记录"当成"一页都没下过" —— 于是 201 个视频全被判未下载，
  触发 **209 项全量重下**（实测跑掉 311MB 后被取消）。一个几百 GB 的合集可能直接打满磁盘
- 现在 `--rescan-pages` 移到 `run` 上，语义改成**只读核对**：拿历史下载记录
  （`job_items` 里 status 为 downloaded/skipped 的项）当判据，**只补缺的分 P**。
  实测线上 `BV1GEn26uEDT` 的历史只有 `#1`，核对后只排出 P2 一项
- 为什么判据用历史记录而不是磁盘：路径取决于**下载当时**的模板配置。
  模板改过一次（`{uploader}/{title}/` → `Bilibili/{uploader}/`），
  按现模板算老文件位置全对不上，核对就变成"全都没下" → 又回到全量重下
- **新增** `bili.audio-template`：B 站音频专用落盘模板。留空仍用 `music.template`。
  `music.template` 把视频标题当专辑名，于是一个视频一个目录 —— 订阅一开就是 201 个子目录
- **修（P0#2c）**：音频的 `TIT2` 原来取分 P 名（「绿色」），而歌名在视频标题的《》里。
  改为取**最后一个《》**的内容（前面常是副标题），没有《》时退回分 P 名
- 新增 6 条测试，三条核心防线验过"撤掉会变红"

## 0.12.16 — 2026-10-22

**修 `--rescan-pages` 补不回存量分 P（P0#1b）**

- **修**：0.12.15 的"分 P 求差"有两个洞，合起来让存量视频永远补不齐：
  1. `run` 只给"`seen_pages` 里已有记录的" bvid 查分 P —— 而 `--rescan-pages`
     做的正是清空记录，于是清空后**一个都不查**
  2. `planPages` 把"记录缺失"当成"已下全部"，于是查到空 pages 就直接跳过
- 改成 **A 方案：差集严格按「视频 × 分 P」算** —— `seenPages[bvid]` 里没有某个 P 就下它。
  没有特殊路径，`--rescan-pages` 退化为"清空记录"的辅助命令（下次 run 自然全部重算）
- `run` 现在对合集里**每个** bvid 都查分 P（201 个视频几次请求，几秒钟）。
  这个代价换掉的是"漏内容且永远补不上"
- 顺带解决：手动删掉某个分 P 后，订阅会自己补回来
- 用 NAS 上的真实数据库 + 真实 API 验过：`BV1GEn26uEDT`（P1 绿色 / P2 纯享版）
  现在算出 2 个任务，而线上它的 `seen_pages` 确实是空数组 `[]`

## 0.12.15 — 2026-10-22

**订阅能下全部分 P、能只下音频；视频可生成 nfo / 封面 / 弹幕**

- **修（P0）**：订阅只下第 1 个分 P。实测 `BV1GEn26uEDT`（P1「绿色」+ P2「纯享版」）
  任务成功、`failed: 0`，但只落了 P1。现在默认下**全部分 P**（`--pages all`），
  只想要 P1 用 `--pages first`，此时返回里给 `partial: true`
- **修（P0，更根本的）**：基线只记 bvid，所以"视频后来补了一个分 P"永远发现不了 ——
  `BV1GEn26uEDT` 已经在基线里，光改默认值它的 P2 也补不上。
  基线升到 **bvid + 已下分 P 集合**（`seen_pages`），任何一次运行都能发现缺的 P；
  存量数据用 `bili subscribe run --rescan-pages` 重新核对
- **新增（P0）**：订阅支持 `--audio-only`。音频落**音乐库**
  （`ASTRA_MUSIC_DIR` + `music.template`），带完整标签
- **改**：`bili get --audio-only` 也**默认落音乐库**（原先落 `bili.dir`）。
  同一批音频不该有两套命名规则；要按视频模板归档用 `--to bili`
- **新增（P2）**：`bili.sidecar` 配置（`nfo` / `cover` / `danmaku` / `all`，默认空），
  或命令行 `--sidecar`。生成 `.Metadata.nfo` / `.jpg` / `.Danmaku.ass`，
  Emby / Jellyfin 自动刮削。命名是**扩展名追加**（`a.mp4` → `a.mp4.Metadata.nfo`），
  替换扩展名播放器就认不出是同一条
- `bili get` 多 P 只下一部分时返回 `partial: true` —— 光靠 warnings 会被忽略，
  订阅漏 P 就是这么来的
- 新增 16 条测试，核心两条验证过"撤掉修复会变红"

## 0.12.14 — 2026-10-22

**`--json` 真正可用；歧义时给结构化候选**

- **修（我上一轮的误判）**：0.12.11 我把 `music lyric` 的 `--json` 改名成 `--with-text`，
  理由是"`--json` 是全局标志、入口会剥掉它"。改名能绕过问题，但**没解决根因** ——
  `main.ts` 无条件剥掉 `--json`，导致任何命令都不能用这个名字。现在入口改为
  "命令自己声明了 `--json` 就补回去"（`restoreCommandFlags`），命令名恢复成 `--json`
- 返回键名对齐契约：`data.lrc` / `data.word`（原先是 `data.lyrics.line` / `data.lyrics.word`）
- **`LYRIC_AMBIGUOUS` 带 `details.candidates`**：排好序的候选数组
  （`ref` / `title` / `artists` / `durationMs` / `durationDeltaMs`），
  调用方直接取第一个重试即可，不必解析错误文案
- **修**：`music subscribe list` 新增 `qualityResolved` —— 实际会用的档位。
  `quality` 仍是原始的 null（"没指定过"本身是信息），脚本不用自己去读 config
- 测试：`restoreCommandFlags` 抽成纯函数并有测试；`--json` 那条验过"撤掉修复会变红"

## 0.12.13 — 2026-10-22

**`music covers` 改成以目录为准 —— 曲库没收录的专辑不再静默漏掉**

- **修（P2#13 根因）**：原来遍历 `allTracks()`，曲库没收录的专辑（手动放进去的、
  下载后没入库的、记录被 `forget` 掉的）**根本不在遍历范围里**。表现是
  `written: 118, failed: []` 看着全部成功，实际少一张，失败列表还是空的。
  现在先扫音乐根目录找出所有装音频的目录，再逐个处理
- 新增 `dirs`（扫到多少专辑目录）与 `hasCover`（跑完确实有 cover.jpg 的目录数）。
  恒等式 `dirs == hasCover + missing.length` 有测试钉住
- 新增 `--verify`：只自检不写，列出所有缺 cover.jpg 的目录
- 新增 `--dir <路径>`：只处理某个目录
- 判据改成"cover.jpg 在不在"，而不是"曲库记录 + 内嵌封面能不能读到"
- 上一版（0.12.12）的两处修复保留：一目录多首歌挨个试、同名专辑多目录

## 0.12.12 — 2026-10-22

**`music covers` 补上漏覆盖检测，并修两处会静默漏掉封面的逻辑**

- **新增 `missing`**：跑完之后**仍然没有 cover.jpg 的专辑目录**清单（带原因）。
  和原有的 `failed` 分工不同 —— `failed` 说"这一张为什么没写成"，
  `missing` 说"库里还有哪些目录是空封面"。后者才是脚本要用的判据
- **修**：一个目录里有多首歌时，原先只试**第一首**。第一首恰好没有内嵌封面
  （纯音乐 / 翻唱）就会误报"这目录没封面"，而后面那首其实有。现在挨个试到抠出来为止
- **修**：原先按"目录已处理过"跳过，而 `allTracks()` 是 `order by created_at desc`，
  同一专辑散在多个目录（合作曲按主歌手归目录后）时行为取决于注册顺序。改成按目录分组
- `music covers` 的 warnings 现在会区分"数据里就没有封面"和
  "有内嵌封面却没写出来" —— 后者是真正的 bug，值得单独提示
- **B 站音频的发行年份**：`pubdate` 本来就写成 `TDRC` / `DATE`，
  但视频没给发布日期时是**静默不写**。现在会进 warnings 说明，免得以为是 astra 漏了
- 新增 6 条测试，都验证过"撤掉修复会变红"

## 0.12.11 — 2026-10-22

**`music lyric` 三处实测反馈**

- **修**：制作信息行（`作词 / 作曲 / 编曲`）和歌名行（`年轮 - 张碧晨 (Diamond)`）
  会被播放器当歌词滚出来。之前只滤了酷狗 KRC 那一路，**网易云 LRC 那一路完全没滤**；
  逐字行因为带着 `<mm:ss.xx>` 标签，正文里混进一串时间戳数字，判据也不准。
  现在统一走 `stripNonLyricLines()`：剥掉逐字标签再判断，判据是"剥掉歌名和歌手后
  还剩多少实质内容"（≤4 字，或不含中日韩文字且 ≤12 字符）
- **修（我的锅）**：`--json` 从来没生效过 —— 它是**全局标志**，`main.ts` 在路由之前
  就把 `--json` / `--pretty` 从 argv 里剥掉了，命令根本收不到。改名为 `--with-text`。
  （`--json` 现在仍被静默吞掉，只是没有任何作用）
- **改进**：`--duration` 现在能在歧义时决胜 —— 多个版本都落在 ±3 秒容差内时，
  按"时长最接近"选。但要求**明显领先**（第二名至少差 1 秒），
  两个候选一样近时仍报歧义：那种情况下时长不构成证据，替用户选就是瞎猜
- 新增 5 条测试，都验证过"撤掉修复会变红"

## 0.12.10 — 2026-10-22

**补合集 ref 的入口级回归测试**

- `tests/collection-ref.test.ts` 原来只测 `parseCollectionRef` 这个纯函数 ——
  它证明"解析器认得这些写法"，但证明不了"三个命令真的用了它"。
  要是哪天某个入口自己写一份正则，那些测试照样绿，而那个命令已经认不出
  `season:<sid>` 了（v0.12.0 就退化过这一次）
- 新增的测试**对真命令调 `run()`**，比对同一批 ref 在
  `bili collection` / `bili bulk` / `bili subscribe add` 上的接受/拒绝是否一致
- 顺带钉住一条有意的不一致：`bulk` 认普通视频（配 `--all-pages`/`--pages`），
  另两个只认合集。哪天 bulk 不再支持，测试会提醒去改 usage

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

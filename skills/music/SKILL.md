---
name: astra-music
description: Download songs, albums and playlists to the NAS.
version: 0.11.0
author: SakuraChiyo0v0, Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Music, Download, NetEase, Library]
    category: media
prerequisites:
  commands: [astra]
# 让 terminal 子进程拿到 astra 的数据目录（Hermes 默认会过滤子进程环境变量）
required_environment_variables:
  - name: ASTRA_HOME
    prompt: astra 数据目录
    help: 部署时在容器环境里设好，例如 /opt/astra/home
  - name: ASTRA_MUSIC_DIR
    prompt: 音乐下载目录
    help: 部署时在容器环境里设好；本部署是 /host-root/volume1/音乐/流媒体（走全局挂载，不再挂 /music）
---

# Astra Music Skill

用 `astra` CLI 在网易云找歌并下载到 NAS 音乐目录：自动写标签、封面、歌词，已经有的不重复下。
它不负责播放，也不改动已有的音乐文件。

## When to Use

- 用户说"下载 / 下一首 / 帮我存 / 我要听 xxx（想保存下来）"
- 用户发来网易云的歌曲、专辑、歌单、歌手链接（包括 163cn.tv 短链和分享文案）
- 用户问"我有没有 xxx"、"最近下了什么"、"上次那个歌单下完了吗"
- 用户说"登录网易云 / 看我的歌单 / 我收藏了什么"

## 登录网易云（扫码）

登录做两件事：**看见**私人歌单 / 每日推荐 / 红心；以及**用你自己的账号取官方播放地址**。
官方通道优先级最高：VIP 账号常能直接拿到无损甚至 Hi-Res（实测 `アイドル` 拿到 24bit FLAC）。
官方拿不到时（下架、地区限制）才回落到洛雪音源。没登录也能下载，只是少这一条路。

1. `astra music login start` —— 立刻返回，不阻塞。
2. 回复里带上图片标记让它真的发出去：`MEDIA:<data.qrImage>`
   （`data.qrImage` 是 PNG 的绝对路径；**不要**把 base64 打印到对话里，也不要把二维码打成代码块 ——
   终端字符在聊天窗口里扫不出来）。发不了图时再用 `data.qrText` 的等宽代码块兜底。
3. 每隔 2~3 秒 `astra music login poll`，直到 `status` 是 `done` 或 `expired`。
   - `pending`：继续等，别催用户
   - `expired`：重新 `login start`，把新图再发一次
   - `done`：告诉用户登录成功、昵称是什么
4. 登录后可以：
   - `astra music playlists` —— 我的歌单（自建 + 收藏），每项带 `playlist:<id>`
   - `astra music daily` —— 每日推荐，带"为什么推给你"；加 `--download` 直接开下载任务
   - `astra music liked` —— 我喜欢的音乐；`--check wy:xxx` 查某几首有没有红心
   看曲目 `astra music info playlist:<id>`，整张下载 `astra music get playlist:<id>`。

## Prerequisites

`astra` 不在 PATH 里时用绝对路径 `/opt/astra/bin/astra`（不要猜 `/opt/astra/astra.mjs`，那个文件不存在）。已导入至少一个洛雪音源：
`astra doctor` 的 `lx_sources` 为 ok。没有音源时下载会报 `NO_SOURCE`，要让用户提供音源脚本。

## How to Run

全部通过 `terminal` 执行。stdout 只有一个 JSON：

- `ok: true` → 看 `data`，以及 `warnings`（要转告用户）
- `ok: false` → 看 `error.code` / `error.message` / `error.hint`（hint 就是下一步该做的事）

stderr 是进度日志，不用管。

## Quick Reference

| 想做的事 | 命令 |
|-|-|
| 下载（关键词 / 链接 / ref） | `astra music get <...>` |
| 指定音质 | `astra music get <...> --quality 320k` （128k / 320k / flac / 24bit，默认 flac） |
| 只搜不下 | `astra music search <关键词> [--type album\|playlist\|artist]` |
| 看专辑 / 歌单里有什么 | `astra music info <链接或 ref>` |
| 一次下多首确定的歌 | `astra music batch <ref> <ref> ...` |
| 曲库里有没有 | `astra music have <关键词>`；不带关键词 = 最近下载 + 统计 |
| 任务进度 | `astra music job <id> [--wait 60] [--failed]`；`astra music jobs --active` |
| 取消 / 继续任务 | `astra music job cancel <id>` / `astra music job resume <id>` |
| 订阅歌单 / 歌手 | `astra music subscribe add <链接>`；`subscribe list/run/set/remove` |
| 哪些歌音质还能升 | `astra music upgrade`（v0.10+，会给出 reason；旧的 `have --low` 已合并进来） |
| 补齐曲库规格 | `astra music have --refresh` |
| 按新规则重排存量文件 | `astra music retag --dry-run` 看影响面，再 `retag` → `--confirm <token>` |
| 补专辑封面 / 导播放列表 | `astra music covers`（从内嵌封面提，不联网）/ `astra music m3u` |
| 只取歌词（不下载音频） | `astra music lyric <ref\|关键词> [--word] [--out <路径>] [--duration <秒>]` |
| 音源管理 | `astra music source list/add/remove/enable/disable/test` |

## Procedure
1. 用户给关键词时，原样交给 `astra music get`，例如 `astra music get 晴天 周杰伦`。
   不要自己先 search 再挑。
2. 根据 `data.status` 回复：
   - `downloaded`：告诉用户歌名、歌手、专辑、**实际音质**（`quality`，例如 24bit FLAC / 128k MP3）。
     `downgraded: true` 时要说清楚"想要无损，只拿到了 128k"。`otherVersions` 不为空时可以顺带提一句"还有其它专辑的版本"。
   - `already_have`：告诉用户已经有了，在哪、什么音质。不要重新下载，除非用户要求（加 `--force`）。
   - `ambiguous`：**不要替用户选**。把 `candidates` 列出来（序号、歌名、歌手、专辑、时长、`flags` 里的翻唱 / Live / 伴奏等标记），
     问用户要哪个。用户选定后用那一项的 `ref` 执行 `astra music get <ref>`。
     如果候选里全是翻唱（原唱可能下架了），直接这样告诉用户。
   - `job_started`：专辑 / 歌单 / 歌手在后台下载。告诉用户任务 id 和总数（`alreadyInLibrary` 首已经有了）。
     用户追问进度时用 `astra music job <id>`；想等结果就 `astra music job <id> --wait 120`。
3. 用户说"第 2 个"、"要 Live 版"、"要原唱"时，从上一次的 `candidates` 里找对应的 `ref`，不要重新搜索。

## 核对歌单覆盖（歌单 vs 本地曲库）

用户问"我某个歌单下全了没 / 缺哪几首"时：

1. `astra music playlists` 拿 ref——注意字段是 **`ref`（`playlist:<id>`）**，不是 `id`（`id` 是 null，别直接拼命令）。
2. `astra music info <ref> --limit 200`：**默认只回 50 首**，100 首以上的歌单必须显式调大，
   并用 `data.truncated` 确认没截断。
3. 和本地目录比对时，文件名格式是 `歌手 - 歌名`，所以**只能拿歌名做子串匹配**
   （NFKC + 去标点小写后 `title in filename`），用相等匹配会全部落空、报出"101 首全缺"的假结果。
4. 汇报时给三行：歌单总数 / 本地已有 / 缺几首，再把缺的按歌手聚类（同一个团的扎堆缺，通常是整批没下）。
   歌单里的重复版本（同一首多个 ver.）单独说一句，别当下载问题。

## 存量音质体检（用户问"我的歌音质怎么样"）

不要凭记忆回答，用 ffprobe 扫一遍给分布：

```bash
python3 - <<'PY'
import os,subprocess,json,collections
D='/host-root/volume1/音乐/流媒体'   # 或 音乐/Bilibili、音乐/网易云（旧库）
rows=[]
for f in sorted(os.listdir(D)):
    p=os.path.join(D,f)
    if not f.lower().endswith(('.mp3','.flac','.m4a')): continue
    r=subprocess.run(['ffprobe','-v','quiet','-show_entries','stream=codec_name,bit_rate,sample_rate,bits_per_raw_sample','-of','json',p],capture_output=True,text=True)
    try: s=json.loads(r.stdout)['streams'][0]
    except: continue
    rows.append((s.get('codec_name'),int(s.get('bit_rate') or 0)//1000))
for k,n in collections.Counter(rows).most_common(): print(k,n)
PY
```

汇报时说清"全部 320k / 有几首低于 256k / 是否值得升无损"，并把升级代价（体积 4-6 倍）一起给出，
让用户选：保持现状 / 全量升 / 只升某几个歌手。320k mp3 在实际听感上已足够，不要主动催升。

## 重排存量文件（`music retag`，会动真实文件）

用户说"把以前下好的按新规则整理一下 / 我那几千首目录还是乱的"时用。它会**移动文件并重写标签**，
和红心一样必须二次确认：

1. 先跑 `astra music retag --dry-run` 看影响面。**这一步绝不落盘**，返回：
   - `summary`：`moves`（要搬几个）、`tagsChange`、`unchanged`、`problems`
   - `sample`：每条的 `from` → `to`，改到哪一目了然
   - `conflicts`：有冲突就执行不了，先解决（通常是目标位置已有同名文件）
2. 把 `summary` 和几条 `from → to` 给用户看，问一句"要搬吗"。
   **几千首的批一定要让用户先看数字**，别直接确认。
3. 用户同意后跑 `astra music retag`（不带 `--dry-run`）拿 `token`，再用
   `astra music retag --confirm <token>` 执行。令牌 5 分钟、只能用一次。
4. 执行后告诉用户 `moved` / `tagged` / `failed` 各多少。`failed` 里的文件**保持原样**，可以重跑。

**判成 `problems` 的条目不会被动。** 最常见的原因是
「曲库记录的 id 对不上」：曲库里的 `native_id` 和网易云同名 id 的其实是两首歌
（id 会被复用）。这种情况**不要自己改 id 硬来**，让用户先跑 `astra music have --refresh` 核对。

其它要说的：
- 有冲突就整批不执行，不做"改了一半" —— 这是故意的，别绕
- 写标签前后比对音频哈希，改到音频字节会中止
- 同目录的 `.lrc` / `.word.lrc` 会跟着文件一起搬
- 曲库记录会同步更新，搬完 `music have` 不会报"文件缺失"

## 订阅（自动追更）

用户说"盯着这个歌单/歌手，出新歌帮我下"时用：
1. `astra music subscribe add <链接|ref> --every 24` —— 第一次**只记基线**，不会把已有的全下一遍。
   用户要连已有的也下就加 `--download-existing`。
2. 之后靠定时任务触发：`astra music subscribe run`（只跑"到点的"）。
   如果 Hermes 有 cron 能力，配一条每小时执行的 `astra music subscribe run` 就够了。
3. `astra music subscribe list --runs` 看历史和最近有没有新歌。

## 红心 / 取消红心（写操作，必须二次确认）

这会改动用户真实的网易云歌单，**绝不能一句话就直接执行**：

1. 用户说"把这首加进我喜欢的"时，先跑 `astra music liked --like <ref>`（或 `--unlike`）。
   它**不执行**，只返回 `status: needs_confirmation`、`token` 和 `tracks` 预览。
2. 把 `tracks` 列给用户看（歌名 + 歌手），明确问一句"要给这几首点红心吗"。
   `willSkip` 大于 0 时说明有些本来就是红的、会自动跳过。
3. 用户确认后，用返回的 `token` 执行：`astra music liked --confirm <token>`。令牌 5 分钟有效、只能用一次。
4. 用户没确认就不要自己往下走；令牌过期要重新生成预览。

**不要**尝试自己拼令牌、也不要跳过确认环节。`willChange` 为 0 时说明没有需要改的，直接告诉用户即可。

## 目录结构：按歌手/专辑，永远不要按歌单建文件夹

用户纠结"按歌单下载还是按歌手下载"时，答案是**歌手/专辑**（`{albumartist}/{album}/`，astra 默认模板），并给出理由：

- 曲库追踪跟目录无关。`ASTRA_HOME/astra.db` 的 `tracks` 表按 `platform + native_id`（如 `wy:233933`）记一条，
  同时存 `file_path` / `format` / `quality`。核对"歌单缺哪几首"是拿歌单的 native_id 对 `tracks` 表，不是扫目录。
- 同一首歌会同时出现在多个歌单里，按歌单建目录就会变成多份副本，去重逻辑失效。
- 歌单是"视图"不是"归属"：歌今天在这个歌单、明天被移走，目录就烂了。
- "歌单加了新歌怎么发现"由 `subscriptions` 表解决（`last_seen` 记上次同步点），见上面订阅一节，不需要靠目录。

被问到"文件挪了会不会找不到"时：`file_path` 对不上会报 `missing: true`，`astra music have --refresh` 回读文件头修复，
`astra music forget <ref>` 只删记录、之后 `get` 会重下。

**不要随手改名 `ASTRA_MUSIC_DIR` 指向的那个目录**（本部署 = `音乐/流媒体/`）：它是 astra 的落盘根，
改名必须同步改 env 和数据库路径，具体步骤见下面「音乐目录的位置与改名」。

改名前后的规矩：
- 运行中的容器不受目录改名影响（bind mount 跟 inode 走），但**重启后**按路径解析，必须同步改挂载源
- 容器内路径 `/music/...` 不变 → `tracks.file_path` 无需修改
- 目录名保持**音源中性**（`流媒体`），不要叫 `网易云`：astra 是多音源（官方网易云 / 洛雪走网易云 / 洛雪走酷我）
- 想只验证 compose 解析是否正确、又不重建容器：
  `/opt/data/.docker/cli-plugins/docker-compose --env-file .env config | grep -A2 music`
  （容器内没有 compose 插件，这个静态二进制只用于 `config` 校验）

## 音乐目录的位置与改名（本部署已改为走全局挂载）

**当前状态**：`ASTRA_MUSIC_DIR=/host-root/volume1/音乐/流媒体`，**没有** `/music` 专用挂载了 ——
只有一条全局 `/volume1 → /host-root/volume1`。`tracks.file_path` 也已经是
`/host-root/volume1/音乐/流媒体/...` 全路径。

为什么改掉专用挂载：专用挂载（`${MUSIC_DIR}:/music`）会让“改目录名”变成“改 docker 配置 + 重建容器”；
走全局挂载后，**改目录名只需要改 `ASTRA_MUSIC_DIR` + 批量改数据库路径，docker 不用动**。

**以后再改音乐目录名的完整步骤**（按顺序，缺一步就出 `missing`）：

```bash
# 1. 改目录名（同卷瞬时；运行中的 astra 会立刻失效，所以下一步要跟上）
mv /host-root/volume1/音乐/旧名 /host-root/volume1/音乐/新名
# 2. 改容器环境变量（compose 里的 ASTRA_MUSIC_DIR）并重建容器
# 3. 批量改数据库路径
python3 -c "import sqlite3;c=sqlite3.connect('/opt/astra/home/astra.db');\
c.execute(\"update tracks set file_path=replace(file_path,'/音乐/旧名/','/音乐/新名/')\");c.commit()"
# 4. 验证
/opt/astra/bin/astra music have | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['stats'])"
```

- 目录名保持**音源中性**（`流媒体`），不要叫 `网易云`：astra 是多音源（官方网易云 / 洛雪走网易云 / 洛雪走酷我）
- 改名/改 env 之后如果不想马上重建容器，可以先用环境变量模拟：
  `ASTRA_MUSIC_DIR=/host-root/volume1/音乐/新名 astra music have` —— 能报 `missing: 0` 就说明路径和 DB 都对上了
- 只验证 compose 解析是否正确、不重建容器：
  `/opt/data/.docker/cli-plugins/docker-compose --env-file .env config | grep -A2 music`
  （容器里没有 compose 插件，这个静态二进制只用来做 `config` 校验，不要用它重建自己）

## 存量 mp3 批量升级成 FLAC（用户说"把老歌升级成无损"）

老目录（如早期下载的 169 首 320k mp3）升级的正确做法，不要手工一首首来：

1. `ffprobe` 批量读旧文件的 `title` / `artist` / `album`（旧库文件名常是 `歌手 - 歌名.mp3`，不可靠，读标签）
2. 逐首 `astra music search "<title> <主歌手>"`，在 `items` 里挑 **`artists` 含该歌手且标题匹配**的那条，拿 `ref`
   —— 不要直接把关键词丢给 `get`，会大量 `ambiguous` 且可能选到翻唱
3. `astra music get <ref>` 逐首下（`music batch` 也行），记下 `status` / `quality` / `path`
4. 全量跑完再动旧文件：把旧目录整个 `mv` 进 `.hermes-trash/<日期>/`（不要 `rm`），
   并核对新库 `music have` 的 `missing: 0`
5. 拿不到 FLAC 的（抖音翻唱、Live、冷门）会 `downgraded` 或只有 320k，**如实汇报"几首只能留在 mp3"**，
   不要为了让报告好看而隐瞒

跑批量前先给用户一条预估：多少首、预计体积（FLAC 约为 mp3 的 4-6 倍）、大概耗时。

## 相关技能

- `nas-media-ops`：库体检、批量重命名、BV 标签回填、歌词内嵌的现成脚本。用户说“检查库/整理名字/补标签”时先看它。
  其中 `sync_title_tag.py` 解决“文件名改了但播放器里标题还是乱”的问题——播放器导入读的是内嵌 `TIT2`，
  不是文件名；B 站 `--audio-only` 落的标题是视频原名（一句歌词 + 书名号 + UP 名），改名后必须同步。

## 多歌手 / 合作曲的目录归属

模板用 `{albumartist}`（专辑艺术家）。**v0.12.3 起 astra 已改为「一律取第一位」**：
`isCompilation() → Various Artists`，否则 `firstOf(album.artists ?? trackArtists)`——
所以合作单曲、OST、双人专辑都落在主歌手目录下，不会再出现 `Lady Gaga, Bruno Mars/`。

**规则（用户明确要求）**：**目录归到第一位歌手**，歌手文件夹里不出现逗号拼接；标签不动。

- 标签本来就对：`ARTIST = "ROSÉ;Bruno Mars"`（分号分隔多值），Navidrome/Jellyfin 能正确拆开，
  所以播放器里搜任一歌手都能找到，**不要改标签**
- 文件只存一份：去重靠 `tracks.native_id`，跟歌手名无关，不会因为多歌手重复下载
- **每次批量下载后自检**：`ls -d "$ASTRA_MUSIC_DIR"/*/ | grep ','`，有输出就是待修（一条命令，别靠肉眼）
- 万一又出现拼接目录（旧版本下载的、或回归了）：把 `歌手A, 歌手B/专辑/` 移到 `歌手A/专辑/`，
  然后 `update tracks set file_path=replace(file_path,'/music/歌手A, 歌手B/','/music/歌手A/')`；
  确认新版本能正确落盘后，旧目录直接移进 trash
- 合辑（Various Artists / 群星）归到 `合辑/`（`music.compilation-dir`，默认值就是中文 `合辑`）

用户纠结“一首歌多个歌手会不会出问题”时的标准回答：**不会重复下载**（去重按 `native_id`），
**播放器按歌手搜也能搜到**（标签是多值）；唯一毛病是文件夹浏览时歌不在主歌手名下，收敛到第一位歌手即可。

**改 `ASTRA_MUSIC_DIR` 指向的目录前先看下面「音乐目录的位置与改名」一节**——本部署已经改成走全局挂载，
改名不再需要动 docker 挂载，但**必须同步改 env 和 `tracks.file_path`**，漏一步就是全库 `missing`。

## 查重复（用户问"曲库里有没有重复的歌"）

三层查，从粗到细，不要只做一层就下结论：

1. **同歌名 + 同歌手**：查 Navidrome 库（`media_file` 表，`path like '流媒体/%'`）按 `(title, artist)` 分组，
   多于 1 条的列出来——这类常是「同一首歌同时出现在单曲和精选集」，属于合理重复，让用户决定
2. **文件级完全重复**：`find <dir> -name '*.flac' -printf '%s %p\n' | sort -n | uniq -D -w10`（同字节大小）
3. **近重复（同一音源的不同转码）**：时长**精确到毫秒一致**但码率差很多（如 182.508s 的 325k vs 172k）
   = 同一条视频/音频的两次下载。用 `ffmpeg -v quiet -i <f> -map 0:a -f md5 -` 比音频流，
   **MD5 不同不代表是两首歌**（转码参数不同就会不同），要靠时长+码率判断

汇报时分开说：“同歌名多版本 N 组（合理）/ 字节级重复 0 / 同源不同转码 2 组（建议留高码率那份）”。

## 歌词与 Navidrome（用户说「Navidrome 里没歌词 / 歌词每个字一行」）

先分清三件事，别瞎猜：

1. **文件有没有歌词**：`astra` 下载的 FLAC 会写 `.lrc`（逐行，带时间戳）+ `.word.lrc`（逐字，用户要保留）
   + 内嵌 `LYRICS` 标签；**B 站 `--audio-only` 下载的 mp3 完全没有歌词**（无 `.lrc`、无标签），这是最常见的「没歌词」原因
2. **Navidrome WebUI 只渲染「内嵌」的同步歌词**（`[mm:ss.xx]` 或逐字 `<mm:ss.xx>`）——
   **sidecar `.lrc` 对 WebUI 无效**，它从 `media_file.lyrics` 列（扫描时从标签解析）取歌词。
   所以“明明有 .lrc 却显示无歌词”通常是**标签里是纯文本或没有标签**，不是文件名问题；
   第三方客户端（Feishin / Symfonium）走 API，才可能用上 sidecar。
   **v0.12.4 起 astra 内嵌的就是同步格式**（逐字优先 → LRC → 纯文本兜底），
   v0.12.4 之前下载的存量文件仍是纯文本，需要用 `music retag` 或手工重写
3. 判断服务端到底有没有：查 Navidrome 的 sqlite（`/volume1/docker/navidrome/data/navidrome.db`）
   `select title,length(lyrics),substr(lyrics,1,120) from media_file where path like '流媒体/%'` ——
   JSON 里 `line` 有 `start` 字段 = 同步歌词；只有 `value` = 纯文本

**修法（存量文件）**：
- 首选 `astra music retag`——它会读同目录的 `.word.lrc` / `.lrc` 换成带时间戳的版本重写内嵌标签
  （先 `--dry-run` 看影响面，再拿 token 确认）
- 只修个别几首可用 mutagen 手工写，见 `references/navidrome-lyrics.md`
- 改完必须让 Navidrome 重扫：`docker restart navidrome` 只触发**快速扫描**（能发现新增/重命名，但不清理 missing 行）；
  怀疑 DB 与磁盘不一致时用 `docker exec navidrome /app/navidrome scan --full`。
  验证方式见 `nas-media-ops` 的「让 Navidrome 真的重扫」——数 `media_file` 行数，不要只看日志里的 `tracksMissing=0`

**sidecar 命名（只影响会读 sidecar 的第三方客户端）**：客户端只按 `<音频文件名>.lrc` 查 sidecar，
`.word.lrc` **永远不在查找名单里**，所以「逐字文件存在、播放器却用逐行」是命名问题，不是解析问题。
**v0.12.6 起 astra 自己就按正确布局写**：

- `<base>.lrc` = **逐字**（ELRC，`[mm:ss.xx]<mm:ss.xx>字`）
- `<base>.line.lrc` = 逐行（普通 LRC，给不认 `<...>` 的客户端兜底）
- 读取时三种后缀（`.lrc` / `.line.lrc` / `.word.lrc`）都兼容，老文件不用改也能读

存量修法（v0.12.6 之前下的）：`.word.lrc` 改名为 `.lrc`，原来的 `.lrc` 先改名为 `.line.lrc`；
内嵌标签已经写好的话不用重写，改完让 Navidrome 重扫即可。批量改名用 `nas-media-ops` 的 `embed_lyrics.py`。

不要建议删逐字歌词：用户明确说逐字是他要的效果，删了是破坏需求。

## 游戏 OST / 动画专辑：人声 vs 纯音乐（用户问"这些是不是伴奏"）

整张 OST 下完后，用户常问"里面是不是一堆纯音乐"。**不要凭曲名和时长猜**，用内嵌歌词判定——
网易云给纯音乐填的固定文本是 `纯音乐，请欣赏`：

```bash
python3 - <<'PY'
import os
from mutagen.flac import FLAC
root = "<专辑目录>"
vocal, inst = [], []
for dp, _, fs in os.walk(root):
    for fn in sorted(fs):
        if not fn.endswith(".flac"): continue
        f = FLAC(os.path.join(dp, fn))
        lyr = (f.tags.get("LYRICS") or [""])[0]
        m, s = divmod(int(f.info.length), 60)
        (inst if "纯音乐" in lyr else vocal).append((f"{m}:{s:02d}", fn))
print("人声", len(vocal), vocal); print("纯音乐", len(inst), inst)
PY
```

判定后的处理规矩：

- **汇报时分开列**：有人声的（歌名 + 时长 + 音质）和纯音乐/BGM（按主题聚类，别一行一首刷屏），
  并明确说出"同一首的 `[instrumental]` / `[8bit]` 变奏我按纯音乐算"，让用户有机会拦。
- 用户说"只留人声"时：**先列完整清单（含体积合计）等确认**，再 `mv` 到 `.hermes-trash/<日期>/`，
  同名的 `.lrc` / `.line.lrc` 一起搬（否则留一堆孤儿 sidecar）。
- 搬完要清三处，缺一处就是脏数据：
  1. `astra music forget <ref>`（ref 从 `tracks` 表取 `platform:native_id`；一次失败就单独重试，
     批量循环里漏掉的那条会一直以 `missing` 挂着）
  2. `docker exec navidrome /app/navidrome scan --full`
  3. 验证：Navidrome 的 `media_file` 把被删的标成 `missing=1`（**不会自动删行**，界面里看不到即可，
     不要为了"干净"去手删 DB 行）
- 游戏 OST 里 1–2 分钟的循环曲、8 秒的音效（`Boot` 这类）基本都是 BGM，人声曲往往只有 3–6 首。

## 播放器里歌手被 "; " 拼在一起（用户说"歌手没分开"）

先查标签再下结论，**不要急着改**：

- FLAC/OGG 的多歌手是**多个 ARTIST 值**（Vorbis comment 允许多值），ID3 则是多个 `TPE1` 帧；
  这是正确写法，Navidrome / Jellyfin / Symfonium 都能按单个歌手检索。
- 播放器详情页把多个值用 `; ` 拼成一行**只是渲染方式**，不是标签坏了。
- 判断"到底是标签问题还是显示问题"：扫一遍库，数「多值 ARTIST」和「单值里塞了 `;` / ` / `」两类。
  前者多、后者 0 → 标签没问题，让用户去播放器里设艺术家分隔符。
- 只有用户明确要求"列表里只显示演唱者"时才动标签（`ARTIST` 留演唱者，作曲移 `COMPOSER`，企划名留 `ALBUMARTIST`），
  并说明代价：企划名不再出现在歌手栏。默认**不改**。

## 用户问「有没有 X 的歌」（库里没有时怎么提方案）

1. 先查库：`select ... from tracks where artists like '%X%'`（或 `astra music have X`），给准确数字，
   不要凭印象答“应该没有”。
2. 库里没有时，**不要直接报一个几百首的总数就开下**。用 `astra music search "<歌手>" --type album` 列专辑，
   把候选收敛成 2-3 个方案让用户选：经典几张（录音室专辑）/ 一张精选（冠军单曲）/ 全部（含遗作、混音、
   现场、合辑——这堆往往占了一半以上）。
3. 方案里写清每张的年份和曲目数，用户拍板后再 `astra music get album:<id>` 逐张下；
   全都要时先算体积（FLAC ≈ 30-40MB/首）再问一句。

## Pitfalls

- **`astra music have --limit 0` 拿不到常规 `data` 结构**（实测解析直接 `KeyError: 'data'`）：
  想要统计就别传 `limit`，直接 `astra music have` 读 `data.stats`；只要最近几条就传正数。
  同理，`have` 列表里歌手字段是 **`artists`（复数，可能是数组）**，不是 `artist`——
  按 `r['artist']` 取会得到一片 `None`，看着像「曲库歌手全丢了」。写脚本前先 `head -c 500` 看一眼真实结构。
- **`music search --type album` 的 schema 与 `--type song` 不一样**：song 返回 `{type, keyword, total, page, items[]}`，
  album **没有 `total` / `page`**，只有 `{type, keyword, items[]}`；每项的字段也不同——
  album 是 `{ref: 'album:<id>', name, subtitle: '歌手 · 年份', count}`，不是 `title` / `artists` / `duration`。
  照 song 的字段名写解析会直接 `KeyError: 'total'`。写脚本前先 `head -c 500` 看一次真实结构。
- 关键词里歌名和歌手都写上，结果明显更准；只写歌名常会得到 `ambiguous`，这是正常的。
- `quality` 是**下载后实测**的音质，以它为准，不要按请求的档位告诉用户。
`source` 是音频从哪来的：`official` = 用户自己账号的官方地址（最好，VIP 能到无损/Hi-Res）；
`qdy@wy` / `qdy@kw` = 经洛雪音源，分别走网易云和酷我同曲。用户问"是不是官方的"时按这个回答。
- `NO_PLAYABLE_URL`：所有音源都拿不到这首（版权 / 音源失效）。可以建议用户换 `otherVersions` 里的版本，或者过一会儿重试。
- `RATE_LIMITED` / `retryable: true`：等一两分钟再试，不要连续重试。
- **多张专辑不要并行发**：`music get album:<id>` 连发多条时，去重是**先到先得**，同一首歌会被
  先下完的那张专辑占住（精选集/合辑抢走录音室专辑的曲目），原专辑被记成 `skipped`，
  而每个 job 都报 `done`——播放器里点开原专辑就少了招牌曲。按**发行年份从早到晚串行**下载，
  精选集/合辑放最后；已经错位的，归位步骤（改文件名序号 + 标签 + `tracks.file_path` + 重嵌目标专辑封面 + 重扫）
  见 `nas-media-ops` 的「整张专辑下载：并行去重会把曲目归错专辑」。
- **`music covers` 指定目录必须用 `--dir`**：路径含空格（如 `…/Michael Jackson`）当位置参数传会报
  `INVALID_INPUT 参数太多`。
- 任务 `status` 是 `interrupted`：进程意外退出（比如容器重启），执行 `astra music job resume <id>`。
- 整张歌单下完后 `done` 数会小于 `total`，差额是 `skipped`——**歌单内部的重复版本**（同一首的多个 ver.）
  自动去重，不是失败。汇报时说"98/101，3 首是歌单里重复项"，别报成丢歌。
- **`job --items` 的 `status` 值域随版本变过**：v0.12.6 起统一为 `downloaded` / `skipped` / `failed`（与单曲 `data.status` 一致）；
  更早的版本是 `done` / `skipped`。写脚本过滤前先打印一次 `sorted({i["status"] for i in items})` 确认值域，
  或者用 `!= "failed"` 判成功——按固定字面量写死过滤条件会把全部成功项筛掉（曾因此误报"101 项全异常"）。
- **删旧目录前先算差集**：重新下载完一个新歌单/新音质后，旧目录里可能有**不在新歌单里**的内容
  （本轮 `音乐/网易云/中文/` 就有 160 个文件不在 K-POP 歌单里，直接删会连坐）。做法是拿旧目录的文件名
  与新集合做差集，差集非空就**先只删被覆盖的那部分**，剩下的列给用户决定。
- `astra music upgrade` 的输出：`candidates`（每项带 `current` / `available` / `reason`，如"档位更高：128k → flac"）
  和 `noUpgrade`（官方已到顶，会写明原因）。升级用 `astra music get <ref> --force`，下完记得删掉旧的同名文件
  （astra 只写新文件，不会自动清理旧扩展名）。
- **`upgrade` 的 `noUpgrade.reason` 是音源上限，不是本地没下到**：常见文案是「官方也只能给到 flac（44k/16bit）」——
  意思是母带就这样，换源也不会更好。`upgradable: 0` 时要如实说「已经是能拿到的最高」，
  不要说成升级失败、也不要建议重下碰运气。`--scan` 每首一次接口（扫 60 首约 1 分钟），
  先报扫描面与结果再问要不要 `--apply`。
- **`tracks` 表只装网易云**（`platform='wy'`）：B 站音频落在 `bili.audio-dir`，**不入这张表**。
  所以 `music have` 的「曲目 N 首 / 体积 X G」只代表网易云那部分，不能当整个音乐库汇报；
  用户问 B 站那批时去看目录和 `job_items`（详见 `astra-bili` 的《把一个 UP / 合集整成音乐库》）。
- **`astra music lyric`（v0.12.10+）是给存量音频补词的唯一正确入口**，不要再手写网易云/酷狗抓取：
  `--word` 取逐字（酷狗 KRC）、`--out` 按 `.lrc`（逐字）/`.line.lrc`（逐行）自动拆两份、
  `--duration <实际秒>` 用真实音频时长做校验（B 站音频必须传，否则它拿不到网易云记录）。
  三个已知局限：① **不过滤词/曲/编曲署名行**，要自己清理；② `--json` 不给正文（只有行数），想拿文本就 `--out` 落临时文件再读；
  ③ 关键词多版本时返回 `LYRIC_AMBIGUOUS`，**改用 `ref`（`wy:<id>`）调用**就能绕开——
  先用 `astra music search` 拿候选、按 `duration` 挑出对应版本，再 `lyric <ref>`。
- **`music covers`：v0.12.13 起按目录枚举**，返回 `dirs` / `hasCover` / `missing`，恒等式
  `dirs == hasCover + missing.length`；先跑 `astra music covers --verify` 只自检不写，看 `missing` 就知道差哪几个。
  更早的版本按曲库 DB 枚举，磁盘上有、`astra.db` 里没记录的“孤儿专辑”会被静默跳过，
  返回的 `written/failed/missing` 看着都正常——遇到老版本只能自己数：专辑目录数 == `cover.jpg` 数量，
  缺的那张从该专辑任一音频提内嵌封面手工补（`FLAC(p).pictures[0].data` 写 `cover.jpg`）。
- 不要删除音乐目录里的文件；`astra music forget <ref>` 只删记录、不删文件。
- 真要删 NAS 上的目录/文件：**先列内容清单给用户确认**，然后软删除——`mv` 到 `/host-root/volume1/.hermes-trash/<日期>/`
  （容器里**没有** `/volume1` 挂载，写 `/volume1/...` 会 `No such file or directory`；同卷瞬时、可恢复），
  不要 `rm -rf`（会绕过 NAS 回收站，不可恢复）。清空由用户或 cron 决定。
- 音源脚本由用户提供，不要自己去网上找音源导入。
- 用户在宿主机侧跑登录后，会话文件（`*-session.json`）属主常变成 `root:root 600`，容器内 hermes 用户
  报 `EACCES`。修复：`docker run --rm -v <ASTRA_HOME宿主路径>:/fix alpine sh -c 'chown 1000:10 /fix/*-session.json'`
  （1000:10 = hermes:uucp），然后重新验证。这个坑对 netease/bili/vr 所有 session 文件都适用。
- **批量改元数据/歌词前先统一属主**：早期用宿主机 root 跑的 astra 会在音乐目录留下 `root:root` 的文件和目录，
  mutagen 写标签、`os.rename` 改 sidecar 都会 `Permission denied`（报错只指到具体某首歌，容易漏）。
  一次性修：`docker run --rm -v /host-root/volume1/音乐/流媒体:/m alpine sh -c 'find /m ! -user 1000 -exec chown 1000:10 {} +; find /m -type d -exec chmod 775 {} +'`
  —— **文件要 chown、目录也要 chmod**，只改文件仍然不能改名/新建。

## Verification

`astra doctor` 全部 ok。下载完成后，`astra music have <歌名>` 能查到这首，`missing` 为 false。

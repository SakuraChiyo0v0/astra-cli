---
name: astra-music
description: Download songs, albums and playlists to the NAS.
version: 0.6.0
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
    help: 部署时在容器环境里设好，例如 /music
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

`astra` 在 PATH 里（或用绝对路径 `node /opt/astra/astra.mjs`）。已导入至少一个洛雪音源：
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
| 哪些歌音质还能升 | `astra music have --low` |
| 补齐曲库规格 | `astra music have --refresh` |

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

## Pitfalls

- 关键词里歌名和歌手都写上，结果明显更准；只写歌名常会得到 `ambiguous`，这是正常的。
- `quality` 是**下载后实测**的音质，以它为准，不要按请求的档位告诉用户。
`source` 是音频从哪来的：`official` = 用户自己账号的官方地址（最好，VIP 能到无损/Hi-Res）；
`qdy@wy` / `qdy@kw` = 经洛雪音源，分别走网易云和酷我同曲。用户问"是不是官方的"时按这个回答。
- `NO_PLAYABLE_URL`：所有音源都拿不到这首（版权 / 音源失效）。可以建议用户换 `otherVersions` 里的版本，或者过一会儿重试。
- `RATE_LIMITED` / `retryable: true`：等一两分钟再试，不要连续重试。
- 任务 `status` 是 `interrupted`：进程意外退出（比如容器重启），执行 `astra music job resume <id>`。
- 不要删除音乐目录里的文件；`astra music forget <ref>` 只删记录、不删文件。
- 音源脚本由用户提供，不要自己去网上找音源导入。

## Verification

`astra doctor` 全部 ok。下载完成后，`astra music have <歌名>` 能查到这首，`missing` 为 false。

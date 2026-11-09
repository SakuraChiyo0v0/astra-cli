---
name: astra-comic
description: Download comics/manga albums to the NAS by album id or search, track ongoing series, and register pages in the asset library.
version: 0.3.0
author: SakuraChiyo0v0, Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Comic, Manga, Download, Subscribe]
    category: media
prerequisites:
  commands: [astra, ffmpeg]
required_environment_variables:
  - name: ASTRA_HOME
    prompt: astra 数据目录
    help: 部署时在容器环境里设好，例如 /opt/astra/home
  - name: ASTRA_COMIC_DIR
    prompt: 漫画下载目录
    help: 部署时在容器环境里设好，例如 /host-root/volume1/.../漫画
---

# Astra Comic Skill

用 `astra` CLI 按车号或关键词下载漫画到 NAS。自动解混淆、按章节落盘、登记资产库。
连载可以订阅，出新话自动补下。不依赖本机其它下载容器。

## When to Use

- 用户说"下这个本 / 下漫画 / 存一下"并给了车号、JM 号或链接
- 用户给了漫画标题，需要先搜再下
- 用户问某本有几话、叫什么名字
- 用户说"这本在连载，更新了帮我下 / 追更"
- 用户问"漫画下到哪了 / 下完没"

## Prerequisites

`astra` 在 PATH 里，并且装了 **ffmpeg**（解混淆用，和 B 站共用）。
`astra comic doctor` 能看到目录与上游是否可用。

## How to Run

stdout 只有一个 JSON。`ok:true` 看 `data`，`ok:false` 看 `error.code` / `error.message` / `error.hint`。

## Quick Reference

| 想做的事 | 命令 |
|-|-|
| 下载整本（多话自动后台） | `astra comic get <车号\|链接>` |
| 只下一话 | `astra comic get <车号> --chapter 3` |
| 强制后台 / 强制当场下完 | `astra comic get <车号> --background` / `--wait` |
| 看任务进度 | `astra comic job <任务id>`（`--items` 每一话，`--wait 600` 等完） |
| 最近任务 | `astra comic jobs [--active]` |
| 取消 / 继续任务 | `astra comic job cancel <id>` / `astra comic job resume <id>` |
| 先看信息 | `astra comic info <车号\|链接>` |
| 搜标题 / 正文 | `astra comic search <关键词>` |
| 按标签 / 作者 / 角色 | `astra comic search <词> --scope tag`（还有 `author` / `actor` / `work`） |
| 订阅连载 | `astra comic subscribe add <车号> [--every 24] [--backfill]` |
| 订阅列表 / 改 / 删 | `astra comic subscribe list` / `set <id> --every 12 --disable` / `remove <id>` |
| 定时检查（给 cron） | `astra comic subscribe run` |
| 认领已有本子进资产库 | `astra lib root auto` → `astra lib adopt --root comic` |
| 自检 | `astra comic doctor` |

`get` 的选项只有 `--chapter` / `--background` / `--wait` / `--force` / `--concurrency`。
`--out`、`--pages`、`--page-range` 都不存在（会报 `INVALID_INPUT: Unknown option`），
落盘目录只能靠 `comic.dir` / `ASTRA_COMIC_DIR` 改——想临时换个地方存，先改配置再跑。

## Procedure

1. 用户给车号或链接 → 直接 `astra comic get <...>`。
2. 用户只给标题 → `astra comic search <标题>`。点名标签、作者或角色时加 `--scope tag|author|actor`。看 `data.status`：
   - `exact` → 用 `data.pick` 再 `get`
   - `ambiguous` → 把 `candidates`（id / title / author）列给用户选，**不要替用户挑**
   - `empty` → 换词或换 `--scope`
3. `get` 的 `data.status`：
   - `job_started`：多话本开了后台任务，告诉用户任务 id；要结果就 `astra comic job <data.job.id> --wait 600`
   - `downloaded`：下好了，可报章节数与目录
   - `already_have`：每一页都在且通过完整性校验，没重复下。缺页或截断的图会重下
4. 后台任务的 `status`：`done` 全好；`partial` 有话失败，`--failed` 看哪几话、`job resume` 重试；`interrupted` 是 worker 没了（重启），`job resume` 接着下。每一话的 `items[].status` 是 `downloaded` / `skipped`（已有）/ `failed`，统计成功时 `skipped` 也算
5. 用户要追更 → `astra comic subscribe add <车号>`。默认把现有的话记为基线，只下**之后**的新话；用户也要补旧话就先 `comic get`，或加 `--backfill`。返回的 `data.cron.command` 就是要挂在 cron 上的那一行（建议每 6 小时）
6. 下完 `warnings` 里提示"没登记进资产库"→ 漫画目录还不是 lib root：`astra lib root auto` 后 `astra lib adopt --root comic`
7. 失败看 `error.hint`；网络类可稍后重试。

## Notes

- 落盘：`comic.dir` / `ASTRA_COMIC_DIR`，默认模板 `{id} {title}/{chapter:02}/{page:03}.{ext}`。后台任务和订阅用同一个模板
- 下完会登记进资产库，id 是 `comic:<本子>_c<话数>_p<页码>`。存量本子靠目录里的 `.astra-comic.json` 认领，不用重下
- 订阅按章节 id 求差判断新话；只有下成功的话才记为已下，失败的下一轮自动重试；上一轮任务没跑完时这一轮跳过
- `--force` 只能当场下载时用（不能和 `--background` 一起）
- 解混淆需要 ffmpeg；缺了用 `astra comic doctor` 看
- **并发上限是上游给的**：`--concurrency 1` → 5 页/分钟，`6` → 10 页/分钟。单页 658KB、下载占 8–10 秒、
  ffmpeg 解混淆只占 2 秒，瓶颈是图床按 IP 限速。默认 3–6 就够，别靠加并发救慢。

## 按作者/画师找作品（pixiv → JM 对齐）

用户给一个 pixiv 作者、要「他在 JM 上还有什么本」，不要直接拿 pixiv 昵称去搜就下结论：

- **JM 的标题以汉化组前缀开头**（`[某某汉化组] [作者] 标题 (作品)`），`--scope author` 匹配的是
  `author` 字段，pixiv 昵称、社团名（`ヤン年金サン組`）、X 账号（`sunchdayo`）都常常 0 条——
  **搜不到不等于没有，也不能当成已确认没有**，只能说“按这些名字没找到”。
- **日文假名角色名经常 0 条**（实测 `アスイヴ` → 0），JM 用中文译名。改用中文角色名或作品中文名，
  并用 `--scope actor` / `--scope work` 交叉找：`伊芙琳`、`阿斯特拉`、`绝区零`。
- 结果里按 `author` 字段人工比对，别按标题里出现的角色名就认定是同一作者；
  找到多个候选时把 `id / title / author` 列给用户选，**不要替他挑**。
- pixiv 上的是同人志 **sample（试读页）**，完整本在场贩/蜜瓜/虎穴；pixiv 没有全本不代表 JM 也没有，
  两件事分开说。

## 下载很慢时，按这个顺序查

1. **确认图片域名有没有被代理分流命中**。接口域名（`www.cdnhjk.net` 等）和图片域名
   （`cdn-msp.jmapiproxy1.cc` / `jmapiproxy2.cc` / `jmapinodeudzn.net`）是两批，
   只给接口域名写规则 = 图片流量落到 `MATCH` 随机挑节点 → 同一本书时快时慢。
   详见 skill `nas-proxy-ops`。
2. **看单页实际耗时**：`astra comic get <id> --concurrency 1` 跑 60 秒数页数。
   12 秒/页正常，50 秒/页是网络被限速或截断。
3. **别用延迟测速当判据**，图床对非法路径会秒回 51 字节 JSON，TTFB 骗人；
   用 `scripts/node_pick.py`（靶子是真图，由 `scripts/comic_probe.py` 生成）。
4. `TIMEOUT` / 「操作超时」是 astra 自己的整体超时，不是上游错误——换节点后重跑即可，已下的页会跳过。

## 先查重：库里有的、预览过的，都不要重下 / 重发

两处都要查，缺一处就会让用户看到重复内容：

1. **库里已有的车号** —— 扫 `comic.dir` 的目录名，车号在开头的 `^(\d{4,})`。
2. **已经发过预览的车号** —— `cache/comic-previewed.json`（`send_comic_preview.py` 里
   `already_sent()` / `mark_sent()` 维护，默认跳过，`--force` 才重发）。

`scripts/comic_find.py <关键词...>` 把「搜索 → 排掉库里已有 → 排掉预览过 → 按汉化/非 AI 排序」一次做完：

```bash
python3 scripts/comic_find.py 绝区零 ゼンレスゾーンゼロ --limit 8
```

**目录存在 ≠ 这本是新的**：目录在但页数少于 `astra comic info` 的 `pageCount`，说明是以前下漏的，
补页 `get` 一遍就完整了。补页是维护动作，**不要按新书发预览**——用户上次已经看过了。
判断「新本」只看目录名（车号）在本次操作前是否存在，不看文件修改时间。
订阅补下的新话同理：是追更，不是新书，不要当新本发预览。

## 发预览到群里（敏感本子）

- 一律走 `media_router` 的 `guard()` / `send_album_guarded()`，只发 `SENSITIVE_CHAT_ID`；
  本子内容按敏感处理，**不要用识图工具去看这些图**，按文件/日志核对即可。
- **先转换后发送时，临时文件名必须唯一**（带上书号）：早期脚本把预览存成 `{话号}_{页名}.jpg`，
  所有书都写到同一个文件，相册里 N 张全指向最后一张 → 群里出现一串一模一样的图。
- 发之前对 `items[*].path` 做一次去重 + 哈希校验；重复是「同一路径被写多次」的典型征兆，
  不是用户看错。

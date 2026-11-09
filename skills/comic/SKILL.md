---
name: astra-comic
description: Download comics/manga albums to the NAS by album id or search, track ongoing series, and register pages in the asset library.
version: 0.2.0
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

## 发送预览：临时文件名必须带书号

`send_comic_preview.py` 早期用「话号_页名」拼临时文件名（`01_001.webp.jpg`），
而所有书的路径都一样。脚本又是「先把每本的预览全部转好，再一次性发相册」，
于是相册每条都指向同一个文件，群里出现一串一模一样的图。

规则：**先转换后发送时，临时文件名必须唯一**（带上书号/作品 id）；
发相册前对 `items[*].path` 做一次去重 + 哈希校验，比事后看群里的图更早发现问题。

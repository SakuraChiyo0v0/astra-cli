---
name: astra-comic
description: Download regular manga (Komiic / CopyManga) to the NAS by title or link, volume or chapter at a time. JM doujin is astra-jm.
version: 1.1.0
author: SakuraChiyo0v0
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Comic, Manga, Download]
    category: media
prerequisites:
  commands: [astra]
---

# astra comic：普通漫画

## When to Use

- 用户要下一部漫画（单行本、连载）
- 用户问某部漫画在哪个源、有几卷几话

不适用：JM 本子 / 车号 → `astra jm`；小说 → `astra novel`。

## 命令

| 想做的事 | 命令 |
|-|-|
| 搜作品 | `astra comic search <作品名>`（繁简都行，两个源一起搜） |
| 看分组和章节 | `astra comic info <作品名\|链接>` |
| 下载（后台任务） | `astra comic get <作品名\|链接> [--group 单行本] [--range 1-3,5] [--cbz]` |
| 看进度 | `astra comic job <id> [--wait 600]`，`--failed` 看哪几话失败 |
| 接着下 | `astra comic job resume <id>`（只补缺的页；限流不用它，见第 4 条） |
| 最近任务 | `astra comic jobs [--active]` |
| 自检 | `astra comic doctor`（目录、源连通、Komiic 剩余额度） |

## 流程

1. 只给作品名 → `astra comic info <作品名>`。完全同名就直接出结果；报 `AMBIGUOUS` 时把
   `error.details.candidates` 列给用户选，再加 `--pick <n>` 或用链接。
2. 看 `groups`：一般用户要「全部」时优先 **单行本**（卷数少、图全）；要最新进度才用 **单话 / 连载**。
3. `astra comic get ... --group <分组> [--range ...]`，把任务 id 告诉用户。
4. **被限流时任务自己等**，不用到点 `job resume`：拷贝漫画 code 210 / Komiic 额度用完时，任务停在 `running`，
   `astra comic job <id>` 的 `data.waiting` 写着在等哪个源、等到几点（`until`，ISO 时间），过点自动接着下。
   **整本只在结束时通知一次**，中间不会再一卷一条。用户问进度就报 `done/total` 和 `waiting.until`。
   只有同一话连续 6 次等完还被拒（一页没下到）才记失败，这时才需要 `job resume`。
   Komiic 额度要等约一天：整部要得急就用 `--source copymanga`，或先 `job cancel` 换源重下（已下的页会跳过）。

## 两个源

| 源 | 特点 | 限制 |
|-|-|-|
| `komiic` | 繁体，单行本 + 单话 | 匿名每 IP 约 300 张 / 天，约 24 小时重置 |
| `copymanga` | 作品最全，连载 / 单行本 / 翻译组 | 没有额度；请求太密会被判 code 210，约 1 小时自动解除 |

一卷单行本 150–180 张：Komiic 一天只够两卷左右，整部优先用 `--source copymanga`。
拷贝漫画被限流时换 `--source komiic` 能先下一部分。

## 落盘

- `comic.dir` / `ASTRA_COMIC_DIR`：`<作品>/<分组>/<第01卷|第01话>/001.jpg`，`--cbz` 另在旁边打 `第01卷.cbz`
- 已存在、且是完整图片的页会跳过；同一条命令重跑是安全的
- 下完登记进资产库（`astra lib find <作品名>`）

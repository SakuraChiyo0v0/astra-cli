---
name: astra-comic
description: Download comics/manga albums to the NAS by album id or search.
version: 0.1.0
author: SakuraChiyo0v0, Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Comic, Manga, Download]
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

用 `astra` CLI 按车号或关键词下载漫画到 NAS。自动解混淆、按章节落盘。
不依赖本机其它下载容器。

## When to Use

- 用户说"下这个本 / 下漫画 / 存一下"并给了车号、JM 号或链接
- 用户给了漫画标题，需要先搜再下
- 用户问某本有几话、叫什么名字

## Prerequisites

`astra` 在 PATH 里，并且装了 **ffmpeg**（解混淆用，和 B 站共用）。
`astra comic doctor` 能看到目录与上游是否可用。

## How to Run

stdout 只有一个 JSON。`ok:true` 看 `data`，`ok:false` 看 `error.code` / `error.message` / `error.hint`。

## Quick Reference

| 想做的事 | 命令 |
|-|-|
| 下载整本 | `astra comic get <车号\|链接>` |
| 只下一话 | `astra comic get <车号> --chapter 3` |
| 先看信息 | `astra comic info <车号\|链接>` |
| 搜标题 / 正文 | `astra comic search <关键词>` |
| 按标签 / 作者 / 角色 | `astra comic search <词> --scope tag`（还有 `author` / `actor` / `work`） |
| 自检 | `astra comic doctor` |

## Procedure

1. 用户给车号或链接 → 直接 `astra comic get <...>`。
2. 用户只给标题 → `astra comic search <标题>`。点名标签、作者或角色时加 `--scope tag|author|actor`：
   - 有 `redirectId` 或只有一条 → 用那个 id 再 `get`
   - 多条 → 把 `items`（id / title / author）列给用户选，**不要替用户挑**
3. `data.status`：
   - `downloaded`：下好了，可报章节数与目录
   - `already_have`：本地已有，没重复下
4. 失败看 `error.hint`；网络类可稍后重试。

## Notes

- 落盘：`comic.dir` / `ASTRA_COMIC_DIR`，默认模板 `{id} {title}/{chapter:02}/{page:03}.{ext}`
- 解混淆需要 ffmpeg；缺了用 `astra comic doctor` 看

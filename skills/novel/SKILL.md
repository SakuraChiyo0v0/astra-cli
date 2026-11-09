---
name: astra-novel
description: Find novels by title and save them to the NAS as EPUB with the astra CLI; follow ongoing serials.
version: 0.1.0
author: SakuraChiyo0v0
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Novel, EPUB, LightNovel, NAS]
    category: media
---

# Astra Novel Skill

用 `astra novel` 按书名找小说，打成 EPUB 落到 NAS（`/volume1/小说/<书名>/<书名>.epub`），登记进资产库。

## When to Use

- 用户说「下这本小说 / 找这本书 / 存成 epub」，给了书名、作者或链接
- 用户想追一本连载（有新章节就更新）
- 用户问某本书有几卷、多少章

不适用：漫画用 `astra comic`、本子用 `astra jm`；有声书/音乐用 `astra music`。

## 书源

| 书源 | 收什么 | 语言 | 找书 |
|-|-|-|-|
| `8novel` | 日本轻小说，分卷齐全 | 繁体 | 站内搜索 |
| `lnovel` | 日本轻小说 | 繁体 | **不能搜**，只认书号 / 链接 |
| `kanunu`（努努书坊） | 出版读物：国内外文学、推理、科幻、武侠 | 简体 | 本地索引（约 8,700 本） |

搜索三家一起搜，繁简互通（「活著」能搜到「活着」）。

## Quick Reference

| 想做的事 | 命令 |
|-|-|
| 按书名搜 | `astra novel search <书名>` |
| 看书的信息、分卷 | `astra novel info <书名\|链接>` |
| 下载 | `astra novel get <书名\|链接> --wait 300` |
| 多卷书只要一卷 | `astra novel get <链接> --volume 2` |
| 多卷合一本 | `astra novel get <链接> --volume all` |
| 转简体 | 加 `--simplified` |
| 看任务 / 重试 | `astra novel job <id>` / `astra novel job resume <id>` |
| 追更 | `astra novel subscribe add <链接> --volume <n>` |
| 检查追更 | `astra novel subscribe run --notify` |
| 自检 | `astra novel doctor` |

## Procedure

1. 用户给书名 → `astra novel get <书名> --wait 300`。
   - 书名**完全一致且只有一条**才会自动选，直接开始下载
   - 否则返回 `error.code = AMBIGUOUS`，`error.details.candidates` 是候选（n / source / title / author）。
     **列给用户选，不要替用户挑**；选好后加 `--pick <n>` 再跑一次
2. 返回 `AMBIGUOUS_VOLUME`：日轻每卷是单独一本书，`error.details.volumes` 是卷列表（n / title / chapters）。
   问用户要哪一卷，或 `--volume all` 合成一本。
3. 任务跑完看 `data.job.status`：
   - `done`：`data.job.output` 有 `path` / `chapters` / `chars` / `images`，报给用户
   - `partial`：有章节没取到，**没有出书**（半本书比没有更糟）；`astra novel job resume <id>` 补齐后自动出书
   - 还在跑（`--wait` 到时）：`astra novel job <id> --wait 300` 接着等
4. 回话报：书名、章节数、字数、插图数、路径。轻小说插图数为 0 时提一句（正常应该有）。

## 错误码

| code | 意思 | 下一步 |
|-|-|-|
| `NOT_FOUND` | 三家都没搜到 | 换关键词（日文原名 / 台版译名 / 作者）；努努书坊的书可以直接给链接 |
| `AMBIGUOUS` | 多个候选 | 让用户选 → `--pick` |
| `AMBIGUOUS_VOLUME` | 多卷没选卷 | 让用户选 → `--volume` |
| `NOVEL_TAKEN_DOWN` | 这一卷在这个书源下架了（正文只剩版权提示） | 换书源搜同名书 |
| `NOVEL_SITE_CHANGED` | 站点改版，解析不了 | 告诉用户这个书源暂时坏了，换书源 |
| `NOVEL_INCOMPLETE` | 打包时还缺章 | `job resume` |

## 追更

```bash
astra novel subscribe add <链接> --volume 3     # 当前章节记为基线，不会重下
astra schedule add novel-sub --every 12h --cmd "novel subscribe run --notify"
```

有新章节时开一个普通下载任务：旧章节走缓存（skipped），只抓新的，再整本重出覆盖旧 EPUB。

## Notes

- 落盘：`novel.dir`（NAS 上设成 `/host-root/volume1/小说`），模板 `novel.template`（默认 `{title}/{title}.epub`）
- 章节缓存在 `<ASTRA_HOME>/novel/cache/`，中断后只补缺的章；删掉缓存会整本重抓
- 三个站都要走代理：`proxy.include` 里要有 `8novel.com,kanunu8.com,lnovel.tw`（努努书坊直连不通，8novel 直连 403）
- 繁转简是逐字 + 常用词组（数据来自 OpenCC），个别一字多义可能转错；用户要简体时提一句
- 努努书坊索引 7 天算过期，`astra novel index --rebuild` 后台重建，约 10 分钟
- 图片 WebP 会转成 JPEG（老阅读器不认 WebP），需要 ffmpeg；缺了只是插图转不了
- 8novel 正文里的同形字水印（「⑧ΝОνЕ┕。Сοм」之类）会自动删掉

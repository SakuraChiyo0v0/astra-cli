---
name: astra-bili
description: Download Bilibili videos and audio to the NAS.
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
| 把图存下来 | 上面两条加 `--images --out <目录>` |

## Procedure

1. 用户发链接时，原样交给 `astra bili get <链接>`。
2. 看 `data.results`：
   - `downgraded: true` 表示**实际画质低于请求**。这时要明确告诉用户"你请求 1080P，实际只拿到 360P"，
     并说明原因：**未登录时 B 站封顶 360P**，登录（尤其大会员）才可能拿到 1080P60 / 4K。
   - 多分 P 时会返回 `warnings` 提示"只下了第 1 个"。用户要全部时用 `--page 1-10` 或逐个指定——
     **不要自作主张一次下几百集**，先问清楚。
3. 下载完成后告诉用户：文件路径、实际分辨率、时长、大小。

## 抓图文（dyn / album）

两个接口的可靠性差一个量级，别混用：

| 命令 | 接口 | 给什么 | 稳定性 |
|-|-|-|-|
| `bili album` | `draw/doc_list` | **完整图集**（官方号实测 1920×1080、1080×2853 竖版海报） | 免签名免登录，实测无风控 |
| `bili dyn` | `opus/feed/space` | 正文 + **一张封面图**，**无发布时间** | 要 buvid + wbi，有频率风控 |

**要官方高清图优先用 `album`**：`astra bili album mid:1636034895 --limit 40 --images --out /path`
（1636034895 是绝区零官号）。`dyn` 更适合要**文案**的场景，图片只是封面。

## Pitfalls

- **未登录画质封顶 360P**，这不是 bug。想拿高画质需要 `astra bili login start` 扫码（二维码是 PNG，
  用 `MEDIA:<data.qrImage>` 发图，然后轮询 `astra bili login poll`）。
- 多分 P 视频默认**只下第 1 个**，避免一口气下几百集。
- `BILI_API_ERROR` 里 code `-403` 是私密或地区限制，`-404` 是视频不存在。
- 番剧 / 部分老视频没有 DASH 分轨，成品可能画质选项少，`warnings` 会说明。
- 下载体积可能很大（4K 一集几百 MB），用户没说要高画质时默认 1080p 就够。
- **`dyn` 和 `album` 别指望有日期**：`opus` 接口 `pub_time` 恒空、`opus/detail` 被 -352 挡，
  所以 `dyn` 的 `date` 是 null、存图名是 `undated_<opusId>_<n>`；`album` 有 `ctime`。
- **`dyn` 报 `BILI_DYN_RISK`** 是频率风控，等几分钟再试；抓几百张图时用 `album`（无风控），
  大批量抓完再抓动态，否则会把动态接口打到 -412。

## Verification

`astra bili doctor` 里 api 和 ffmpeg 都是 ok。下载完成后 `data.results.durationSec` 与分 P 记录的时长一致。

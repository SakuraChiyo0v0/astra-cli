---
name: astra-lib
description: Find, scan and verify media already stored by astra (music, video, pixiv, comics).
version: 0.1.0
author: SakuraChiyo0v0, Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Library, Files, Search]
    category: media
prerequisites:
  commands: [astra]
required_environment_variables:
  - name: ASTRA_HOME
    prompt: astra 数据目录
    help: 部署时在容器环境里设好，例如 /opt/astra/home。资产库和 db-url 都在这里。
---

# Astra Library Skill

用 `astra lib` 查「文件在哪、还在不在、是不是同一份」。
它不下载。下载仍走 `music get` / `bili get` / `pixiv pull` / `comic get`，那些命令落盘后会自己登记。

数据库本身的迁移、备份、切换 PostgreSQL 用 `astra db`，不在这里。

## When to Use

- 用户问某首歌、某个视频、某张图、某本漫画在哪个目录
- 用户说文件挪过位置、换过盘，要确认库还能对上
- 用户怀疑图是坏的、下到一半，或想知道有没有重复文件占空间
- 盘上已有一批旧文件（尤其漫画），库里还搜不到

## How to Run

stdout 只有一个 JSON。`ok:true` 看 `data`，`ok:false` 看 `error.code` / `error.message` / `error.hint`。
`error.code` 为 `CONFIG` 且 hint 写着先跑 `astra db migrate` 时，先迁移再重试，不要自己改库。

## Quick Reference

| 想做的事 | 命令 |
|-|-|
| 按现有配置登记存储根 | `astra lib root auto` |
| 看有哪些根 | `astra lib root list` |
| 加一个根 | `astra lib root add <标签> <绝对路径>` |
| 文件挪了之后对账 | `astra lib scan`（可加 `--root <标签>`） |
| 按标题 / 作者 / 路径 / 平台 id 搜 | `astra lib find <关键词>` |
| 某个资产在哪些路径 | `astra lib where <资产id>` |
| 抽样确认内容和记录一致 | `astra lib verify`（可加 `--root`、`--sample`、`--max-mb`） |
| 找重复内容（只报告） | `astra lib dupes` |
| 把盘上还没入库的文件认领进来 | `astra lib adopt`（先 `--dry-run`） |
| 数量和丢失概览 | `astra lib stats` |

## Procedure

1. `lib find` / `lib scan` 报还没初始化：跑 `astra db migrate`，再 `astra lib root auto`。
2. 用户要找东西：`astra lib find <词>`。结果里的 `rel_path` 是相对某个 root 的位置，配 `lib where <id>` 看状态。
3. 用户刚在系统里挪过文件：`astra lib scan`。同盘改名靠 inode，跨目录靠指纹；扫不到的标 `missing`，不删记录。
4. 用户怀疑文件坏了或被换过：`astra lib verify`。它算整文件哈希，比 scan 严。超过 `--max-mb`（默认 512）的大文件会跳过。
5. 用户问能不能腾出空间：`astra lib dupes` 给出重复组和 `wastedBytes`。**不要删文件**，把清单给用户决定。
6. 盘上有、库里没有（`lib scan` 的 orphan，或用户说旧漫画搜不到）：`astra lib adopt --dry-run` 看规模，用户同意后再去掉 `--dry-run`。
   - 同目录有 `.astra-comic.json` 的页会记成 `comic:<本子id>_c<话数>_p<页码>`，不用重下。
   - 带 BV 号的 `.nfo` 记成 `bili:<BV>_p1`。
   - 其余用内容指纹，挪位置不会变成两条。

## Notes

- `lib where` 会顺手核对磁盘：文件还在就标回 present，不在就标 missing。找新位置要再 `lib scan`。
- `lib root rm` 在还有文件记录时会拒绝。
- 漫画下载若页是截断的，`comic get` 不会把它算成 already_have，也不会把坏图留在目录里。

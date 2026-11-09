---
name: astra-lib
description: Find, scan and verify media already stored by astra (music, video, pixiv, comics, ebooks).
version: 0.2.0
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
它不下载。下载仍走 `music get` / `bili get` / `pixiv pull` / `comic get` / `novel get`，那些命令落盘后会自己登记
（前提是落盘目录在某个 root 里；不在的话结果里会有 warning，`lib root auto` 后再 `lib adopt`）。

数据库本身的迁移、备份、切换 PostgreSQL 用 `astra db`，不在这里。

## When to Use

- 用户问某首歌、某个视频、某张图、某本漫画、某本小说在哪个目录
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
| 对账并顺手把新文件收编 | `astra lib scan --adopt` |
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
   想让它自己发生就用 `astra lib scan --adopt`（认领规则与 `adopt` 完全相同，幂等；巡检 cron 就是这么跑的）。
   混合目录（图片和视频混在一起）**不要带 `--kind`**，否则另一类会被漏掉（`--kind` 可选 `video` / `audio` / `image` / `ebook`）。
   - 同目录有 `.astra-jm.json`（旧名 `.astra-comic.json`）的页会记成 `jm:<本子id>_c<话数>_p<页码>`，不用重下。
   - 带 BV 号的 `.nfo` 记成 `bili:<BV>_p1`。
   - `.epub` 记成 `ebook` 类；小说域下载的书走 `novel-<书源>:<书号>`，其余 epub 用指纹。
   - 其余用内容指纹，挪位置不会变成两条。

## 作品元数据（标题 / 收藏 / 标签）不在 `astra lib` 里

`astra lib` 只管「文件在哪、还在不在」，**不存作品的标题、作者、收藏数、标签**。
Pixiv 那批图要按收藏数/标签/作者检索时，元数据在 PostgreSQL 的 `crawl.pixiv_illust`：

```bash
python3 /opt/data/scripts/pixiv_meta.py --status          # 磁盘 N / 库里 M / 待补 X
python3 /opt/data/scripts/pixiv_meta.py --backfill 20     # 存量补 20 个（限速 2s/个）
python3 /opt/data/scripts/pixiv_meta.py --ids <id>...     # 新下载后随手补
```

- 回填队列**每次现场算**（磁盘 id 集合 − PG 已有 id），可重入，不维护游标；
  `pixiv-meta-backfill.sh` 每 10 分钟跑 20 个，成功静默。
- `pixiv_daily.py` / `pixiv_r18_daily.py` 下载完成后会**异步**调 `record_meta()`，别改成串行（50 张图要 4 分钟）。
- **任何新写的下载/挑图脚本都必须自己调 `record_meta(ids)`**：漏了不报错，只是靠 10 分钟一次的
  `pixiv-meta-backfill` 慢慢补，「信息入库」就成了「过一阵才入库」；`pixiv_char_send.py` 就是这样漏过一轮。
- **回填失败不代表作品已删**：pixiv 在大请求量后会软限流，`/ajax/illust/<id>` 对**所有**作品都回
  「出现错误。请稍后再试」（含刚查成功过的 id）。处置：`cronjob_manage pause` 掉回填任务避免给冷却续命，
  隔 30–100 分钟用单个探针复测；冷却期间报「这些是已删除」会被复测当场打脸。
- 浏览量（view count）拿不到，能比的是 `bookmarks`。
- 细节（表结构、COPY 写法、查询示例、坑）见 `references/pixiv-metadata-pg.md`。

### 画质治理：只修「下错了档」，不替用户判质量

`astra pixiv pull` 默认落的是 `large`（长边约 1200），所以库里大量短边 848/900 的图，
**这是下载档位问题，不是作品差**。用 PG 里的 `original_url` 重下原图原地替换即可：

```bash
python3 /opt/data/scripts/pixiv_quality.py --redownload 20   # 挑 20 个低清的原地替换（同名同目录）
python3 /opt/data/scripts/pixiv_quality.py --rescan          # 扫磁盘算 short_side 写回 PG
python3 /opt/data/scripts/pixiv_quality.py --report          # 低清样本
```

- 原图下载**必须带 `Referer: https://www.pixiv.net/` 并走代理**，否则 403；多页把 `_p0.` 换成 `_pN.`。
- **有些作品的原图本身就小**（重下后仍是 700–1200px）：重下多少次都没用。
  给用户汇报时把两类分开说（「档位问题已修好」vs「原作本身就这么大」），否则会以为重下没生效。
- **不要自动给作品打质量分**：尺寸只说明清晰度，说明不了画得好不好。用户明确否决过
  「按短边/收藏自动分 s/a/b/c + 视图过滤展示」这套，已删掉 `quality` 列与 `crawl.pixiv_display` 视图。
  `short_side` / `page_count_on_disk` 作为**客观事实**保留，怎么用由她定。
- 剔除方式：`hidden` 列只在她**圈定之后**由脚本写入；任何自动逻辑都不许写这一列。
- 细节（重下流程、短边计算、队列坑）见 `references/pixiv-metadata-pg.md`。

## Notes

- `lib where` 会顺手核对磁盘：文件还在就标回 present，不在就标 missing。找新位置要再 `lib scan`。
- `scan` 的 `missing` 只报**刚刚丢失**的那一次；已经 missing 的记录不会每轮重复上报（要查全部缺口用
  `astra db query "select rel_path from files where state = 'missing'"`）。文件回来会自动 `revived`。
- `lib root rm` 在还有文件记录时会拒绝。
- 漫画下载若页是截断的，`comic get` 不会把它算成 already_have，也不会把坏图留在目录里。

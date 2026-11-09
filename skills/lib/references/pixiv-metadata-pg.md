# Pixiv 作品元数据 → PostgreSQL

图的落盘命名只有 `<illustId>_p<N>.png`（按 `<userId>/` 分目录），**标题、作者、收藏数、标签都不在磁盘上**。
`astra.db` 的 `assets` 表对 pixiv 基本是空的（`meta` 只有 `illustId/page/userId/quality`），PG 里原本也没有 pixiv 表。
要按「收藏数 / 标签 / 作者」检索或挑图，就得自己补一份元数据。

## 存在哪

PostgreSQL 容器 `postgres`（user `astra` / db `postgres`），表 `crawl.pixiv_illust`（和 `crawl.bili_*`、`crawl.douyin_*` 放一起）：

```sql
illust_id bigint primary key, title text, user_id bigint, user_name text,
pages int, size text, sl int, x_restrict int, r18 boolean, bookmarks int,
tags jsonb, original_url text, first_seen timestamptz, fetched_at timestamptz
-- 索引: (user_id), (bookmarks DESC NULLS LAST)
```

`first_seen` 只在首次入库时写，回填重跑不会覆盖；`fetched_at` 每次刷新。

## 脚本

`/opt/data/scripts/pixiv_meta.py`（可直接跑，也可被下载流程调用）：

```bash
python3 /opt/data/scripts/pixiv_meta.py --status              # 磁盘 N 个 / 库里 M 条 / 待补 X
python3 /opt/data/scripts/pixiv_meta.py --id 151527031        # 单个（--id 可重复）
python3 /opt/data/scripts/pixiv_meta.py --ids 1 2 3 --sleep 1  # 下载后批量补
python3 /opt/data/scripts/pixiv_meta.py --backfill 20         # 从存量队列补 20 个
```

数据源是 `astra pixiv info <id>`（复用 astra 的 cookie 与代理，不自己拼 API），返回可用字段：
`illustId/title/userId/userName/pages/size/sl/xRestrict/r18/bookmarks/tags/original`。
**浏览量拿不到**（Pixiv 不对外给 view count），能比的是收藏数。

## 入库存量：队列现场算，不落状态文件

```python
queue = disk_ids() - known_ids()   # 扫磁盘文件名 + 查 PG 主键
```

好处是可重入：中断、重跑、两个任务重叠都不会重复拉取，也不需要维护 cursor 文件。

- 磁盘要扫**两个根**：`/host-root/volume1/图片/pixiv` 和敏感库
  `/host-root/volume1/@home/KAngel/不要进来哇！/pixiv`；id 正则 `^(\d+)_p\d+\.`。
- 限速**2 秒/个**（≈30/分钟），比速度重要；单个 astra 调用本身就要 4–5 秒。
- 1000 个作品按 20 个/10 分钟跑，约 8–9 小时；跑不完下一轮接着补。

## 回填定时任务

`~/profiles/demo/scripts/pixiv-meta-backfill.sh` → 每 10 分钟 `--backfill 20`，
`no_agent=True` + `deliver='local'`，**成功时 stdout 为空**（不推送），失败才吐最后几行日志到
`/opt/data/logs/pixiv-meta-backfill.log`。

## 下载时顺手记（新图）

`pixiv_daily.py` / `pixiv_r18_daily.py` 在「取图完成」后调用 `record_meta(ids)`：

```python
subprocess.Popen(["/opt/hermes/.venv/bin/python", "/opt/data/scripts/pixiv_meta.py",
                  "--ids", *ids, "--sleep", "1"],
                 stdout=open("/opt/data/logs/pixiv-meta-inline.log", "a"),
                 stderr=subprocess.STDOUT, start_new_session=True)
```

**必须异步**：一张图 5 秒，50 张就是 4 分钟，串在发图前面会让日报迟到。

## 写库的技术点（容器里没有 psycopg）

只能 `docker exec -i postgres psql`，而且 **`psql -c` 带不了内联 COPY 数据**：
把 `COPY ... FROM STDIN;` 和数据一起塞进 `-c`，psql 会把紧随其后的 `INSERT ...` 当成第一行数据，
报 `invalid input syntax for type bigint: "INSERT INTO ..."`。
正确做法是把整段脚本（建临时表 → `COPY FROM STDIN` → 数据 → `\.` → `INSERT ... ON CONFLICT`）
写到 psql 的 **stdin**，不加 `-c`：

```python
script = "DROP TABLE IF EXISTS _stage;\nCREATE TEMP TABLE _stage (LIKE crawl.pixiv_illust);\n"
script += "COPY _stage (...) FROM STDIN;\n" + tsv_data + "\\.\nINSERT INTO ... ON CONFLICT ...;"
subprocess.run(["docker","exec","-i","postgres","psql","-U","astra","-d","postgres",
                "-v","ON_ERROR_STOP=1","-q"], input=script, capture_output=True, text=True)
```

- TSV 里要转义 `\\`、`\t`、`\n`，空值写 `\N`；`tags` 以 JSON 字符串进 `jsonb`，避免引号拼接。
- 中文标题走 COPY 不会被 shell 二次转义，别为了「稳妥」改成逐条 `INSERT` 拼字符串。

## 查询示例

```sql
-- 全库收藏 Top20
select illust_id,title,user_name,bookmarks from crawl.pixiv_illust
 order by bookmarks desc nulls last limit 20;

-- 某画师收藏最高的 5 张
select illust_id,title,bookmarks from crawl.pixiv_illust
 where user_id = 83739 order by bookmarks desc nulls last limit 5;

-- 按标签找
select illust_id,title,bookmarks from crawl.pixiv_illust
 where tags ? '初音ミク' order by bookmarks desc limit 20;

-- 还没补到的
-- 用 pixiv_meta.py --status，比 SQL 快（它同时扫磁盘）
```

## 坑

- `astra pixiv info` 偶发 `TLS connect error (curl 35)`：代理抖动，重试即可（脚本默认 2 次重试 + 退避）；
  同一时刻 `curl -x http://mihomo:7890 https://www.pixiv.net/` 若返回 200，就确认是瞬时问题而不是 cookie 失效。
- 想「先下一遍再抽元数据」是最慢的路：`info` 一次请求就够，**不要为了元数据重新下载**。
## 重下原图（pixiv_quality.py）

表上只挂**客观字段**，不挂质量评分：

```sql
short_side int, page_count_on_disk int, scanned_at timestamptz,
hidden boolean NOT NULL DEFAULT false
-- 没有 quality 列，也没有 crawl.pixiv_display 视图（用户否决了自动分级）
```

`short_side` 取整卷各页的 `min(w,h)` 再取最小 —— 多页作品只要有一页是小的，整卷都算小。

```bash
python3 /opt/data/scripts/pixiv_quality.py --redownload 20   # 按 original_url 重下原图，原地替换
python3 /opt/data/scripts/pixiv_quality.py --rescan          # 重算短边写回
python3 /opt/data/scripts/pixiv_quality.py --report
```

重下原图：`https://i.pximg.net/img-original/...`，**必须走代理 + `Referer: https://www.pixiv.net/`**，
否则 403；多页把 `_p0.` 换成 `_pN.`。先下到 `.dl` 临时文件，确认新尺寸不小于旧图再 `os.replace`，
失败就把临时文件删掉（不要留下半张）。扩展名跟着原图走：`.png → .jpg` 时用新扩展名存、删旧文件。

**关键预期管理**：重下只修「当初下成 large」的那批（能从 848 涨到 2480/3507）。
有些画师上传的原图本身就小，重下后仍是 700–1200 —— 这类重下救不了。

**不要自己发明质量评分。** 用户明确说过「光从尺寸肯定没办法得知具体质量」，
她否决了按短边/收藏分 s/a/b/c 再做展示视图的做法（已删）。正确分工：
脚本只负责「重下原图 + 记录短边」这类客观事实，**哪张算好、要不要剔除由她自己圈**；
`hidden` 列只用于承接她圈出的结果，不写任何自动逻辑。

## 队列判断的坑（会让回填永远空转）

`known_ids()` 必须用 `WHERE title IS NOT NULL`，**不能只判「这一行在不在」**。
`--rescan` 会先把磁盘上所有 id 插成「只有 short_side/quality、没有 title」的行；
若队列按行存在判断，`--status` 会显示「待补 0 个」，cron 每轮空跑，元数据永远补不进来。
排查时的判据就是这一对数字：**库里有 N 行但 `title is null` 的还有 M 个**，M>0 而 status 说待补 0 就是踩了这个坑。

- 8788/公司网关无关：这条链路只走 astra + pixiv，别去 grep model-gateway 日志。

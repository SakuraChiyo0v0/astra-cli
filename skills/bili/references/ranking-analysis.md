# 榜单数据分析配方

数据在 PG `crawl` schema（`bili_video` / `bili_rank_entry` / `bili_popular` / `bili_weekly`）。
统一用 `astra db query "..."` 跑，加 `--limit` 控制返回行数。

## 口径提醒（先读再下结论）

- 综合榜排名是**相对位置**，不是热度分数；跨天比 rank 无意义，要看 `view` 绝对值或增量。
- 综合榜不返回 `score`，别自己编「综合分」。
- 热门榜只覆盖最近约 7 天，且约 68% 是最近两天 —— 它衡量「短期爆发」，不是历史累积。
- 影视 / 纪录片分区的综合榜大量是官方号（哔哩哔哩电影 / 纪录片、迷影社），
  做「UP 主竞争」类结论前先把这类账号排除，否则结论会被片库条目带偏。

## 常用配方

投币率（观众付费意愿，比播放量更能区分内容类型）：

```sql
select v.title, v.owner, p.coin, p.view,
       round(100.0 * p.coin / nullif(p.view, 0), 2) rate
from crawl.bili_popular p join crawl.bili_video v using (bvid)
where p.view > 100000
order by rate desc limit 10;
```

双榜重叠（平台推荐 ∩ 观众实际观看）：

```sql
select p.tname, count(*) n
from crawl.bili_popular p
where p.bvid in (select bvid from crawl.bili_rank_entry)
group by 1 order by n desc;
```

时长分布（综合榜偏短视频，但长内容并非不能上）：

```sql
select case
         when duration < 60 then '<1分'
         when duration < 300 then '1-5分'
         when duration < 600 then '5-10分'
         when duration < 1200 then '10-20分'
         when duration < 3600 then '20-60分'
         else '>1小时' end bucket,
       count(*) n
from crawl.bili_rank_entry group by 1 order by n desc;
```

UP 霸榜（同一账号在多个分区重复出现 = 官方号/片库）：

```sql
select v.owner, count(distinct e.bvid) videos, count(distinct e.rid) zones
from crawl.bili_rank_entry e join crawl.bili_video v using (bvid)
group by 1 order by videos desc limit 10;
```

周榜更替（重复上榜的「常青款」，实测 8 期内基本没有重复）：

```sql
select v.title, v.owner, count(distinct w.issue) times
from crawl.bili_weekly w join crawl.bili_video v using (bvid)
group by 1, 2 having count(distinct w.issue) > 1 order by times desc;
```

热门榜新鲜度（判断「这份快照能代表多久」）：

```sql
select pubdate::text d, count(*) n
from crawl.bili_popular group by 1 order by 1 desc limit 10;
```

## 关注 / 粉丝关系

`/x/relation/stat` 给三个数（免签），列表走 `followings` / `fans`（要登录 cookie，`ps` 最大 50）。
分类只能靠账号名 + `sign` 做关键词粗筛（游戏 / 知识 / 官方 / 音乐…），要准确画像得逐账号拉详情，
434 个关注 ≈ 434 次请求（3 秒间隔 ≈ 20 分钟），先问用户值不值得再跑。

---
name: astra-hupu
description: 用 astra hupu 读虎扑帖子正文、板块列表、热帖榜；只读、匿名、带本地库缓存。
---

# 虎扑（`astra hupu`）

用户丢虎扑链接、问「今天步行街有什么」、要看某帖正文时用。只读，不需要登录或代理。

## 命令

```bash
astra hupu list --board bxj --n 20 --table     # 列表：bxj 步行街 / nba / cba / topic-daily 热帖榜
astra hupu post 643975554 --chars 1200         # 正文；也接受整条链接
astra hupu post <id> --refresh                 # 忽略缓存重抓
astra hupu find 房价 --table                   # 只搜本地库，不打网络
astra hupu boards --table                      # 板块路径与是否实测过
astra hupu doctor --table                      # 自检：列表 + 第一篇详情
```

## 口径

- **默认先查库**：`post` 命中 `crawl.hupu_post` 就不发请求，返回 `source: "cache"`；要最新内容加 `--refresh`
- `author` / `views` / `replies` 取不到时是 `null`——页面结构变动时宁可空着，不猜
- 纯图帖 `content` 为空，看 `images` 计数
- 列表类返回带 `returned` / `truncated`；`find` 另有 `total`（库内总量），报数用 total
- **不做**：回帖（页面异步加载）、搜索（App 签名）、发帖点亮（要登录态）
- 报 `HUPU_BLOCKED` = 撞上人机验证，等几分钟再试，不会自动重试
- 频率：列表不缓存（内容一直在变），批量抓取自己控间隔；实测 0.6~0.8s 间隔连打 5~8 次都正常，长期阈值未知，别当成许可去刷

## 常见追问

- 「这条链接讲了什么」→ `post <链接>`，正文太长用 `--chars` 截
- 「我之前存过的帖子」→ `find <关键词>`（只能搜抓过的）
- 「某个板块」→ `list --board <路径>`；路径不在 `boards` 里也能试着传，打不开就换

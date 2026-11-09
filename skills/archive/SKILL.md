---
name: astra-archive
description: Incrementally copy Hermes chat history into the astra Postgres database.
version: 0.1.0
author: SakuraChiyo0v0
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Archive, Postgres, Painting]
    category: operations
prerequisites:
  commands: [astra]
---

# 把 Hermes 会话写进 Postgres

绘画记录和其它对话都在 Hermes 的 `state.db` 里。`astra archive sync` 把它增量写进 astra 正在用的 Postgres（`hermes.sessions` / `hermes.messages`），不碰资产表。

## When to Use

- 定时把新对话补进数据库。已有「导出会话文件」的 cron 时，在它后面加这一条
- 用户说绘画历史、会话存档要进库

## 命令

```sh
astra db migrate
astra archive sync
```

没变化的会话会跳过。对话整段存进去，不再按绘画或闲聊分类。

`文档/AI绘图` 里的清单会写入 `hermes.documents`。

## 定时

每天会话文件导出之后再跑一次即可，不必每条消息写一次：

```sh
python3 /opt/data/scripts/archive_sessions.py
astra archive sync
```

失败只记日志，不要给用户发完成通知。

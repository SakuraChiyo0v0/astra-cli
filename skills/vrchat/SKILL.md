---
name: astra-vrchat
description: Check VRChat friends, worlds and notifications.
version: 0.8.5
author: SakuraChiyo0v0, Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [VRChat, Social, Friends]
    category: social
prerequisites:
  commands: [astra]
required_environment_variables:
  - name: ASTRA_HOME
    prompt: astra 数据目录
    help: 部署时在容器环境里设好，例如 /opt/astra/home
---

# Astra VRChat Skill

用 `astra vr` 查 VRChat 账号状态、好友、世界、通知和群组。**写操作**（加好友、收藏、
改状态、邀请）一律需要用户二次确认，不能一句话就执行。

## When to Use

- 用户问"谁在线 / 我的好友在玩什么 / 有谁找我"
- 用户要看某个世界、某个实例里有谁
- 用户要加好友、收藏世界、改状态、发邀请（写操作，必须走确认流程）

## Prerequisites

已登录：`astra vr account` 返回 `loggedIn: true`。没登录就 `astra vr login --username <账号> --password <密码>`，
开了两步验证时用 `astra vr login --code <验证码>` 补上。

## How to Run

stdout 只有一个 JSON，`ok: false` 时看 `error.code` / `error.hint`。

## Quick Reference

| 想做的事 | 命令 |
|-|-|
| 登录 / 两步验证 | `astra vr login --username <账号> --password <密码>`；`astra vr login --code 123456` |
| 登录状态与资料 | `astra vr account` |
| 好友 | `astra vr friends`；只看在线的加 `--online` |
| 通知 | `astra vr notifications [--unread]` |
| 世界详情 | `astra vr world <wrld_xxx> [--instances]` |
| 搜世界 | `astra vr worlds search <关键词>` |
| 实例里有谁 | `astra vr instance <wrld_xxx:instance>` |
| 我的群组 | `astra vr groups`；搜群组 `astra vr groups search <词>` |
| 群组详情 | `astra vr groups info <grp_xxx>`（成员/角色/启用权限/公告） |
| 某人在群里吗 | `astra vr groups member <grp_xxx> <usr_xxx>` |
| 头像 | `astra vr avatars` |
| 收藏 | `astra vr favorites [--type world\|avatar\|friend]` |
| 余额 / 订阅 / 收藏上限 | `astra vr economy` |
| 交易明细 | `astra vr transactions [--limit 20]` |
| 在线人数 / 上游时间 | `astra vr system`（不用登录） |
| 平台权限位清单 | `astra vr permissions [--id <id>]` |
| 自检 | `astra vr doctor` |

## 写操作：必须先预览再确认

**绝不能跳过确认。** 流程固定两步：

1. 先跑不带 `--confirm` 的版本，例如 `astra vr friends request usr_xxx`。
   它**不执行**，只返回 `status: needs_confirmation`、`token` 和 `preview`。
2. 把 `preview` 告诉用户，明确问一句"要这么做吗"。
3. 用户同意后，用返回的 token 再跑一次：`astra vr friends request usr_xxx --confirm <token>`。
   令牌 5 分钟有效、只能用一次。

支持这几种：

| 操作 | 命令 |
|-|-|
| 加好友 | `astra vr friends request <usr_xxx>` |
| 删好友 | `astra vr friends remove <usr_xxx>`（会先确认这人确实是好友） |
| 收藏世界 | `astra vr favorites add <wrld_xxx> [--type world] [--group 分组名]` |
| 取消收藏 | `astra vr favorites remove <fvrt_xxx>`（收藏记录 id，不是世界 id） |
| 邀请好友 | `astra vr invites send <usr_xxx> <wrld_xxx:instance>` |
| 改状态 | `astra vr status set "<offline\|active\|busy\|join me\|ask me>" [--description 文字]` |
| 通知已读 | `astra vr notifications read <通知id>` 或 `--all` |
| 建收藏分组 | `astra vr favorites groups create <分组名> [--type world] [--private]` |
| 删收藏分组 | `astra vr favorites groups delete <分组名>`（会先说有里面有几个收藏） |
| 换头像 | `astra vr avatars select <avtr_xxx>` |
| 设回退头像 | `astra vr avatars fallback <avtr_xxx>` |
| 加群 | `astra vr groups join <grp_xxx>` |
| 退群 | `astra vr groups leave <grp_xxx>` |

## Pitfalls

- 好友的 `location` 是 `wrld_xxx:12345~region(us)` 这种格式，`worldId` 只是前半段；
  邀请时要用**完整的 location**。
- `offline` / `private` 表示不在公开实例里，不是"没有这个世界"。
- 未登录时大部分查询会报 `VRCHAT_NOT_LOGGED_IN`；只有 `vr doctor` 的 API 探活和登录本身能跑。
- 429 是限流，等一会儿再试，不要连续重试。
- 令牌过期（5 分钟）要重新生成预览，不要试图复用或用旧的。
- `vr permissions` 返回的是**平台定义了哪些权限**，不是"我这个账号有哪些权限"。别把它当后者转述。
- 删收藏分组会连带删掉分组里的收藏，预览里会给出数量，务必转告用户。
- 换头像能不能成功由上游判定（没买、私有、平台不匹配都会失败），失败时如实转告原因。
- **进群 ≠ 已是成员**：需要审批的群，`groups join` 后只是「申请中」。要确认是否真进了，用 `groups member` 再查一次。
- 群组权限（这个群开了哪些）和 `vr permissions`（平台定义了哪些）不是一回事，别混着说。

## Verification

`astra vr account` 返回 `loggedIn: true`，`astra vr doctor` 里 `api` 与 `session` 都是 ok。

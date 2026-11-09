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

## 好友在线情况的汇报形状

用户问“谁在线”时，直接给分组清单，不要贴原始 JSON。固定做法：

1. `astra vr friends --online` 拿全量，`location` 里 `~group(` / `~hidden(` / `region(` 分别对应
   群组实例 / 私密实例 / 公开区服。
2. **worldId 去重后**逐个 `astra vr world <id>` 换世界名（十几个好友通常只对应十个左右世界，
   别一人一次请求）。
3. 输出顺序：先 **`join me` 的人单独一栏**（用户最关心的就是能直接进的那个），
   再按世界分组列出同世界的人（一个世界多人时，用户能看出“这俩在一起”），最后是各自单独的人。
   每行 = 名字 + 世界名 + 实例类型（群组 / 区服 / 私密）+ 签名。
4. **`platform` 是 `standalonewindows` 只能说明是 PC 客户端**，分不出桌面还是 PCVR，别写成“他戴头显”；
   全员都是这个值时可以说一句“都在 PC”。
5. 收尾问一句“要帮你进哪个世界吗”——进世界/邀请是写操作，确认流程见上文。

## Pitfalls

- **两步验证**：`needs_2fa` 返回的 `next` 提示写的是 `astra vr login 2fa <code>`，这个写法**跑不通**（会报
  `INVALID_INPUT 参数太多`）。正确写法是 `astra vr login --code <验证码>`；没有待验证状态时它会报
  `VRCHAT_NO_PENDING_2FA`，这时必须让用户重新跑一次带账号密码的完整登录（中间态只活 5 分钟，且存在
  发起登录那个 ASTRA_HOME 里——用户在宿主机另一个 home 登录时，容器内补验证码是补不上的）。
- 多词状态值要加引号：`astra vr status set "ask me" --description "..."`，不加引号会被当成多余参数。
- **密码绝不经过聊天**，即使用户主动授权也不行：聊天记录会永久落盘。让用户在宿主机终端自己跑登录，
  或自己在 NAS 上写临时 env 文件后用 `source` 方式读取（命令里只出现变量名，不回显），用完立即删。
  邮箱 2FA 验证码可以走聊天（5 分钟过期，泄露风险极小）。
- 用户在宿主机侧登录后，会话文件（`vr-session.json` 等）属主常变成 `root:root 600`，容器内 hermes 用户
  读会报 `EACCES`。修复：`docker run --rm -v <ASTRA_HOME宿主路径>:/fix alpine sh -c 'chown 1000:10 /fix/*-session.json'`
  （1000:10 = hermes:uucp），然后重新验证 `account`。这个坑对 netease/bili/vr 所有 `-session.json` 都适用。
- **好友没有"最近活动"可查**：VRChat 上游不提供好友历史轨迹（去过哪些世界、玩了多久都没有）。
  只能看到此刻的 `status` / `worldId` / `location` / `platform`。用户问"某某最近都干了啥"时，
  直接说清这个限制，然后给当前快照（在哪个世界、PC 还是 VR、公开还是私密实例），不要猜或编造历史。
  真想跟踪就提"定时快照成日志"，让用户决定。
- **`vr world` 的字段在 `data.world` 下面**（`id` / `name` / `authorName` / `description`），
  直接取 `data.name` 会拿到 `None`。批量把好友的 `worldId` 换成世界名时，先对 worldId 去重再循环查，
  别一个好友一次请求。
- 好友在 `hidden(usr_xxx)` 私密实例里时，实例详情查不到（带完整 location 会报 HTTP 400 `malformed url`，
  而且本来也只有受邀者可见）。汇报就说"在私密实例里，看不到还有谁"，不要反复重试。
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

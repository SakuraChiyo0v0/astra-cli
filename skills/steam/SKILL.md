---
name: astra-steam
description: Check a Steam wishlist, prices and public inventory.
version: 0.1.0
author: SakuraChiyo0v0, Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Steam, Wishlist, Inventory]
    category: games
prerequisites:
  commands: [astra]
# 让 terminal 子进程拿到 astra 的数据目录（Hermes 默认会过滤子进程环境变量）
required_environment_variables:
  - name: ASTRA_HOME
    prompt: astra 数据目录
    help: 部署时在容器环境里设好，例如 /opt/astra/home
---

# Astra Steam Skill

用 `astra` 查 Steam 的**愿望单**和**公开库存**。它不能买东西、不能交易、不能改账号设置。

## When to Use

- 用户问"我愿望单里哪些在打折 / 多少钱 / 有什么想买的"
- 用户问"我的 CS2 库存里有什么 / 有多少能卖的"
- 用户问"我的 Steam 资料 / 最近在玩什么"
- 用户想设置或检查 SteamID64 和 Web API key

**不适用**：买游戏、送礼、交易、改价格提醒、查商店评测。这些做不到，直接说明。

## 网络前提

Steam 的域名在国内多数不通，这台机器靠代理访问：

- `api.steampowered.com` —— 有时直连可用，配了代理就走代理
- `store.steampowered.com` —— **必须走代理**
- `steamcommunity.com` —— **必须走代理**

所以 `proxy.url` 要指向可用的代理，`proxy.include` 里要有 `steampowered.com,steamcommunity.com`。
不确定就先跑 `astra doctor`，看 `proxy` 和 `proxy_reachable` 两项。

**排查顺序**：`astra doctor` → `astra steam doctor` → 具体命令。
报 `NETWORK_ERROR` 或 `TIMEOUT` 且 hint 提到代理，是网络问题，不是用法问题。

## 愿望单

```sh
astra steam wishlist                      # 默认前 50 条，带名字和价格
astra steam wishlist --sort discount      # 折扣优先
astra steam wishlist --limit 200 --sort price
astra steam wishlist --no-details         # 只列 appid，不查商店，快
```

返回里 `total` 是愿望单总数、`returned` 是本次返回的、`onSale` 是其中在打折的数量。
每个条目带 `name` / `price` / `discountPercent` / `originalPrice` / `addedAt` / `storeUrl`。

**不需要 Web API key**，只要有公开愿望单。

**空结果有两种含义，必须分开说**：真的没有愿望单，或者账号的「游戏详情」没设为公开。
Steam 对私密愿望单返回空对象、不报错。所以 `items` 为空时要提醒用户去
`steamcommunity.com/my/edit/settings` 把「游戏详情」改成公开，而不是断言"你愿望单是空的"。
命令的 `warnings` 里已经带了这句话，转告用户即可。

## 库存

```sh
astra steam inventory --app 730           # CS2
astra steam inventory --app 753           # Steam 社区物品（卡牌、背景）
astra steam inventory --app 570           # Dota 2
```

返回 `total` / `returned` / `tradable` / `marketable`，条目带名字、类型、能否交易/上市场、图标链接。
`--limit` 可以调大（最多 5000）。

**库存接口对共享代理 IP 限流很严**，会稳定返回 429。这不是配置错：
把 `error.hint` 原话转告用户（等一会儿再试，频繁请求会更久），别自己反复重试刷它。
出错码是 `STEAM_HTTP` 且 `retryable: true`。

## 资料与凭据

```sh
astra steam auth                          # 看凭据状态（key 只显示 8 位指纹）
astra steam auth set-user <SteamID64>     # 17 位、7656 开头
astra steam auth set-key <32 位十六进制>   # https://steamcommunity.com/dev/apikey 免费申请
astra steam me                            # 昵称、头像、可见性、注册时间
```

`steam me` 要 key。返回里 `visibility` 是 `3`（公开）时愿望单和库存才读得到；
`1`/`2` 会在 `warnings` 里提示，转告用户去改隐私设置。

**永远不要在对话里回显 API key**，只能引用 `apiKeyDigest` 那 8 位。

## Common Mistakes

- 拿 `--no-details` 的结果回答"多少钱" —— 那条路根本不查价格，只有 appid 和加入日期
- 愿望单为空就断言"你没有愿望单" —— 先看账号是不是公开
- 库存 429 就反复重试 —— 越重试限得越久，等用户自己决定
- 忘了 `--user` 也可以传 SteamID64，用户说的号不是默认号时用得上

## 输出约定

和其它域一致：stdout 一个 JSON。`ok: true` 看 `data` 和 `warnings`；
`ok: false` 看 `error.code` / `message` / `hint`。`retryable: true` 表示稍后重试可能成功。

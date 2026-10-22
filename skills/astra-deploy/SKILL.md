---
name: astra-deploy
description: Deploy astra CLI updates to the NAS (Hermes container) and verify them.
version: 0.1.0
author: SakuraChiyo0v0
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Deploy, Ops, NAS]
    category: operations
---

# 把 astra 的新版本部署到 NAS

给维护者用：改完代码、`npm run check` 全绿之后，怎么把产物换到 NAS 上并确认真的生效。
**第一次从零部署**（装 Hermes、建飞书应用、配代理）看 `deploy/部署手册.md`，这里只管更新。

## When to Use

- 发版之后要把新 `astra.mjs` 推到 NAS
- 改了 `skills/` 下给 Hermes 读的说明书
- 线上 `astra version` 和仓库 tag 对不上

## 关键事实

astra 是**单文件产物** `dist/astra.mjs`，版本号在打包时写死进去
（`scripts/build.mjs` 的 `define: ASTRA_VERSION`，取自 `package.json`）。
**文件不换，版本号就不变** —— 仓库发了新版，NAS 不会自己变。

部署根目录（本机实测）：`/volume1/docker`，所以产物落在
`/volume1/docker/astra/bin/astra.mjs`。

| 宿主路径 | 容器里 | 读写 |
|-|-|-|
| `astra/bin/astra.mjs` | `/opt/astra/bin/astra.mjs` | 只读挂载 |
| `astra/bin/astra` | `/opt/data/.local/bin/astra` | 只读挂载 |
| `astra/skills/` | `/opt/astra/skills` | 可写 |
| `astra/home/` | `ASTRA_HOME=/opt/astra/home` | 可写 |
| `hermes/data/` | `/opt/data` | 可写 |

## 部署步骤

### 1. 构建并确认版本

```bash
npm ci && npm run check        # 类型检查 + 测试 + 打包
node dist/astra.mjs version    # 期望 {"ok":true,"data":{"version":"x.y.z",...}}
```

版本号必须是你要发的那个。忘了升就先改 `package.json` 再打包。

### 2. 传到 NAS

本机 SSH 到 NAS 是不通的（22 端口超时），走 **Kura 的本地 WebDAV**
（默认 `http://127.0.0.1:18005`，暴露范围见 `kura_scope_get`）。
用 curl 传二进制，**不要走 MCP 的 `kura_files_write`** —— 562KB 的文件 base64 一遍
会把上下文打爆：

```bash
curl -T dist/astra.mjs http://127.0.0.1:18005/volume1/docker/astra/bin/astra.mjs
```

传完**立刻确认大小**，WebDAV 传半截不会报错：

```bash
curl -sI http://127.0.0.1:18005/volume1/docker/astra/bin/astra.mjs
ls -l dist/astra.mjs      # 两边字节数必须一致
```

### 3. 修权限

通过 WebDAV/SMB 传上去的文件经常变成 000，容器读不到 ——
表现是 `astra` 突然 `command not found` 或 `Permission denied`。
这是**最典型的"装好了但跑不起来"**。

`kura_files_stat` 能看权限位；需要改就在 NAS 上 `chmod 755`。

### 4. 生效（不用重建容器）

`bin/astra.mjs` 是只读挂载，每次 `docker exec` 都从宿主读文件，
所以**下次调用就是新版本**：

```bash
docker exec hermes astra version    # 期望看到新版本号
```

### 5. skill 文档也变了的话

```bash
cp -r skills/* /volume1/docker/astra/skills/
chmod -R 755 /volume1/docker/astra/skills
```

`skills` 是可写挂载，同样不用重启。**但 Hermes 启动时读了技能列表**，
新技能不出现时 `docker restart hermes`。

> 只传要上线的子目录，别把本机流程笔记（如 `astra-requirements`）一起带过去。

### 6. 验证

```bash
docker exec hermes astra version    # 版本对
docker exec hermes astra doctor     # required 全绿
```

改了某个域的逻辑，**再跑一次真实下载**，别只看 `doctor`：

```bash
docker exec hermes astra music get 光年之外 邓紫棋
docker exec hermes astra bili get BV1xxx --audio-only
```

## 什么时候必须重启

| 改了什么 | 要重启吗 |
|-|-|
| `astra.mjs`（CLI 代码 / 版本） | 不用 |
| `skills/` 下的 SKILL.md | 一般不用，技能列表没更新才重启 |
| `astra/home/` 里的配置、曲库 | 不用 |
| `hermes/data/.env`、`data/config.yaml` | **要**（`docker compose restart`） |
| `docker-compose.yml`、`Dockerfile` | **要重建**（`docker compose up -d`） |

重启会中断正在跑的后台任务。有 `astra music job <id>` 在跑就先等它结束。

## Pitfalls

- **版本号不会自己变**。只换文件不重新打包，`astra version` 还是旧的，
  会误以为部署失败。
- **传完不查大小**。WebDAV 半截上传不报错，容器里报的错却是语法错，很难联想到这里。
- **忘了 `chmod 755`**。症状是 `command not found`，看起来像挂载没生效。
- **SSH 连不上不是故障**。本机到 NAS 的 22 端口常态超时，别在这上面耗时间，走 WebDAV。
- **代理相关**：`proxy.include` 留空表示"全部走代理"，不是"谁都不走"。
  别让 B 站、网易云绕代理，多一跳更慢且 B 站对代理 IP 敏感。
- **会话文件属主**：宿主机以 root 跑 astra 登录过，会把 `*-session.json` 变成 `root:root 600`，
  容器里 uid 1000 读不到（`EACCES`）。修：
  `docker run --rm -v /volume1/docker/astra/home:/fix alpine chown 1000:10 /fix/*-session.json`

## 部署完的清单

- [ ] `docker exec hermes astra version` 的版本号 == 仓库最新 tag
- [ ] `astra doctor` 的 `required` 全部通过
- [ ] 改过的域跑过一次真实下载，文件真落地
- [ ] 新加的 skill 在 `docker exec hermes hermes skills list` 里能看到
- [ ] 飞书里机器人仍能正常回话

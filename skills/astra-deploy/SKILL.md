---
name: astra-deploy
description: Deploy astra CLI updates to the NAS (Hermes container) and verify them.
version: 0.2.0
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

> **先看这一条：Hermes 现在跑在 NAS 的容器里，部署走 `docker run -v`，不走 WebDAV。**
> 本文下半部分（WebDAV / Kura 中继 / `127.0.0.1:18006`）是**从宿主机器部署**的老路子，
> 容器内根本连不到那个端口，别照抄。容器内的完整链路（构建 → 部署 → md5 → 实测）见技能
> `astra-cli-dev` 的「部署」一节，核心就一条：
>
> ```bash
> docker run --rm -v /volume1/docker/astra/bin:/b \
>   -v /volume1/docker/hermes/data/astra-src/dist:/d \
>   alpine sh -c 'cp /d/astra.mjs /b/astra.mjs && chmod 755 /b/astra.mjs && md5sum /b/astra.mjs'
> ```

- 发版之后要把新 `astra.mjs` 推到 NAS
- **要自己改 astra 源码**（需求清单里的条目）→ 看「在容器内改源码」一节：代理、密钥、bin 权限都在那里
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

本机 SSH 到 NAS 是不通的（22 端口超时），走 **Kura 的本地 WebDAV**。
端口用 `kura_dav_status` 现查，**别记死** —— 实测是 `18006`：

```bash
curl -sS -T dist/astra.mjs http://127.0.0.1:18006/volume1/docker/astra/bin/astra.mjs
```

用 curl 传二进制，**不要走 MCP 的 `kura_files_write`** —— 562KB 的文件 base64 一遍
会把上下文打爆。

传完**立刻校验**。最好的判据是双向 MD5，不是只看大小：

```bash
curl -sS http://127.0.0.1:18006/volume1/docker/astra/bin/astra.mjs -o /tmp/r.mjs
md5sum /tmp/r.mjs dist/astra.mjs     # 必须一致
```

覆盖已存在的文件返回 **201**；传到一个不存在的目录返回 **409 Conflict**，
不会帮你建目录 —— 先 `curl -X MKCOL <目录>/` 建好。

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

**没有 shell 时怎么验**：这台机器上 SSH 到 NAS 不通、Kura 映射的
`127.0.0.1:2375` 不是真的 Docker API（所有路径返 404），`kura_docker_container`
也只给配置不给 exec。此时靠这两条判据：

1. 宿主文件 MD5 == 本地 `dist/astra.mjs` 的 MD5（上面第 2 步）
2. 产物里内置了版本号字面量：`grep -o '"0\.12\.[0-9]"' /tmp/r.mjs`

版本号是 `define: ASTRA_VERSION` 在**打包时**写死的常量，
所以"文件 MD5 对了 + 里面有新版本号"≙ 容器里跑的就是新版本。

### 5. skill 文档也变了的话

**目录名不是仓库里的目录名。** NAS 上的 `skills/` 按 SKILL.md frontmatter 的 `name` 建目录，
而仓库里按域名建。实测对应关系：

| 仓库 | NAS 上 |
|-|-|
| `skills/bili/` | `skills/astra-bili/` |
| `skills/music/` | `skills/astra-music/` |
| `skills/vrchat/` | `skills/astra-vrchat/` |
| `skills/jm/` | `skills/astra-jm/`（0.57.0 之前叫 `astra-comic`，现在那个名字归普通漫画） |
| `skills/comic/` | `skills/astra-comic/` |
| `skills/astra-deploy/` | `skills/astra-deploy/` |

传错目录会静默成功（WebDAV 会新建），但 Hermes 永远读不到 —— 先 `PROPFIND` 看一眼：

```bash
curl -sS -X PROPFIND -H "Depth: 1" http://127.0.0.1:18006/volume1/docker/astra/skills/ \
  | grep -o "<D:href>[^<]*</D:href>"
```

然后按真实目录名传：

```bash
curl -sS -T skills/bili/SKILL.md http://127.0.0.1:18006/volume1/docker/astra/skills/astra-bili/SKILL.md
```

`skills` 是可写挂载，不用重启。**但 Hermes 启动时读了技能列表**，
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

- **单文件产物只内联「静态」require，动态依赖要自己放到 `bin/node_modules/`**。
  esbuild 把依赖打成一个 `astra.mjs`，但 `require('lzma')` 这类**动态**调用会原样留在产物里，
  运行时按 `astra.mjs` 所在目录往上找 `node_modules`。`bin/` 是只读挂载、又没有 `node_modules`，
  于是某些命令直接 `INTERNAL: Cannot find module 'lzma'`（典型：`steam idle start` 这类要起会话的），
  而 `version` / `status` 照常 —— 极容易误判成上游掉线。
  装法（docker 看不见容器内 `/opt/data`，要先落到 NAS 路径）：

  ```bash
  cd /opt/data/cache/scratch && npm i lzma --no-save && tar czf lzma.tgz -C node_modules lzma
  cp lzma.tgz /host-root/volume1/docker/astra/tmp/
  docker run --rm -v /volume1/docker/astra:/a alpine \
    sh -c 'mkdir -p /a/bin/node_modules && tar xzf /a/tmp/lzma.tgz -C /a/bin/node_modules'
  node -e "console.log(require.resolve('lzma',{paths:['/opt/astra/bin']}))"   # 能解析才算成
  ```

  用 tar 而不是 `cp -r <源目录> <目标>`：跨 bind mount 直接 cp 会静默建出空目录。
- **验收必须跑一条「起会话」的命令**。`version` / `status` 只读，测不出上面那类运行时缺依赖；
  改了挂机、登录、下载相关的代码，就跑 `astra steam idle stop && astra steam idle start VRChat --wait 45`
  看 `status: online`。只跑 version 等于没测。
- **多个 agent 同时改这个仓库时，push 被拒后必须重 build**。`git pull --rebase` 后冲突通常在
  `CHANGELOG.md` / `package.json`：保留对方条目，自己的版本号取下一号（对方已占的不抢）。
  rebase 完成后 `dist/astra.mjs` 还是旧的（里面没有对方的新代码），**必须重新 `npm run build` 再部署**，
  否则一部署就把对方刚上的功能回滚了；部署后 `astra version` 要能同时包含双方改动。
- **版本号不会自己变**。只换文件不重新打包，`astra version` 还是旧的，
  会误以为部署失败。
- **传完不校验**。WebDAV 半截上传不报错，容器里报的错却是语法错，很难联想到这里。
  只对比大小不够，要比 MD5。
- **忘了 `chmod 755`**。症状是 `command not found`，看起来像挂载没生效。
- **SSH 连不上不是故障**。本机到 NAS 的 22 端口常态超时，别在这上面耗时间，走 WebDAV。
- **中继会突然断**。这台机器走 `mode: wan`、`lanReachable: false`，Kura 的 WebDAV 与
  127.0.0.1 的映射端口会间歇性连不上。表现是 `curl: (7) Failed to connect`，
  而外网（github 等）正常。**不是 NAS 挂了**，等 1-3 分钟重试即可；
  传了一半断开要重新传并重新校验 MD5。
- **代理相关**：`proxy.include` 留空表示"全部走代理"，不是"谁都不走"。
  别让 B 站、网易云绕代理，多一跳更慢且 B 站对代理 IP 敏感。
- **会话文件属主**：宿主机以 root 跑 astra 登录过，会把 `*-session.json` 变成 `root:root 600`，
  容器里 uid 1000 读不到（`EACCES`）。修：
  `docker run --rm -v /volume1/docker/astra/home:/fix alpine chown 1000:10 /fix/*-session.json`

## 发版后逐条验收（需求清单驱动）

维护者每发一版都会说“升级了 / 应该升级了吧”，期待的是**逐条实测验收**，不是一句“收到了”。
固定流程：

1. **先看清单还剩什么**：`grep -n '^### ' <需求文档> | grep -v '✅'`。没勾的才是这轮要验的；
   已勾的不用重跑（用户要求“验证通过的条目删掉，只留未完成”）。
2. **三处 diff 定位新功能**，比读 changelog 快且不会漏：
   - `astra version` —— 版本号对不对
   - `astra config list | grep bili.` —— **新出现的配置键就是上线了的功能**（如 `bili.audio-dir`）
   - `astra help <组>` —— 新子命令、新选项、`routing` 字段的变化
3. **按清单里的“复现”命令原样跑**，不要自己另编验证方式。写盘/写标签类必须**读回**：
   `mutagen` 读 `TIT2`/`TALB`/`TXXX:BILIBILI_BVID`、`ffprobe` 读 `format_tags`、`ls` 数文件——
   返回 `ok:true` 只证明命令没报错，不证明落点与标签对。
4. **增量类功能靠复跑验收**：同一批第二次跑必须 `downloaded=0 / skipped=N`；
   只看第一次 `failed:0` 不能证明幂等。
5. **测试改过的 config 当场还原**（`bili.dir` / `bili.audio-dir` / 两个 template），
   并把测试下载的目录从正式库移进 `.hermes-trash/<日期>/`，不要留在库里等用户发现。
6. **标记与汇报**：清单条目改成 `✅ 已实现（vX.Y.Z）：<一句话结论>`，写清复测数据与遗留小问题；
   回复用表格（条目 / 结论 / 证据），不要贴大段日志。
7. **新发现的问题写成新条目**，格式固定为 现象 / 复现命令 / 期望 / 验收——用户会直接把它转给开发。
   先确认是真缺陷再写：测下来没收益的（如并发提速）标“关闭（不是缺陷）”，不要挂在那里当 TODO。

**不要再把 NAS 上的 `astra.mjs` 当补丁文件改**：那是打包产物，下次部署就被覆盖。
改代码只能改**源码**再重新打包（见下节）。

## 在容器内改源码（Hermes 自己实现 → 部署 → 验收）

维护者已经授权 Hermes 直接改源码，不再“Hermes 提需求、维护者转述给开发”两边问。
默认工作流变成：读需求清单 → 改源码 → 补测试 → 全量测试 → 打包 → 部署 → 真库验收 → 报结果。
需求文档照写（现象 / 复现 / 期望 / 验收），但它是**我自己的任务单**，不是等别人实现的工单。
清单放在 `/opt/data/requirements/astra-requirements-*.md`，同步一份到 `/volume1/docker/astra/REQUIREMENTS-*.md`。
用户已经明确：**碰到真问题就直接加条目，不用先问**；验证通过的条目删掉，只留未完成。

### 容器里的构建环境（实测）

```
node v26.7.0   npm 12.0.2   git 2.47.3   无 pnpm（可 npm i -g pnpm）
源码目录：/opt/data/astra-src（容器内可写）
```

### 出网：GitHub 必须走 mihomo 代理

```
https://github.com 直连      → 超时（curl 20s 返回 000，git ls-remote 60s exit 124）
http://mihomo:7890 作代理    → 200  ✅（mihomo 与 hermes 同在 proxy-net，直接用容器名）
registry.npmjs.org 直连      → 200  ✅（装依赖不用代理）
ssh github.com:22 直连       → 通（返回 Permission denied (publickey) 说明链路没问题）
```

已写进 git 全局配置：`http.proxy` / `https.proxy` = `http://mihomo:7890`。
密钥在 `/opt/data/.ssh/id_ed25519`，`~/.ssh/config` 已指定 `github.com` 用这把钥匙 + keepalive。
**公钥必须先由用户加到 GitHub**（Settings → SSH keys，或仓库 Deploy keys 只读即可），
否则 clone 一律 `Permission denied (publickey)`；别自己反复重试。

### 部署：bin 目录是 root 属主，hermes 写不进去

`/opt/astra/bin` 与宿主 `/volume1/docker/astra/bin` 都是 `root:root 755`，
`touch` 直接失败。产物落地要用 docker 以 root 身份写（sock 可用）：

```bash
docker run --rm -v /volume1/docker/astra/bin:/b \
  -v /volume1/docker/hermes/data/astra-src/dist:/d alpine \
  sh -c 'cp /b/astra.mjs /b/astra.mjs.bak-<旧版本> 2>/dev/null; cp /d/astra.mjs /b/astra.mjs && chmod 755 /b/astra.mjs && md5sum /b/astra.mjs'
```

**挂载源必须写宿主路径 `/volume1/docker/hermes/data/...`，不能写容器内的 `/opt/data/...`。**
docker 守护进程跑在宿主上，容器里的路径它看不见 —— 写成 `/opt/data/astra-src/dist` 会报
`cp: can't stat '/d/astra.mjs': No such file or directory`，看起来像打包没产物。

写前先备份成 `astra.mjs.bak-<版本>`（目录里已有这个惯例），出问题能立刻换回去。
`bin/` 是只读挂载，换完文件下次调用就是新版本，**不用重启容器**。

验证：`md5sum dist/astra.mjs` 与上面 docker 里输出的 MD5 必须一致；
`astra` 不在 PATH 上，用全路径 `/opt/data/.local/bin/astra version` 查（它是只读挂载的 wrapper，
指向 `/opt/astra/bin/astra.mjs`）。

> 「clone → npm i → npm test → 打包 → docker 复制」整条链路已实测跑通（含 `bili dyn` /
> `bili album` 两个新命令的上线），可直接照做。

### 改完的验收（和发版验收同一套）

1. `astra version` 必须是新版本号（版本号在打包时写死，文件不换就不会变）
2. 按需求条目的“复现命令”原样跑，写盘类必须读回（`mutagen` / `ffprobe` / `ls` 数数）
3. 增量类功能复跑一次，断言 `downloaded=0 / skipped=N`
4. 测试用的 `bili.dir` / `bili.audio-dir` / template 当场还原，测试产物移进 `.hermes-trash`

## 部署完的清单

- [ ] `docker exec hermes astra version` 的版本号 == 仓库最新 tag
- [ ] `astra doctor` 的 `required` 全部通过
- [ ] 改过的域跑过一次真实下载，文件真落地
- [ ] 新加的 skill 在 `docker exec hermes hermes skills list` 里能看到
- [ ] 飞书里机器人仍能正常回话

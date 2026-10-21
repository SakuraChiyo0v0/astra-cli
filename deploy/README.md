# 部署到 NAS：Hermes（飞书）+ astra

```
飞书 ⇄ Hermes 容器（WebSocket 出站）── terminal ──▶ astra.mjs ──▶ 网易云 / 音源 ──▶ <音乐目录>/astra
              │
              └── OpenAI 兼容 ──▶ workbuddy2api:7863（同机容器，按容器名直连）
```

astra 是单文件 `dist/astra.mjs`，Hermes 官方镜像自带 Node（≥ 24，2026-10 lock 里是 v26.7），
所以 astra 跑在 Hermes 容器里，不另起服务，也不依赖 NAS 上别的服务（模型除外）。

## 目录

```
<部署根>/astra/
├── bin/astra.mjs            # npm run build 的产物
├── bin/astra                # 包装脚本：exec node /opt/astra/bin/astra.mjs "$@"
├── skills/astra-music/SKILL.md
└── home/                    # ASTRA_HOME：配置、曲库 astra.db、音源脚本、任务日志
<部署根>/hermes/
├── docker-compose.yml       # deploy/hermes/docker-compose.yml
├── .env                     # compose 变量（deploy/hermes/compose.env.example），无密钥
└── data/                    # Hermes 的 /opt/data
    ├── .env                 # 模型 key、飞书密钥（deploy/hermes/hermes.env.example），600
    └── config.yaml          # deploy/hermes/config.yaml
<音乐目录>/astra/              # 下载目标；Navidrome 读整个音乐目录，会一起扫到
```

音乐目录单独用 `astra/` 子目录，不和 music-web 的 `wy/` 混在一起。

## 这台机器上实际开的权限（2026-10-21）

Hermes 的 terminal 是 local 后端，agent 能在容器里跑任意命令。真正决定影响面的是挂了什么：

| 挂载 | 权限 | 说明 |
|-|-|-|
| `/home` → `/host-root/home` | 读写 | 和 Kura 的 WebDAV 暴露范围一致 |
| `/volume1` → `/host-root/volume1` | 读写 | 主存储：曲库、docker 配置、各项目目录都在里面 |
| `/var/run/docker.sock` + `group_add: 121` | 控制 | **等价宿主机 root**：能起特权容器反向挂宿主根目录 |
| `<部署根>/hermes/data` → `/opt/data` | 读写 | Hermes 自己的配置与密钥 |
| `<音乐目录>/astra` → `/music` | 读写 | astra 下载目标 |
| `<部署根>/astra/home` → `/opt/astra/home` | 读写 | astra 的曲库数据库、音源脚本 |
| `<部署根>/astra/bin`、`/skills` | 只读 | CLI 与技能 |

配置侧的约束：

- `approvals.mode: manual` —— 危险命令（`rm -rf`、`docker stop`、写系统文件）弹飞书卡片，点确认才执行。
  但普通的 `mv`、`>` 重定向、改配置文件**不一定**被判为危险、会直接执行。
- 飞书：DM 只认 `FEISHU_ALLOWED_USERS` 里的人；群里 `default_group_policy: admin_only`，只有 `platforms.feishu.extra.admins` 能用。
- 容器里没有 `sudo`，agent 以 `hermes`（uid 1000）身份跑，不是 root。

回收方式：删掉 compose 里对应的那行挂载，`docker compose up -d` 重建即生效。
`/volume1/音乐` 下有 `#recycle`，删文件会先进回收站，算一层缓冲。

## 镜像：为什么要自己 build

官方镜像**装不了**飞书 SDK，必须用同目录的 Dockerfile 派生一层：

- 镜像设了 `HERMES_DISABLE_LAZY_INSTALLS`，运行期按需装依赖被拒（`sync_venv` 静默空跑、`hermes pm install feishu` 报 unknown package）
- `/opt/hermes` 是 root 所有、运行期只读；venv 里没有 pip，只有 `/opt/hermes/tools/uv-*/uv`

所以 Dockerfile 里用镜像自带的 uv 预装 `lark-oapi==1.6.8`（版本取自 hermes 自己 pyproject 的 feishu extra）。
改依赖后：`docker compose build && docker compose up -d --force-recreate`。

## 步骤

1. **飞书应用**（开放平台 → 企业自建应用）
   - 开启「机器人」能力；记下 App ID、App Secret
   - 权限：`im:message`、`im:message:send_as_bot`、`im:resource`、`im:chat`、`im:chat:readonly`；
     建议再加 `contact:user.id:readonly`、`admin:app.info:readonly`
   - 事件与回调 → 连接方式选**长连接**；事件订阅 `im.message.receive_v1`；回调配置里加 `card.action.trigger`
   - 版本管理 → 发布
2. **放文件**：按上面目录放好；`data/.env` 填 `OPENAI_API_KEY`（WorkBuddy2API 的 api_key）和飞书三项
3. **权限**：`HERMES_UID/GID` 要对 `hermes/data`、`astra/home`、`<音乐目录>/astra` 可写
4. **起容器**：`docker compose up -d`（在 `<部署根>/hermes`）
5. **导入音源**（进容器执行一次。注意用 `sh -c` 而不是 `bash -lc`，登录 shell 会覆盖 PATH）：
   ```sh
   docker exec hermes astra music source add /opt/astra/home/import/qdy.js --id qdy
   docker exec hermes astra doctor
   ```
6. **拿自己的 open_id 填白名单**：先给机器人发一条消息，在 `hermes` 日志里找发送者 `ou_…`，
   填进 `data/.env` 的 `FEISHU_ALLOWED_USERS`，`docker restart hermes`。**白名单为空时谁都能用**，不要长期这样跑
7. 飞书里对机器人说「下载 光年之外 邓紫棋」

## 模型

`config.yaml` 默认 `cn:deepseek-v4-pro`。2026-10-21 实测（带 skill 说明的系统提示）：
deepseek-v4-pro / deepseek-v4.1-flash / glm-5.3 / kimi-k3-1 / minimax-m3 / hy3 都会调 `astra music get`，
拿到 `ambiguous` 后都会列候选问用户、不擅自下载。

注意：**不带系统提示**直接问"帮我下载 xx"，这些模型都会以版权为由拒绝。部署后如果出现这种回复，
说明 skill 没加载上（`docker exec hermes hermes skills list` 里要能看到 `astra-music`）。

## 安全

- 不发布任何端口；飞书是出站长连接
- Hermes 的 terminal 是 local 后端，能在容器里执行任意命令。容器里只挂了它需要的目录，没有 Docker socket
- 白名单必须填
- `data/.env`、`astra/home/` 里有密钥和音源脚本，不要放进共享目录

## 部署时踩过的坑（2026-10-21）

- **WebDAV 上传的文件权限是 000**，挂进容器后 hermes 用户读不到。
  → 上传完在 NAS 上 `chmod 755` 那几个文件，音乐目录 `chown -R <uid>:<gid>`。
- **astra 包装脚本要放进 `/opt/data/.local/bin`**：它在容器默认 PATH 里，而 `/opt/astra/bin` 不在；`PATH` 不能通过 .env 改（被 denylist 拦）。
- **`docker exec ... bash -lc` 会加载登录 profile、把 PATH 换成宿主机的**，测容器内命令要用 `sh -c` 或 `bash -c`。
- **白名单生效前**：网关会回一条配对提示。把日志里的 `sender=user:ou_...` 填进 `data/.env` 的 `FEISHU_ALLOWED_USERS` 再重启即可，不必走配对审批。
- **改模型**：改 `data/config.yaml` 的 `model.default` 后要重启容器；重启会让进行中的任务中断（飞书里会看到 shutting down 提示，属正常）。

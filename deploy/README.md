# 部署到 NAS（与 Hermes 同容器）

astra 是单文件 `dist/astra.mjs`，只要 Node ≥ 24。Hermes 官方镜像自带 Node（2026-10 实测 lock 里是 v26.7），
所以不用另起容器：把 astra 和 skill 挂进 Hermes 容器即可。astra 不依赖 NAS 上的任何其它服务。

## 目录

```
<部署根>/astra/
├── bin/astra.mjs      # npm run build 的产物
├── bin/astra          # 包装脚本，见下
├── home/              # ASTRA_HOME：配置、曲库数据库、音源脚本、任务日志
└── skills/astra-music/SKILL.md
<媒体目录>/music/        # 下载目标，Navidrome 等直接读这里
```

`bin/astra`：

```sh
#!/bin/sh
exec node /opt/astra/bin/astra.mjs "$@"
```

## 挂进 Hermes 的 compose

在 Hermes 的 `docker-compose.yml` 的 `gateway` 服务里加：

```yaml
    volumes:
      - ~/.hermes:/opt/data
      - <部署根>/astra/bin:/opt/astra/bin:ro
      - <部署根>/astra/home:/opt/astra/home
      - <部署根>/astra/skills/astra-music:/opt/data/skills/media/astra-music:ro
      - <媒体目录>/music:/music
    environment:
      - ASTRA_HOME=/opt/astra/home
      - ASTRA_MUSIC_DIR=/music
      - PATH=/opt/astra/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
```

skill 的挂载路径以 Hermes 实际读取 skills 的目录为准（`~/.hermes/skills/<分类>/<名字>/SKILL.md`），
部署时用 `hermes skills list` 确认能看到 `astra-music`。

## 首次配置（进容器执行）

```sh
astra doctor
astra music source add /opt/astra/home/qdy.js --id qdy   # 先把音源脚本放进 home
astra music source test                                   # 看各音源实际能给什么音质
astra config set music.quality flac
```

可选：后台任务完成推送到飞书群（群里加一个自定义机器人，复制 webhook）：

```sh
astra config set notify.feishu_webhook https://open.feishu.cn/open-apis/bot/v2/hook/<token>
astra notify test
```

Hermes 自己的飞书网关回复的是对话；这个 webhook 只用于"歌单下完了"这种异步结果。两者互不依赖。

## 权限

- 写 `/music` 需要容器内用户（Hermes 用 `HERMES_UID/HERMES_GID` 映射）对媒体目录有写权限
- `home/` 里有音源脚本和 webhook 地址，不要放进共享目录

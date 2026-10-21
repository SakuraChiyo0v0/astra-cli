# astra

给 AI 调用的个人能力 CLI。一条命令办完一件事，stdout 永远只有一个 JSON。
目标场景：NAS 上的 Hermes 收到飞书消息"下一首晴天"，调 `astra music get 晴天 周杰伦`，把结果回给你。

第一个能力是音乐下载：网易云找歌 → 洛雪音源取直链（实测音质）→ 写标签 / 封面 / 歌词 → 存进音乐目录。
**不依赖任何其它服务**：没有数据库服务、没有常驻进程，状态全在一个目录里。

## 用法

```sh
astra help                         # 全部命令说明（给 AI 读的）
astra music get 晴天 周杰伦         # 拿得准就下，拿不准返回候选
astra music get wy:186016          # 用候选里的 ref 下
astra music get https://music.163.com/#/album?id=34720827   # 专辑 / 歌单 / 歌手 → 后台任务
astra music job <id> --wait 120
astra music have 周杰伦
```

输出形状：

```jsonc
{ "ok": true, "data": { "status": "downloaded", "quality": "24bit", "downgraded": false, ... }, "warnings": [] }
{ "ok": false, "error": { "code": "NO_SOURCE", "message": "...", "hint": "下一步该做什么", "retryable": false } }
```

`data.status`：`downloaded` / `already_have` / `ambiguous`（附 candidates）/ `job_started`。
退出码：0 成功 / 2 参数错 / 3 需要配置 / 4 没找到 / 5 上游或网络 / 130 取消。

## 数据目录

| | 默认 | 覆盖 |
|-|-|-|
| 状态（配置、曲库 `astra.db`、音源、任务日志） | `~/.astra` | `ASTRA_HOME` |
| 音乐 | `<ASTRA_HOME>/music` | `ASTRA_MUSIC_DIR` 或 `astra config set music.dir` |

音源脚本不进仓库：`astra music source add <文件>` 导入，导入前会试加载。

## 开发

需要 Node ≥ 24（直接跑 `.ts`，用到 `node:sqlite`）。

```sh
npm install
npm run astra -- music get アイドル YOASOBI
npm run check      # 类型检查 + 测试 + 打包
```

打包产物 `dist/astra.mjs` 是单文件，部署见 [deploy/README.md](deploy/README.md)，Hermes 用的 skill 在 [skills/music/SKILL.md](skills/music/SKILL.md)。

## 目录

```
src/core/    输出约定、错误、配置、HTTP、SQLite、飞书通知、命令框架
src/lx/      洛雪音源宿主（vm 沙箱）与音源管理
src/music/   网易云接口、版本判断、酷我同曲匹配、取链、下载、标签、曲库、后台任务、命令
tests/       node:test；夹具是 2026-10-21 抓的真实响应和 ffmpeg 生成的真实音频
```

# Changelog

## 0.3.1 — 2026-10-21

- 取最优：不再"拿到请求档位就收"。官方按 24bit → flac 的顺序问，音源也往最高档找，最后在所有路线里挑最好的（采样率 > 位深 > 码率 > 格式）
- 修：原来只看码率，会选到 44.1kHz 高码率而丢掉 96kHz/24bit 的版本
- 官方已经是 24bit 时直接收工，不再问音源


## 0.3.0 — 2026-10-21

- 新增官方取链通道：用登录账号向网易云要播放地址，排在洛雪音源之前。VIP 账号实测能直接拿到 24bit FLAC（3.2Mbps / 86MB）
- 下载结果里的 `source` 现在会显示 `official` / `qdy@wy` / `qdy@kw`，能看出是不是走了官方
- 官方不给地址不算失败：下架 / 地区限制时自动回落到音源，把理由写进 `attempts`
- 修：刚签发的官方地址立刻请求可能 403，加了退避重试


## 0.2.0 — 2026-10-21

- 新增网易云扫码登录：`music login start / poll / wait / account / logout`。二维码出 PNG 文件（自带编码器，零依赖），交给 Hermes 用 `MEDIA:` 发图
- 新增 `music playlists`（我的歌单，自建 + 收藏）、`music daily`（每日推荐，可 `--download` 直接开任务）、`music liked`（我喜欢的音乐 / `--check` 批量查红心）
- 所有网易云请求带上会话 cookie：私人歌单、日推这类账号内容现在可见
- 加密模块 `crypto.ts`（weapi / eapi），补了确定性测试

## 0.1.3 — 2026-10-21

- deploy/hermes 增加派生镜像 Dockerfile：官方镜像运行期装不了飞书 SDK，必须预装 lark-oapi
- 部署文档补上权限、PATH、白名单与换模型的坑

## 0.1.2 — 2026-10-21

- 部署方案改为 Hermes（飞书长连接）+ astra 同容器，模型走同机 WorkBuddy2API：`deploy/hermes/` 下给出 compose、Hermes 的 config.yaml 与两份 env 模板
- skill 声明 `ASTRA_HOME` / `ASTRA_MUSIC_DIR`，Hermes 过滤子进程环境变量时会放行

## 0.1.1 — 2026-10-21

- 修复：酷我同曲路线可能拿到另一首歌（实测 アイドル 的直链是 夜に駆ける）。拿到文件后核对自带标题与 FLAC 实际时长，对不上就放弃这条路线
- `job` 结果加上音质分布；成功项的提醒（音质降级等）改放 `note`，`error` 只在失败时出现
- 输出被管道提前关闭（`| head`）时不再抛 EPIPE 堆栈

## 0.1.0 — 2026-10-21

首版：音乐下载。

- `music get`：关键词 / 网易云链接 / 短链 / ref 一条命令下完；拿不准时返回候选（带翻唱 / Live / 伴奏等标记），不替用户选
- 同一首歌收录在多张专辑时优先原专辑，其余作为 `otherVersions` 返回
- 取直链：洛雪音源 × 网易云 / 酷我同曲两条路线 × 档位从高到低，每个地址实测格式与码率；`quality` 是实测值，没达到请求档位时 `downgraded: true`
- 下载后写标签（ID3v2.4 / FLAC Vorbis Comment）、1200px 封面、歌词（内嵌 + 双语 .lrc），写前写后校验音频字节不变
- 曲库去重：已下过的返回 `already_have`
- 专辑 / 歌单 / 歌手 / 多首：后台任务，`job` 查进度、`--wait` 等待、`cancel` / `resume`，中断可恢复
- `music source add/list/remove/enable/disable/test` 管理音源脚本
- 后台任务结束可推送到飞书群机器人 webhook
- `help` / `--help` 输出给 AI 读的命令说明；`doctor` 自检

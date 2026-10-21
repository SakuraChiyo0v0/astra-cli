# Changelog

## 0.7.0 — 2026-10-21

- 任务体系抽到 `core/jobs.ts`，音乐与 B 站共用：各域只注册"一项怎么处理"，生命周期（起进程、并发、取消、恢复、通知）统一管
- B 站批量任务：`bili bulk`（收藏夹 / 合集 / 一个视频的全部 P），`bili job / jobs / job cancel / job resume`
- 修复重复判定只认 id 的问题：新增"标题 + 歌手 + 时长分桶"指纹，同一首歌换 id 出现时不再重下覆盖
- `music have --refresh` 顺带全量重算指纹
- 新配置 `bili.concurrency`（1..3，默认 1）
- 不支持按 UP 主主页批量：B 站投稿接口返回风控页


## 0.6.0 — 2026-10-21

- 新增红心 / 取消红心：`music liked --like <ref>` / `--unlike <ref>`
- **写操作必须二次确认**：第一次只返回预览和一次性令牌（5 分钟、单次有效），必须带 `--confirm <token>` 才真正执行。AI 没法一句话就把用户的歌单改了
- 已经是目标状态的歌自动跳过；下架歌如实报「下架歌曲无法收藏」
- 实测批量接口不可用（`trackIds` 数组返回 400），改为一首一首执行，单首失败不中断整批


## 0.5.0 — 2026-10-21

- 曲库记录母带规格：采样率 / 位深 / 声道，以及封面、歌词、逐字歌词是否齐全。老记录用 `music have --refresh` 回读文件补齐
- `music have` 显示规格与码率；`--low` 直接列出有损或低于 24bit 的歌（回答"哪些还能升级"）
- 统计按真实规格分组（`44.1k/16`、`96k/24`），不再只看档位名
- 新增订阅：`music subscribe add/list/set/remove/run`。定时盯歌单 / 专辑 / 歌手，出新歌自动下
- 订阅用**曲目集合差集**判断新歌（平台的上架时间不可靠）；第一次只记基线，不会把整个歌单重下一遍

新增第二个能力域：**B 站视频下载**。

- `bili get`：BV 号 / av 号 / 视频链接 / b23.tv 短链；多分 P 用 `--page 2,5-8` 指定，`--audio-only` 只取音频
- DASH 音视频分流下载后 ffmpeg 合并（`-c copy` 不重编码），自动在 baseUrl / backupUrl 间回退
- 下完用 ffprobe 核时长与流，报告实际分辨率与编码
- `bili login start / poll / account / logout`：扫码登录。**未登录画质封顶 360P**，登录后才可能到 1080P60 / 4K
- `bili info`（`--probe` 看实际可得画质）、`bili subtitle`（字幕转 srt）、`bili doctor`
- wbi 签名（`w_rid` + `wts`）
- 把路径模板抽到 `core/template.ts` 供音乐与视频共用；修掉"空变量残留 `01 .mp4`"的问题
- 修：入口文件判断原来只认固定文件名，产物改名后会静默不执行


## 0.4.0 — 2026-10-21

- 新增逐字歌词：网易云没有逐字（`klyric` 实测恒为空），改从酷狗取 KRC，解出后另存 `.word.lrc`（增强 LRC）
- KRC 解码：`krc1` 头 + 16 字节循环密钥 XOR + zlib。不是流传的"整体异或 0x64"，那种解不开
- **错位防护三道闸门**：搜索候选时长（±3s）→ krcs 候选时长（±3s）→ KRC 头 `[total:]`（±5s）。任何一道不过就放弃逐字、保留逐行，宁可没有也不给错的
- 修：搜索候选找不到时长匹配时原本会回退到第一条，等于绕过闸门 —— 改成直接放弃
- 新配置 `music.wordLyric`：`auto`（默认）/ `off`


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

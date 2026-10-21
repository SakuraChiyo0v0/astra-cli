# AGENTS.md — astra

给 AI 调用的个人能力 CLI。通用规范见全局 `~/.dsh/AGENTS.md`。

## 不能破的约定

1. **stdout 只有一个 JSON**（`{ ok, data, warnings? }` / `{ ok: false, error: { code, message, hint, retryable } }`）。进度写 stderr
2. **不依赖 NAS 上的其它服务**（music-web、astrahub 等）。可以参考它们的代码，不能调用
3. **一条命令办完一件事**：按用户意图切命令，不按上游 API 切
4. **拿不准就返回候选，不替用户选版本**。版本判断的改动必须用 `tests/fixtures/` 里的真实搜索结果验证
5. **音质只信实测字节**，不信档位名、URL 后缀、Content-Type
6. **写标签不能动音频字节**（写前写后比哈希）
7. 音源脚本不进仓库

## 验证

`npm run check`（类型检查 + 测试 + 打包）。改了取链 / 匹配逻辑，要再跑一次真实下载。
测试用真实形状：搜索夹具是抓的真实响应，音频夹具由 ffmpeg 生成；修完先撤掉修复确认测试变红。

## 工作约定

- 每次发版：升 `package.json` 版本、写 `CHANGELOG.md`、打 tag
- 成体系的工作在 `docs/归档/YYYY-MM-DD 主题.md` 记"踩过的坑"
- 提交身份 `SakuraChiyo0v0`；文档 / 夹具里的域名、IP、用户名、路径要脱敏

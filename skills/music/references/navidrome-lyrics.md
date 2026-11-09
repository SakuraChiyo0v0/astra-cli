# Navidrome 歌词显示排查与修复

Navidrome WebUI 只渲染**同步歌词**（带 `[mm:ss.xx]` 或逐字 `<mm:ss.xx>` 时间戳）。

**v0.12.4 起 astra 内嵌的就是同步格式**（逐字优先 → LRC → 纯文本兜底），新下载的歌不会再出现「文件里有歌词、
Navidrome 却显示无歌词」。**v0.12.4 之前下载的存量文件仍是纯文本**，按下面第 2 节重写即可 ——
首选 `astra music retag`，它会自动读同目录的 `.word.lrc` / `.lrc` 换成带时间戳的版本。

## 1. 先判断是哪一层的问题

| 检查 | 命令 | 结论 |
|---|---|---|
| 文件有没有歌词 | `find <专辑目录> -name '*.lrc' -o -name '*.word.lrc'` | 都没有 → 下载时就没抓（B 站音轨常见） |
| 内嵌标签 | `ffprobe -v quiet -show_entries format_tags=LYRICS -of json <file>` | 有值但**无 `[00:` 时间戳** → Navidrome WebUI 不显示 |
| 服务端状态 | `sqlite3 /volume1/docker/navidrome/data/navidrome.db "select title,substr(lyrics,1,120) from media_file where path like '%歌名%'"` | JSON 里 `line[].start` 存在 = 已同步；只有 `value` = 纯文本 |

数据库路径在本部署是 `/volume1/docker/navidrome/data/navidrome.db`（容器内 `/data/navidrome.db`），
只读打开：`sqlite3.connect('file:...?mode=ro', uri=True)`。

## 2. 修复：把 .lrc 写进内嵌标签

不要删 `.word.lrc`（逐字歌词是用户要的效果），也不要去改 Navidrome 插件配置。

```python
# python3 -m pip install mutagen（容器里没有 pip 命令，用 python3 -m pip）
from mutagen.flac import FLAC

flac_path = ".../01 ADDICT!ON.flac"
lrc_path  = ".../01 ADDICT!ON.lrc"

txt = open(lrc_path, encoding="utf-8").read().strip()
f = FLAC(flac_path)
f["LYRICS"] = txt          # 用带时间戳的 LRC 覆盖原来的纯文本
f.save()
```

- 先 `cp` 一份到 `/opt/data/cache/scratch/` 再改，改完用 `ffprobe` 确认 `LYRICS` 里出现 `[00:`
- mp3 用 `mutagen.id3.ID3` 的 `USLT` 帧，思路相同

## 2b. 用户要「逐字」效果时的命名与内嵌

用户明确说「逐字歌词是我要的效果」时，**不要把 `.word.lrc` 当成主文件**：客户端只按 `<base>.lrc` 查找，
`.word.lrc` 永远不在查找名单里，结果就是「逐字文件存在、播放器却用逐行」。正确布局：

- `<base>.lrc` = **逐字**（ELRC：`[00:00.00]<00:00.00>字<00:00.39>幕`）
- `<base>.line.lrc` = **逐行**（普通 LRC，给不认 `<...>` 的客户端兜底）

存量改名（先统一属主，否则 `os.rename` 会 `Permission denied`）：

```python
import os
for root, _, fs in os.walk(MUSIC_DIR):
    for f in fs:
        if not f.lower().endswith((".flac", ".mp3")):
            continue
        base = os.path.splitext(os.path.join(root, f))[0]
        word, line, linemark = base + ".word.lrc", base + ".lrc", base + ".line.lrc"
        if os.path.exists(word):
            if os.path.exists(line) and not os.path.exists(linemark):
                os.rename(line, linemark)   # 旧逐行 → .line.lrc
            os.rename(word, line)           # 逐字 → 标准名
```

内嵌逐字版本后，Navidrome 的 `media_file.lyrics` 会解析出**逐字 cue**，形如
`{"line":[{"start":0,"end":2960,"value":"...","cue":[{"start":0,"end":390,"value":"ADDICT!","byteStart":0,"byteEnd":6}, ...]}]}`
—— 看到 `cue` 就说明逐字生效了。

批量处理完后用两个计数交叉校验：`grep -rl '<00:' --include='*.lrc'`（逐字数）+ `.line.lrc` 数量（逐行兜底数），
两者应大致相等；差值就是「源站没有逐字歌词」的那批。

## 3. 让 Navidrome 重扫

Navidrome 的 `media_file.lyrics` 列是扫描时写入的，改完文件必须重扫：

```bash
docker restart navidrome     # 需要用户批准；启动时会做一次扫描
sleep 45                     # 512 首的库大约这个时间
```

验证（数据库里的 JSON 应出现 `start` 字段）：

```python
import sqlite3
c = sqlite3.connect('file:/volume1/docker/navidrome/data/navidrome.db?mode=ro', uri=True)
print(c.execute("select length(lyrics), substr(lyrics,1,120) from media_file where title like '%ADDICT%'").fetchone())
# 期望： [{"lang":"xxx","line":[{"start":0,"value":"..."},
```

然后让用户在 WebUI 刷新页面确认。**先修一首给用户看效果，确认后再批量**——
批量前备份，批量后只抽查 2-3 首 + 全库统计（多少首带 `start`）。

## 4. 已知限制（不要当成 bug 去「修」）

- 插件（如 nd-lyrics）抓的歌词 **WebUI 不显示**，只有第三方客户端（Feishin / Symfonium / substreamer）能看到
- `LyricsPriority` 默认是 `.ttml,.yaml,.yml,.elrc,.lrc,.srt,.txt,embedded`（0.63+），sidecar 优先；
  但如果内嵌的是纯文本、sidecar 又因为命名/权限没被读到，WebUI 就是「无歌词」
- sidecar 文件名必须与音频**同名**（`01 X.flac` → `01 X.lrc`）；`.word.lrc` 不会被当作 `.lrc` 匹配

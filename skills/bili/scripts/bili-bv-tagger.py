#!/usr/bin/env python3
"""给 B 站下载的音频补溯源标签：按「时长 ±2 秒」匹配 UP 的合集列表，写 BV 号。

用法：
    python3 bili-bv-tagger.py --dir /host-root/volume1/音乐/Bilibili/某UP --mid 1060544882
    python3 bili-bv-tagger.py --dir ... --mid ... --write     # 真正写标签

为什么按时长而不是标题：B 站同一视频有三套标题（视频标题 / 合集内名称 / 合集名），
下载时拿到的常是「合集内名称」，与现在 API 返回的标题可能完全不同。时长是唯一稳定的键。

依赖：astra（/opt/astra/bin/astra 或 PATH 里）、ffprobe、mutagen（python3 -m pip install mutagen）。
写标签前先统一属主，否则会 Permission denied：
    docker run --rm -v <音乐目录的宿主路径>:/m alpine sh -c \
      'find /m ! -user 1000 -exec chown 1000:10 {} +; find /m -type d -exec chmod 775 {} +'
"""
import argparse, json, os, re, subprocess, sys

ASTRA = "/opt/astra/bin/astra" if os.path.exists("/opt/astra/bin/astra") else "astra"
TOLERANCE = 2.0  # 秒


def run(args, timeout=180):
    r = subprocess.run([ASTRA] + args, capture_output=True, text=True, timeout=timeout)
    for line in r.stdout.splitlines():
        if line.strip().startswith("{"):
            try:
                return json.loads(line)
            except Exception:
                pass
    return None


def secs(d):
    m = re.match(r"(\d+):(\d+)", d or "")
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def local_duration(path):
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def build_pool(mid):
    """该 UP 所有合集里的 (bvid, title, 时长秒)"""
    pool, refs = [], []
    d = run(["bili", "space", str(mid)])
    for s in (d or {}).get("data", {}).get("seasons") or []:
        refs.append(s["ref"])
    for ref in refs:
        c = run(["bili", "collection", ref, "--limit", "300"], timeout=300)
        for it in (c or {}).get("data", {}).get("items") or []:
            s = secs(it.get("duration"))
            if s:
                pool.append({"bvid": it["bvid"], "title": it["title"], "secs": s, "ref": ref})
    return pool


def write_tags(path, bv):
    """只写 BVID + URL。标题/UP/日期都不写——三套标题都会变，只有 BVID 不可变。"""
    if path.lower().endswith(".flac"):
        from mutagen.flac import FLAC
        f = FLAC(path)
        f["BILIBILI_BVID"] = bv
        f["BILIBILI_URL"] = f"https://www.bilibili.com/video/{bv}"
        for stale in ("BILIBILI_ORIGINAL_TITLE", "BILIBILI_UPLOADER", "BILIBILI_TITLE_SNAPSHOT", "BILIBILI_SAVED_AT"):
            f.pop(stale, None)
        f.save()
    else:
        from mutagen.id3 import ID3, TXXX, ID3NoHeaderError
        try:
            t = ID3(path)
        except ID3NoHeaderError:
            t = ID3()
        for tag in ("TXXX:BILIBILI_BVID", "TXXX:BILIBILI_URL", "TXXX:BILIBILI_ORIGINAL_TITLE",
                    "TXXX:BILIBILI_UPLOADER", "TXXX:BILIBILI_TITLE_SNAPSHOT", "TXXX:BILIBILI_SAVED_AT"):
            t.delall(tag)
        t.add(TXXX(encoding=3, desc="BILIBILI_BVID", text=bv))
        t.add(TXXX(encoding=3, desc="BILIBILI_URL", text=f"https://www.bilibili.com/video/{bv}"))
        t.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="本地音频目录")
    ap.add_argument("--mid", required=True, help="UP 主 mid（从 bili space 或空间页 URL 取）")
    ap.add_argument("--write", action="store_true", help="真正写标签（默认只报告）")
    a = ap.parse_args()

    pool = build_pool(a.mid)
    print(f"候选池：{len(pool)} 个视频（来自该 UP 的全部合集）", file=sys.stderr)
    if not pool:
        print("候选池为空，检查 mid 或登录状态", file=sys.stderr)
        return 1

    matched, ambiguous, missing = [], [], []
    for fn in sorted(os.listdir(a.dir)):
        if not fn.lower().endswith((".mp3", ".flac", ".m4a")):
            continue
        path = os.path.join(a.dir, fn)
        dur = local_duration(path)
        hits = [p for p in pool if abs(p["secs"] - dur) <= TOLERANCE]
        songs = re.findall(r"《(.+?)》", fn)  # 用歌名做二次校验，排除时长巧合
        scored = sorted(hits, key=lambda p: -sum(1 for s in songs if s and s in p["title"]))
        if not scored:
            missing.append(fn)
            continue
        best = scored[0]
        song_ok = any(s and s in best["title"] for s in songs) if songs else True
        if len(scored) > 1 and not song_ok:
            ambiguous.append((fn, [p["bvid"] for p in scored]))
            continue
        matched.append((fn, best))
        if a.write:
            write_tags(path, best["bvid"])

    for fn, p in matched:
        print(f"✓ {p['bvid']:14} {fn[:56]}")
    for fn, cands in ambiguous:
        print(f"? {fn[:56]} → 多个同时长候选 {cands}，需人工确认")
    for fn in missing:
        print(f"✗ {fn[:56]} → 该 UP 合集里没有相同时长的视频（可能已删或不在合集）")
    print(f"\n匹配 {len(matched)} | 待确认 {len(ambiguous)} | 未匹配 {len(missing)}")
    if not a.write:
        print("（预演模式，加 --write 才会写标签）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

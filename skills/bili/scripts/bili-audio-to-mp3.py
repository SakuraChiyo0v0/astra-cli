#!/usr/bin/env python3
"""B 站音频（m4a）→ mp3 320k + 标签 + 内嵌封面，本库统一规格。

用法:
  bili-audio-to-mp3.py --dir <音频目录> --artist <UP名> [--album <专辑名>]
                        [--videos-json <合集接口原始 json>]

说明:
  - 目录里每个 *.m4a 就地转成同名 *.mp3（转成功才删 m4a），文件名保持视频原名。
  - --videos-json 给 astra/B 站合集接口的 items 数组（每项含 title / bvid / pic），
    按 NFKC + 去空白/斜杠归一化匹配文件名，命中就下载 pic 当封面内嵌。
    本库文件名里 '/ ' 会被 astra 换成 '_'，所以必须模糊匹配，不能用等号。
  - 标签固定 title=文件名（=视频原名）、artist=UP 名、album=UP 名或合集名。
"""
import argparse, json, os, re, subprocess, sys, unicodedata, urllib.request


def key(s):
    return re.sub(r"[\s/_／]", "", unicodedata.normalize("NFKC", s or ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--artist", required=True)
    ap.add_argument("--album", default=None)
    ap.add_argument("--videos-json", default=None)
    a = ap.parse_args()
    album = a.album or a.artist

    covers = {}
    if a.videos_json:
        raw = json.load(open(a.videos_json))
        items = raw.get("data", {}).get("items") if isinstance(raw, dict) else raw
        for v in items or []:
            if v.get("pic"):
                covers[key(v.get("title", ""))] = (v["pic"], v.get("bvid", "cover"))
    cache = os.path.join(os.path.dirname(os.path.abspath(a.dir)), ".covers")
    os.makedirs(cache, exist_ok=True)

    files = sorted(f for f in os.listdir(a.dir) if f.lower().endswith(".m4a"))
    ok = 0
    for f in files:
        base = f[:-4]
        src = os.path.join(a.dir, f)
        dst = os.path.join(a.dir, base + ".mp3")
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", src]
        hit = covers.get(key(base))
        if hit:
            pic, bvid = hit
            cover = os.path.join(cache, bvid + ".jpg")
            if not os.path.exists(cover):
                try:
                    urllib.request.urlretrieve(pic, cover)
                except Exception as e:
                    print("cover fail", bvid, e, file=sys.stderr)
                    cover = None
            if cover:
                cmd += ["-i", cover, "-map", "0:a", "-map", "1:v", "-c:v", "mjpeg"]
        cmd += ["-c:a", "libmp3lame", "-b:a", "320k",
                "-metadata", f"title={base}", "-metadata", f"artist={a.artist}",
                "-metadata", f"album={album}", "-id3v2_version", "3", dst]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode == 0 and os.path.getsize(dst) > 100_000:
            os.remove(src)
            ok += 1
            print("ok", base[:60], "cover" if hit else "no-cover")
        else:
            print("FAIL", base[:60], r.stderr[:160], file=sys.stderr)
    print(f"done {ok}/{len(files)}")


if __name__ == "__main__":
    main()

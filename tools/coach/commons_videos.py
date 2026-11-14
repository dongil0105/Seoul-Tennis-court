#!/usr/bin/env python3
"""위키미디어 공용의 테니스 영상을 받는다(기준 '움직임' 데이터의 원본). 원본 대신 공용이 만들어 둔 변환본(webm)을 받는다.

  python3 tools/coach/commons_videos.py --titles titles.txt --out /tmp/vid [--res 720p]
  titles.txt: 한 줄에 'File:이름.webm' 하나. 결과: <out>/videos.tsv (경로 \t 파일 제목 \t 받은 주소)
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "TennisFormResearch/0.1 (pose-keypoint study; polite crawler) python-urllib"


def get(url: str, tries: int = 5):
    for n in range(tries):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                return None
            retry = e.headers.get("Retry-After") if e.headers else None
            wait = int(retry) + 5 if retry and retry.isdigit() else 20 * (2 ** n)
            print(f"  HTTP {e.code} → {wait}초 쉼", file=sys.stderr)
            time.sleep(wait)
        except Exception as e:
            print(f"  {type(e).__name__} → 다시", file=sys.stderr)
            time.sleep(10 * (n + 1))
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--titles", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--res", default="720p")
    ap.add_argument("--gap", type=float, default=10.0)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    tsv = os.path.join(a.out, "videos.tsv")
    done = set()
    if os.path.exists(tsv):
        done = {l.split("\t")[1] for l in open(tsv, encoding="utf-8") if "\t" in l}
    with open(tsv, "a", encoding="utf-8") as out:
        for title in [l.strip() for l in open(a.titles, encoding="utf-8") if l.strip()]:
            if title in done:
                continue
            name = title.split(":", 1)[1].replace(" ", "_")
            h = hashlib.md5(name.encode("utf-8")).hexdigest()
            q = urllib.parse.quote(name)
            base = f"https://upload.wikimedia.org/wikipedia/commons/transcoded/{h[0]}/{h[:2]}/{q}/{q}"
            data, used = None, None
            for res in (a.res, "480p", "360p", "240p"):
                time.sleep(a.gap)
                url = f"{base}.{res}.vp9.webm"
                data = get(url)
                if data and len(data) > 20000:
                    used = url
                    break
            if not used:
                print(f"못 받음: {title}", file=sys.stderr)
                continue
            local = os.path.join(a.out, hashlib.sha1(title.encode()).hexdigest()[:16] + ".webm")
            with open(local, "wb") as f:
                f.write(data)
            out.write(f"{local}\t{title}\t{used}\n")
            out.flush()
            print(f"받음 {len(data) // 1024}KB: {title}", file=sys.stderr)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""위키미디어 공용 파일 설명 페이지에서 저작자·라이선스를 읽는다(대조군으로 보여 줄 사진의 출처 표기용).

  python3 tools/coach/commons_meta.py --titles titles.txt --out meta.json
  titles.txt: 한 줄에 'File:...' 하나. 이미 읽은 것은 건너뛴다(이어 하기).
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

UA = "TennisFormResearch/0.1 (pose-keypoint study; polite crawler) python-urllib"
_TAG = re.compile(r"<[^>]+>")


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(_TAG.sub(" ", s))).strip()[:120]


def parse(page: str) -> dict:
    out = {"author": None, "license": None, "licenseUrl": None}
    m = re.search(r'id="fileinfotpl_aut"[^>]*>.*?</td>\s*<td[^>]*>(.*?)</td>', page, re.S)
    if m:
        out["author"] = clean(m.group(1)) or None
    # 라이선스가 여러 개 붙은 사진(GFDL + CC 등)은 CC·퍼블릭 도메인을 먼저 고른다
    shorts = [clean(x) for x in re.findall(r'class="licensetpl_short"[^>]*>(.*?)</span>', page, re.S)]
    links = [clean(x) for x in re.findall(r'class="licensetpl_link"[^>]*>(.*?)</span>', page, re.S)]
    pick = next((i for i, x in enumerate(shorts) if re.search(r"CC|Public domain|PD", x)), 0)
    if shorts:
        out["license"] = shorts[pick] or None
        out["licenseUrl"] = links[pick] if pick < len(links) and links[pick].startswith("http") else None
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--titles", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--gap", type=float, default=1.2)
    a = ap.parse_args()
    meta = json.load(open(a.out, encoding="utf-8")) if os.path.exists(a.out) else {}
    titles = [l.strip() for l in open(a.titles, encoding="utf-8") if l.strip()]
    for n, title in enumerate(titles):
        if title in meta:
            continue
        url = "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"))
        page = None
        for k in range(4):
            time.sleep(a.gap)
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60) as r:
                    page = r.read().decode("utf-8", "replace")
                break
            except Exception as e:  # 429 등
                wait = 20 * (2 ** k)
                print(f"  {type(e).__name__} → {wait}초 쉼", file=sys.stderr)
                time.sleep(wait)
        if not page:
            continue
        info = parse(page.replace("&#95;", "_"))
        if info["license"]:                 # 라이선스를 읽은 것만 적는다
            meta[title] = info
        if n % 25 == 0:
            json.dump(meta, open(a.out, "w", encoding="utf-8"), ensure_ascii=False)
            print(f"  {n + 1}/{len(titles)} · 읽음 {len(meta)}", file=sys.stderr)
    json.dump(meta, open(a.out, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"끝: {len(meta)}/{len(titles)}", file=sys.stderr)


if __name__ == "__main__":
    main()

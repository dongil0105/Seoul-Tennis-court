#!/usr/bin/env python3
"""위키미디어 공용(Wikimedia Commons) 분류에서 테니스 선수 사진을 모은다 — 기준 자세 데이터의 원본.

- 분류 페이지(HTML)만 읽고, 사진은 공용이 권하는 표준 썸네일 크기(960px)로 받는다. 원본·API 는 쓰지 않는다.
- 사진은 썸네일 전용 주소(thumb.wikimedia.org)에서 받는다. upload.wikimedia.org 는 한 IP 에 분당 몇 장만 준다.
- 요청 사이를 띄우고(분류 페이지 1.2초, 사진 1.5초), 429 가 오면 Retry-After 만큼 쉰 뒤 다시 한다.
- 받은 사진은 저장소 밖(--out)에 둔다. 저장소에는 뼈대 수치와 출처만 올린다.

  python3 tools/coach/commons_collect.py --out /tmp/commons \
      --seed "Service (tennis)=serve" --seed "Forehand (tennis)=forehand" --seed "Backhand (tennis)=backhand" --depth 2

  결과: <out>/manifest.tsv (경로 \t 파일 제목 \t 스트로크 \t 분류 \t 받은 주소)
"""
from __future__ import annotations

import argparse
import hashlib
import html
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "TennisFormResearch/0.1 (pose-keypoint study; polite crawler) python-urllib"
BASE = "https://commons.wikimedia.org"
PHOTO_EXT = (".jpg", ".jpeg", ".png", ".webp")
VIDEO_EXT = (".webm", ".ogv", ".ogg", ".mp4", ".mov")

_FILE = re.compile(
    r'<a href="/wiki/(File:[^"]+)" class="mw-file-description"><img[^>]+src="https://(?:thumb|upload)\.wikimedia\.org'
    r'/wikipedia/commons/thumb/([0-9a-f])/([0-9a-f]{2})/([^/"]+)/(\d+)px-[^"?]+'
    r'[^>]*?(?:data-file-width="(\d+)")?')
_SUBCAT = re.compile(r'<a href="/wiki/(Category:[^"]+)" title="[^"]*">[^<]+</a></bdi> <span title="Contains[^"]*and ([\d,]+) files?"')
_NEXT = re.compile(r'<a href="(/w/index\.php\?title=[^"]*?filefrom=[^"]*)"[^>]*>next page</a>')
_VIDEO = re.compile(r'<a href="/wiki/(File:[^"]+\.(?:webm|ogv|WEBM|OGV))"')


def fetch(url: str, gap: float, binary: bool = False, tries: int = 5):
    for n in range(tries):
        time.sleep(gap)
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
                return data if binary else data.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 404 or e.code == 400:
                return None
            retry = e.headers.get("Retry-After") if e.headers else None
            wait = (int(retry) + 5 if retry and retry.isdigit() else 20 * (2 ** n)) if e.code == 429 else 5 * (n + 1)
            print(f"  HTTP {e.code} → {wait}초 쉼: {url[:90]}", file=sys.stderr)
            time.sleep(wait)
        except Exception as e:  # 연결 끊김 등
            print(f"  {type(e).__name__} → 다시: {url[:90]}", file=sys.stderr)
            time.sleep(5 * (n + 1))
    return None


def crawl_category(title: str, gap: float):
    """분류 한 곳의 (사진들, 하위 분류들, 영상들). 사진 = (파일 제목, 해시 경로 a, ab, 이름)."""
    files, subs, videos = [], [], []
    url = f"{BASE}/wiki/Category:{urllib.parse.quote(title.replace(' ', '_'))}"
    seen_pages = 0
    while url and seen_pages < 40:
        page = fetch(url, gap)
        seen_pages += 1
        if not page:
            break
        for m in _FILE.finditer(page):
            files.append((urllib.parse.unquote(m.group(1)), m.group(2), m.group(3), m.group(4)))
        for m in _VIDEO.finditer(page):
            videos.append(urllib.parse.unquote(m.group(1)))
        if seen_pages == 1:
            for m in _SUBCAT.finditer(page):
                subs.append((urllib.parse.unquote(m.group(1))[len("Category:"):].replace("_", " "), int(m.group(2).replace(",", ""))))
        nxt = _NEXT.search(page)
        url = BASE + html.unescape(nxt.group(1)).split("#")[0] if nxt else None
    return files, subs, videos


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", action="append", required=True, help='"분류 이름=스트로크" (serve|forehand|backhand|mixed)')
    ap.add_argument("--depth", type=int, default=1)
    ap.add_argument("--max", type=int, default=5000, help="받을 사진 수 상한")
    ap.add_argument("--width", type=int, default=960, choices=[500, 960, 1280])
    ap.add_argument("--gap", type=float, default=1.2)
    ap.add_argument("--per-cat", type=int, default=0, dest="per_cat", help="분류 한 곳에서 받을 사진 수 상한(0 = 전부). 선수 분류처럼 사진이 많은 곳에 쓴다.")
    ap.add_argument("--img-gap", type=float, default=1.5, dest="img_gap",
                    help="사진 사이 쉬는 초. 썸네일 전용 주소(thumb.wikimedia.org)는 이 정도면 429 가 안 난다.")
    ap.add_argument("--skip", default="wheelchair|padel|table|beach|soft tennis|real tennis|pickleball|platform tennis")
    a = ap.parse_args()

    img_dir = os.path.join(a.out, "img")
    os.makedirs(img_dir, exist_ok=True)
    manifest_path = os.path.join(a.out, "manifest.tsv")
    done = set()
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as f:
            done = {line.split("\t")[1] for line in f if "\t" in line}
    skip = re.compile(a.skip, re.I)

    # ① 분류 페이지를 먼저 다 읽어 사진 목록을 만든다(스트로크별로 따로)
    queue = []
    for s in a.seed:
        cat, _, stroke = s.partition("=")
        queue.append((cat.strip(), stroke.strip() or "mixed", 0))
    seen_cats, got = set(), len(done)
    lists: dict[str, list] = {}
    videos_path = os.path.join(a.out, "videos.tsv")
    with open(videos_path, "a", encoding="utf-8") as vf:
        while queue:
            cat, stroke, depth = queue.pop(0)
            if cat in seen_cats or skip.search(cat):
                continue
            seen_cats.add(cat)
            files, subs, videos = crawl_category(cat, a.gap)
            print(f"[{cat}] 사진 {len(files)} · 하위 분류 {len(subs)} · 영상 {len(videos)}", file=sys.stderr)
            for v in videos:
                vf.write(f"{v}\t{stroke}\t{cat}\n")
            if depth < a.depth:
                for sub, _n in subs:
                    queue.append((sub, stroke, depth + 1))
            taken = 0
            for title, h1, h2, name in files:
                if title in done or not title.lower().endswith(PHOTO_EXT) or skip.search(title):
                    continue
                if a.per_cat and taken >= a.per_cat:
                    break
                taken += 1
                done.add(title)
                lists.setdefault(stroke, []).append((title, h1, h2, name, cat))

    # ② 스트로크를 번갈아 가며 받는다(중간에 멈춰도 한쪽으로 쏠리지 않게)
    order = []
    while any(lists.values()):
        for stroke in list(lists):
            if lists[stroke]:
                order.append((stroke, lists[stroke].pop(0)))
    print(f"받을 사진 {len(order)}장", file=sys.stderr)
    with open(manifest_path, "a", encoding="utf-8") as mf:
        for stroke, (title, h1, h2, name, cat) in order:
            if got >= a.max:
                break
            local = os.path.join(img_dir, hashlib.sha1(title.encode()).hexdigest()[:16] + ".jpg")
            url = None
            for w in (a.width, 500):   # 원본이 작으면 큰 썸네일이 없다 → 한 단계 작은 것으로
                u = f"https://thumb.wikimedia.org/wikipedia/commons/thumb/{h1}/{h2}/{name}/{w}px-{name}"
                data = fetch(u, a.img_gap, binary=True, tries=4)
                if data and len(data) > 2000:
                    with open(local, "wb") as f:
                        f.write(data)
                    url = u
                    break
            if not url:
                continue
            mf.write(f"{local}\t{title}\t{stroke}\t{cat}\t{url}\n")
            mf.flush()
            got += 1
            if got % 50 == 0:
                print(f"  받은 사진 {got}", file=sys.stderr)
    print(f"끝: 사진 {got}장 · 분류 {len(seen_cats)}곳 → {manifest_path}", file=sys.stderr)


if __name__ == "__main__":
    main()

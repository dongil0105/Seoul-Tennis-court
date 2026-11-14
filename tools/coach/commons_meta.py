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


_CAT = re.compile(r'<a href="/wiki/Category:[^"]+" title="Category:([^"]+)"')
_NOT_PERSON = re.compile(r"\d|tennis|open|cup|championship|tournament|players|photograph|files|images|quality|court|stadium|masters|slam|olympic|"
                         r"wimbledon|roland|garros|league|club|team|sport|people|men|women|taken|uploaded|license|cc-|flickr|self-published|"
                         r"\b(in|at|by|of|with|from|the|and|for)\b", re.I)


def categories(page: str) -> list[str]:
    i = page.find('id="mw-normal-catlinks"')
    if i < 0:
        return []
    j = page.find("</div>", i)
    return [html.unescape(x) for x in _CAT.findall(page[i:j if j > 0 else i + 6000])]


def sex_from(cats: list[str]) -> str | None:
    text = " | ".join(cats).lower()
    f = bool(re.search(r"female tennis|women's|womens|\(women\)|ladies|wta", text))
    m = bool(re.search(r"\bmale tennis|\bmen's|\bmens\b|\(men\)|\batp\b", text))
    return "F" if f and not m else "M" if m and not f else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--titles", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--gap", type=float, default=1.2)
    a = ap.parse_args()
    meta = json.load(open(a.out, encoding="utf-8")) if os.path.exists(a.out) else {}
    people_path = a.out + ".people.json"
    people = json.load(open(people_path, encoding="utf-8")) if os.path.exists(people_path) else {}
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
        page = page.replace("&#95;", "_")
        info = parse(page)
        # 누구인지·성별: 파일의 분류에서 바로 알 수 있으면 그것을, 아니면 사람 이름처럼 생긴 분류 페이지를 한 번 읽어 본다(이름마다 한 번)
        cats = categories(page)
        info["sex"] = sex_from(cats)
        names = []
        for c in cats:                       # "Ana Ivanovic in 2009", "Rafael Nadal at the 2008 BNP Paribas Masters" → 앞의 이름만
            base = re.sub(r"\s+(in \d{4}|at (the )?.*|during .*|playing .*|serving.*)$", "", c).strip()
            if base and base not in names and not _NOT_PERSON.search(base) and 2 <= len(base.split()) <= 4:
                names.append(base)
        for name in names[:3]:
            if name not in people:
                people[name] = None
                try:
                    time.sleep(a.gap)
                    u2 = "https://commons.wikimedia.org/wiki/Category:" + urllib.parse.quote(name.replace(" ", "_"))
                    with urllib.request.urlopen(urllib.request.Request(u2, headers={"User-Agent": UA}), timeout=60) as r:
                        people[name] = sex_from(categories(r.read().decode("utf-8", "replace").replace("&#95;", "_")))
                except Exception:
                    pass
            if people[name]:
                info["person"] = name
                info["sex"] = info["sex"] or people[name]
                break
        if info["license"]:                 # 라이선스를 읽은 것만 적는다
            meta[title] = info
        if n % 25 == 0:
            json.dump(meta, open(a.out, "w", encoding="utf-8"), ensure_ascii=False)
            print(f"  {n + 1}/{len(titles)} · 읽음 {len(meta)}", file=sys.stderr)
    json.dump(meta, open(a.out, "w", encoding="utf-8"), ensure_ascii=False)
    json.dump(people, open(people_path, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"끝: {len(meta)}/{len(titles)} · 성별 알아낸 사진 {sum(1 for v in meta.values() if v.get('sex'))}", file=sys.stderr)


if __name__ == "__main__":
    main()

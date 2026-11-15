#!/usr/bin/env python3
"""'화면 보고 학습'이 사이트의 중계함에 맡겨 둔 묶음을 가져온다.

  COACH_KEY=<열쇠> python tools/coach/learn_pull.py https://seoul-tennis-court.onrender.com <받을 폴더> [--keep]

가져온 묶음은 <받을 폴더>/<번호>.json 으로 풀어 두고, 서버에서는 지운다(지우면 '가져갔음' 표시가 남아 보낸 브라우저가 자기 보관분을 비운다).
--keep 을 주면 지우지 않는다. 열쇠는 환경 변수로만 받는다(저장소·기록에 남기지 않는다).
무료 서버는 다시 켜질 때 디스크가 비워지므로, 보는 동안 또는 본 직후에 가져와야 한다(브라우저 안 보관분은 '다시 맞춰 보내기'로 다시 온다).
"""
import gzip
import json
import os
import sys
import urllib.error
import urllib.request


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    keep = "--keep" in sys.argv
    if len(args) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    base, out = args[0].rstrip("/"), args[1]
    key = "".join(ch for ch in os.environ.get("COACH_KEY", "").upper() if ch.isascii() and ch.isalnum())
    if not key:
        print("COACH_KEY 환경 변수에 열쇠를 넣어 주세요.", file=sys.stderr)
        return 2
    os.makedirs(out, exist_ok=True)
    headers = {"Cookie": f"coach_key={key}", "User-Agent": "swing-coach-learn/1"}

    def call(path: str, method: str = "GET") -> bytes:
        req = urllib.request.Request(base + path, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read()

    try:
        items = json.loads(call("/coach/learn"))["items"]
    except urllib.error.HTTPError as e:
        print(f"목록을 받지 못함: HTTP {e.code}" + (" (열쇠가 맞지 않음)" if e.code == 403 else ""), file=sys.stderr)
        return 1
    got = new = 0
    for m in items:
        dst = os.path.join(out, m["id"] + ".json")
        if not os.path.exists(dst):
            raw = call(f"/coach/learn/{m['id']}")
            text = gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw
            json.loads(text)                                   # 깨진 묶음이면 여기서 멈춘다(지우지 않는다)
            with open(dst + ".part", "wb") as f:
                f.write(text)
            os.replace(dst + ".part", dst)
            new += 1
        got += 1
        if not keep:
            call(f"/coach/learn/{m['id']}", "DELETE")
    print(f"서버에 있던 묶음 {len(items)}개 · 새로 받은 것 {new}개 · {'서버에 그대로 둠' if keep else '서버에서 지움(가져갔음 표시)'} → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

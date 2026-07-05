"""강남구 통합예약 테니스장 페이지 구조 확인용 프로브.

용도: 비로그인 상태에서 슬롯 조회가 가능한지 + 실제 HTML/JSON 구조를 눈으로 확인해
collectors/gangnam.py 의 _parse()를 채운다. 자동수집이 아니라 사람이 1회 확인하는 용도.

실행: python -m scripts.probe_gangnam
주의: 저빈도로만. 결과가 로그인 페이지로 리다이렉트되면 이 소스는 link-only로 강등한다.
"""
from __future__ import annotations

import sys

import httpx

from app.collectors.gangnam import TENNIS_PAGES
from app.config import settings


def main() -> int:
    ua = settings.crawl_user_agent
    for url in TENNIS_PAGES:
        print(f"\n[probe] GET {url}")
        try:
            resp = httpx.get(url, headers={"User-Agent": ua}, timeout=15.0, follow_redirects=True)
        except httpx.HTTPError as exc:
            print(f"  실패: {type(exc).__name__}: {exc}", file=sys.stderr)
            continue
        print(f"  status={resp.status_code} final_url={resp.url}")
        body = resp.text
        login_hint = any(k in body for k in ("로그인", "login", "signin"))
        print(f"  길이={len(body)} 로그인유도흔적={login_hint}")
        print("  --- 앞부분 600자 ---")
        print(body[:600])
    print("\n확인 포인트: (1)로그인 없이 슬롯이 보이는가 (2)날짜/시간/코트 selector (3)자격/유료 안내")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

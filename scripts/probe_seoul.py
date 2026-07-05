"""OA-2266 응답 구조 1회 확인용 프로브.

용도: 실제 응답 필드명을 눈으로 확인해 collectors/seoul_api.py 의 FIELD_MAP을 확정한다.
실행: python -m scripts.probe_seoul   (프로젝트 루트에서, .env에 SEOUL_API_KEY 필요)
"""
from __future__ import annotations

import json
import sys

import httpx

from app.config import settings


def main() -> int:
    if not settings.seoul_api_key:
        print("SEOUL_API_KEY 가 비어 있습니다. .env를 설정하세요.", file=sys.stderr)
        return 1

    url = (
        f"{settings.seoul_api_base}/{settings.seoul_api_key}/json/"
        f"{settings.seoul_service_name}/1/5/"
    )
    print(f"[probe] GET {settings.seoul_api_base}/***/json/{settings.seoul_service_name}/1/5/")
    try:
        resp = httpx.get(url, timeout=15.0)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        print(f"호출 실패: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    data = resp.json()
    block = data.get(settings.seoul_service_name, data)
    print("\n=== 최상위 키 ===")
    print(list(data.keys()))
    if isinstance(block, dict):
        print("\n=== RESULT ===")
        print(block.get("RESULT"))
        rows = block.get("row") or []
        print(f"\n=== row 개수: {len(rows)} ===")
        if rows:
            print("\n=== 첫 행의 모든 필드명/값 ===")
            print(json.dumps(rows[0], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""관심 지역(서초·강남·성동·용산) + 한남·장충 코트가 OA-2266에 있는지,
'안내중'(예약 시작 전) 서비스의 접수 시작일(RCPTBGNDT)이 미래로 잡히는지 확인.

실행: python -m scripts.analyze_watch
"""
from __future__ import annotations

from datetime import datetime

import httpx

from app.config import settings

REGIONS = ("서초구", "강남구", "성동구", "용산구", "중구")
KEYWORDS = ("한남", "장충")


def main() -> int:
    url = (
        f"{settings.seoul_api_base}/{settings.seoul_api_key}/json/"
        f"{settings.seoul_service_name}/1/1000/"
    )
    data = httpx.get(url, timeout=20).json()
    rows = data.get(settings.seoul_service_name, {}).get("row", [])
    tennis = [
        r for r in rows
        if "테니스" in (str(r.get("MINCLASSNM", "")) + str(r.get("SVCNM", "")) + str(r.get("PLACENM", "")))
    ]
    print(f"테니스 전체 {len(tennis)}건")

    print("\n=== 지역별 서비스 수 (관심 지역) ===")
    for g in REGIONS:
        rs = [r for r in tennis if r.get("AREANM") == g]
        st = {}
        for r in rs:
            st[r.get("SVCSTATNM")] = st.get(r.get("SVCSTATNM"), 0) + 1
        print(f"  {g}: {len(rs)}건 {st}")

    print("\n=== 키워드(한남/장충) 매칭 ===")
    for kw in KEYWORDS:
        rs = [r for r in tennis if kw in str(r.get("SVCNM", "")) + str(r.get("PLACENM", ""))]
        print(f"  '{kw}': {len(rs)}건")
        for r in rs[:6]:
            print(f"    - [{r.get('AREANM')}] {str(r.get('SVCNM'))[:42]} | {r.get('SVCSTATNM')} | 접수시작 {str(r.get('RCPTBGNDT'))[:16]}")

    now = datetime.now()
    print("\n=== '안내중' 전체 (예약 시작 전 후보) ===")
    guide = [r for r in tennis if r.get("SVCSTATNM") == "안내중"]
    for r in guide:
        print(f"  [{r.get('AREANM')}] {str(r.get('SVCNM'))[:40]} | 접수 {str(r.get('RCPTBGNDT'))[:16]} ~")

    print("\n=== 접수시작일이 '미래'인 서비스 (상태 무관) ===")
    fut = []
    for r in tennis:
        try:
            dt = datetime.strptime(str(r.get("RCPTBGNDT"))[:19], "%Y-%m-%d %H:%M:%S")
        except (ValueError, TypeError):
            continue
        if dt > now:
            fut.append((dt, r))
    fut.sort(key=lambda x: x[0])
    print(f"  {len(fut)}건")
    for dt, r in fut[:15]:
        print(f"  {dt:%m/%d %H:%M} 오픈 | [{r.get('AREANM')}] {str(r.get('SVCNM'))[:38]} | {r.get('SVCSTATNM')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

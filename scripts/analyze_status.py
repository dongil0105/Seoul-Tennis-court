"""OA-2266 '접수중' 상태의 실제 유효성 분석 — 접수기간/운영기간과 대조.

용도: '접수중'으로 떠도 실제 예약 불가인 건이 얼마나 되는지 파악해
_is_open 판정을 강화할 근거를 만든다. (사람이 1회 실행하는 분석 스크립트)
실행: python -m scripts.analyze_status
"""
from __future__ import annotations

import collections
from datetime import datetime

import httpx

from app.config import settings


def parse_dt(s: object) -> datetime | None:
    try:
        return datetime.strptime(str(s)[:19], "%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError):
        return None


def main() -> int:
    url = (
        f"{settings.seoul_api_base}/{settings.seoul_api_key}/json/"
        f"{settings.seoul_service_name}/1/1000/"
    )
    data = httpx.get(url, timeout=15).json()
    rows = data.get(settings.seoul_service_name, {}).get("row", [])
    tennis = [
        r for r in rows
        if "테니스" in (str(r.get("MINCLASSNM", "")) + str(r.get("SVCNM", "")))
    ]
    print(f"테니스 전체: {len(tennis)}")
    print()
    print("=== 접수상태(SVCSTATNM) 분포 ===")
    for k, v in collections.Counter(r.get("SVCSTATNM") for r in tennis).most_common():
        print(f"  {k}: {v}건")
    print()

    now = datetime.now()
    recv = [r for r in tennis if r.get("SVCSTATNM") == "접수중"]
    past_end = [r for r in recv if (parse_dt(r.get("RCPTENDDT")) or now) < now]
    not_started = [r for r in recv if (parse_dt(r.get("RCPTBGNDT")) or now) > now]
    svc_ended = [r for r in recv if (parse_dt(r.get("SVCOPNENDDT")) or now) < now]
    print("=== [접수중] 인데 실제로는? ===")
    print(f"접수 마감일 지남: {len(past_end)}")
    print(f"접수 시작 전: {len(not_started)}")
    print(f"서비스 운영기간 종료: {len(svc_ended)}")
    print()
    print("=== 접수중 샘플 3건의 기간 필드 ===")
    for r in recv[:3]:
        name = str(r.get("SVCNM", ""))[:40]
        print(f"  {name}")
        print(f"    접수기간: {r.get('RCPTBGNDT')} ~ {r.get('RCPTENDDT')}")
        print(f"    운영기간: {r.get('SVCOPNBGNDT')} ~ {r.get('SVCOPNENDDT')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

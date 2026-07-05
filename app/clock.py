"""시각 단일화 — 앱 전체가 KST(Asia/Seoul) 기준 naive datetime을 쓴다.

타임존 혼선(C-1)을 막기 위해 저장·비교·무음시간 판정 모두 이 now()를 사용한다.
한국은 DST가 없으므로 고정 오프셋(+9)으로 충분하며, 외부 tz 데이터베이스가 필요 없어
Windows/Docker 어디서나 동일하게 동작한다.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))


def now() -> datetime:
    """현재 KST 시각을 naive datetime으로 반환(전 모듈 공통 기준)."""
    return datetime.now(KST).replace(tzinfo=None)

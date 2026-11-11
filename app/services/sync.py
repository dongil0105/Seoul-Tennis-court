"""공식 데이터(OA-2266) 즉시 다시 받기 — 앱의 [새로 고침]·날짜 누를 때 자동 갱신용.

정기 수집(7분)과 같은 경로를 쓰고, 여러 사람이 눌러도 공식 API를 과하게 부르지 않게
COOLDOWN 초 안에는 다시 받지 않는다(서울시 예약 사이트에는 접속하지 않는다).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from app.clock import now as _now

logger = logging.getLogger("tennis.sync")

COOLDOWN = 90          # 초
FAIL_COOLDOWN = 20     # 초 — 수집이 실패하거나 비었을 때 곧바로 다시 부르지 않게
_LAST: datetime | None = None
_LAST_FAIL: datetime | None = None
_FAIL_REASON = ""
# 소스별 마지막으로 성공한 수집 회차 시각(diff.upsert 가 그 회차 모든 행의 last_seen 에 같은 값을 찍음).
BATCH: dict[str, datetime] = {}
# 공식 응답은 정상인데 테니스 서비스가 0건이었던 마지막 시각(실패와 구분). 이보다 오래된 행은 숨긴다.
EMPTY_OK: dict[str, datetime] = {}
_LOCK = asyncio.Lock()


def mark() -> None:
    """공식 데이터를 새로 받아 DB에 반영한 시각 기록."""
    global _LAST
    _LAST = _now()


def last_sync() -> str:
    return _LAST.strftime("%Y-%m-%d %H:%M:%S") if _LAST else ""


def _fresh_enough() -> bool:
    return _LAST is not None and (_now() - _LAST).total_seconds() < COOLDOWN


def _failed_recently() -> bool:
    return _LAST_FAIL is not None and 0 <= (_now() - _LAST_FAIL).total_seconds() < FAIL_COOLDOWN


def _fail(reason: str) -> dict:
    global _LAST_FAIL, _FAIL_REASON
    _LAST_FAIL, _FAIL_REASON = _now(), reason
    return {"refreshed": False, "reason": reason, "updated_at": last_sync()}


async def refresh() -> dict:
    """쿨다운이 지났으면 공식 데이터를 다시 받아 반영. 결과와 기준 시각을 돌려준다."""
    if _fresh_enough():
        return {"refreshed": False, "reason": "recent", "updated_at": last_sync()}
    if _failed_recently():    # 방금 실패 — 여러 사람이 눌러도 공식 API를 연달아 부르지 않는다
        return {"refreshed": False, "reason": _FAIL_REASON, "updated_at": last_sync()}
    async with _LOCK:
        if _fresh_enough():   # 기다리는 동안 다른 요청이 이미 받음
            return {"refreshed": False, "reason": "recent", "updated_at": last_sync()}
        if _failed_recently():
            return {"refreshed": False, "reason": _FAIL_REASON, "updated_at": last_sync()}
        from app.collectors.registry import collect
        from app.db import get_session
        from app.services.diff import upsert_and_extract_new
        try:
            raw = await collect(tiers={1})
        except Exception as e:  # noqa: BLE001
            logger.warning("즉시 갱신 실패: %s", e)
            return _fail("error")
        if not raw:
            return _fail("empty")
        with get_session() as session:
            upsert_and_extract_new(session, raw)
            session.commit()
        mark()
        return {"refreshed": True, "reason": "", "updated_at": last_sync()}

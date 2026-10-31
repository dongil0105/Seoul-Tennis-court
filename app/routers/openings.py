"""오픈 일정(/openings) + 날짜로 코트 찾기(/available) API — 읽기 전용."""
from __future__ import annotations

from datetime import date as date_cls

from fastapi import APIRouter, HTTPException

from app.db import get_session
from app.services import openings as OP
from app.services import sync as SYNC

router = APIRouter()


@router.get("/openings")
def get_openings() -> dict:
    """관심 코트의 예약 오픈 일정(오늘/내일/예정/접수중/마감) + 배지 숫자."""
    with get_session() as session:
        return OP.overview(session)


@router.get("/board")
def get_board() -> dict:
    """5곳 전용 화면: 다음 예약 오픈 + 지금 예약 가능한 코트 번호."""
    with get_session() as session:
        return OP.board(session)


@router.post("/refresh")
async def post_refresh() -> dict:
    """공식 데이터를 지금 다시 받는다(90초 쿨다운). 화면의 [새로 고침]·날짜 자동 갱신용."""
    return await SYNC.refresh()


@router.get("/calendar")
def get_calendar(days: int = 30, all: int = 0) -> dict:
    """오늘부터 N일, 날짜마다 칠 수 있는 장소 수(날짜용 회차 / 상시 / 마감 / 오픈 예정)."""
    with get_session() as session:
        return OP.calendar(session, days=days, watched_only=(all != 1))


@router.get("/available")
def get_available(date: str, part: str = "", all: int = 0) -> dict:
    """날짜(+시간대 새벽|주간|야간)를 고르면 그날 예약 접수가 열린 코트 후보를 반환."""
    try:
        target = date_cls.fromisoformat(date)
    except ValueError:
        raise HTTPException(status_code=400, detail="date는 YYYY-MM-DD 형식")
    p = part.strip() or None
    if p and p not in ("새벽", "주간", "야간"):
        raise HTTPException(status_code=400, detail="part는 새벽|주간|야간")
    with get_session() as session:
        return OP.available(session, target, part=p, watched_only=(all != 1))

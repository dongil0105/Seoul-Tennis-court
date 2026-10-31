"""오픈 일정(/openings) + 날짜로 코트 찾기(/available) API — 읽기 전용."""
from __future__ import annotations

from datetime import date as date_cls

from fastapi import APIRouter, HTTPException

from app.db import get_session
from app.services import openings as OP

router = APIRouter()


@router.get("/openings")
def get_openings() -> dict:
    """관심 코트의 예약 오픈 일정(오늘/내일/예정/접수중/마감) + 배지 숫자."""
    with get_session() as session:
        return OP.overview(session)


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

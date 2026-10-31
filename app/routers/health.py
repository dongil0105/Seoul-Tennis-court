"""헬스체크."""
from __future__ import annotations

from fastapi import APIRouter

from app.clock import now as _now
from app.services.notifier import kakao_ready

router = APIRouter()


@router.get("/health")
def health() -> dict:
    # kakao = 알람 발송 가능 여부(키 존재 여부만, 값은 노출하지 않음)
    return {"status": "ok", "kakao": kakao_ready(), "time": _now().isoformat()}

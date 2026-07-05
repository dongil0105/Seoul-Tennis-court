"""헬스체크."""
from __future__ import annotations

from fastapi import APIRouter

from app.clock import now as _now

router = APIRouter()


@router.get("/health")
def health() -> dict:
    return {"status": "ok", "time": _now().isoformat()}

"""내 알림 조건(user_filter) CRUD."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator
from sqlmodel import select

from app.config import settings
from app.db import get_session
from app.models import UserFilter

router = APIRouter(prefix="/filters")


def _block_if_readonly() -> None:
    """공개 배포(PUBLIC_READONLY)에서는 쓰기 차단 — 남이 내 알림조건을 못 바꾸게."""
    if settings.public_readonly:
        raise HTTPException(status_code=403, detail="읽기 전용 모드입니다(공개 배포).")


class FilterIn(BaseModel):
    name: str = "default"
    gus: list[str] = []
    weekdays: list[int] = []
    time_from: str | None = None
    time_to: str | None = None
    include_night: bool = True
    exclude_paid: bool = False
    exclude_restricted: bool = False
    enabled: bool = True

    @field_validator("weekdays")
    @classmethod
    def _check_weekdays(cls, v: list[int]) -> list[int]:
        if any(d < 0 or d > 6 for d in v):
            raise ValueError("weekdays는 0(월)~6(일) 범위")
        return v


def _to_out(f: UserFilter) -> dict:
    return {
        "id": f.id,
        "name": f.name,
        "gus": json.loads(f.gus or "[]"),
        "weekdays": json.loads(f.weekdays or "[]"),
        "time_from": f.time_from,
        "time_to": f.time_to,
        "include_night": f.include_night,
        "exclude_paid": f.exclude_paid,
        "exclude_restricted": f.exclude_restricted,
        "enabled": f.enabled,
    }


@router.get("")
def list_filters() -> list[dict]:
    with get_session() as session:
        return [_to_out(f) for f in session.exec(select(UserFilter)).all()]


@router.post("")
def create_filter(body: FilterIn) -> dict:
    _block_if_readonly()
    with get_session() as session:
        f = UserFilter(
            name=body.name,
            gus=json.dumps(body.gus, ensure_ascii=False),
            weekdays=json.dumps(body.weekdays),
            time_from=body.time_from,
            time_to=body.time_to,
            include_night=body.include_night,
            exclude_paid=body.exclude_paid,
            exclude_restricted=body.exclude_restricted,
            enabled=body.enabled,
        )
        session.add(f)
        session.commit()
        session.refresh(f)
        return _to_out(f)


@router.delete("/{filter_id}")
def delete_filter(filter_id: int) -> dict:
    _block_if_readonly()
    with get_session() as session:
        f = session.get(UserFilter, filter_id)
        if f is None:
            raise HTTPException(status_code=404, detail="필터 없음")
        session.delete(f)
        session.commit()
        return {"deleted": filter_id}

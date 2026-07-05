"""필터 매칭 — 구/요일/시간대/야간 조건으로 슬롯을 거른다."""
from __future__ import annotations

import json
from datetime import date as date_cls

from app.models import Slot, UserFilter


def _parse_list(raw: str) -> list:
    try:
        v = json.loads(raw or "[]")
        return v if isinstance(v, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _slot_start_minutes(slot: Slot) -> int | None:
    """슬롯 시작 시각(분)을 추출. 파싱 불가 시 None."""
    raw = slot.time_start or ""
    digits = "".join(ch for ch in raw if ch.isdigit())
    if len(digits) < 2:
        return None
    try:
        hh = int(digits[:2])
        mm = int(digits[2:4]) if len(digits) >= 4 else 0
    except ValueError:
        return None
    return hh * 60 + mm


def _hhmm_to_minutes(s: str | None) -> int | None:
    if not s or ":" not in s:
        return None
    try:
        hh, mm = s.split(":", 1)
        return int(hh) * 60 + int(mm)
    except ValueError:
        return None


def _slot_weekday(slot: Slot) -> int | None:
    """YYYY-MM-DD → 요일(월=0…일=6). 파싱 불가 시 None."""
    try:
        y, m, d = slot.date.split("-")
        return date_cls(int(y), int(m), int(d)).weekday()
    except (ValueError, AttributeError):
        return None


def match_one(slot: Slot, f: UserFilter) -> bool:
    """슬롯이 단일 필터를 만족하는지."""
    if not f.enabled:
        return False

    # 구(지역)
    gus = _parse_list(f.gus)
    if gus and (slot.region or "") not in gus:
        return False

    # 야간 포함 여부
    if slot.is_night and not f.include_night:
        return False

    # 자격/유료 제외 (헛알림 방지)
    if f.exclude_paid and slot.is_paid:
        return False
    if f.exclude_restricted and slot.eligibility:
        return False

    # 요일
    weekdays = _parse_list(f.weekdays)
    if weekdays:
        wd = _slot_weekday(slot)
        if wd is None or wd not in weekdays:
            return False

    # 시간대
    start = _slot_start_minutes(slot)
    tf = _hhmm_to_minutes(f.time_from)
    tt = _hhmm_to_minutes(f.time_to)
    if tf is not None or tt is not None:
        if start is None:
            return False
        if tf is not None and start < tf:
            return False
        if tt is not None and start > tt:
            return False

    return True


def match_filters(slot: Slot, filters: list[UserFilter]) -> bool:
    """필터가 하나도 없으면 전체 통과. 있으면 OR(하나라도 만족하면 통과)."""
    active = [f for f in filters if f.enabled]
    if not active:
        return True
    return any(match_one(slot, f) for f in active)

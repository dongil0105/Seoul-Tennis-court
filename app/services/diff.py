"""Diff 엔진 — 스냅샷 갱신 + '새로 빈 슬롯' 추출.

규칙(설계서 §5):
- slot_hash가 notified_slot에 없고 is_open=true 면 '최초 빈 슬롯' → 알림 후보.
- allow_reopen=true 이고 직전 was_open=false→true(취소표 재오픈)면 재알림 후보.
- notified_slot 기록은 '발송 성공 후' notifier 쪽에서 수행(여기서는 후보 추출만).
"""
from __future__ import annotations

from sqlmodel import Session, select

from app.clock import now as _now
from app.collectors.base import SlotDTO
from app.models import NotifiedSlot, Slot


def upsert_and_extract_new(
    session: Session,
    slots: list[SlotDTO],
    allow_reopen: bool = False,
) -> list[Slot]:
    """현재 스냅샷을 slot 테이블에 반영하고 알림 후보를 반환.

    부수효과: slot 행 insert/update(커밋은 호출측 책임). 반환은 알림 후보 Slot 목록.
    """
    now = _now()
    candidates: list[Slot] = []
    current_hashes = {ns.hash for ns in slots}
    current_sources = {ns.source_id for ns in slots}

    # 이미 알린 해시 집합(조회 1회로 N+1 방지)
    notified_hashes = set(session.exec(select(NotifiedSlot.slot_hash)).all())

    for ns in slots:
        h = ns.hash
        row = session.exec(select(Slot).where(Slot.slot_hash == h)).first()

        if row is None:
            row = Slot(
                slot_hash=h,
                source_id=ns.source_id,
                tier=ns.tier,
                facility_name=ns.facility_name,
                court_name=ns.court_name,
                region=ns.region,
                date=ns.date,
                time_start=ns.time_start,
                time_end=ns.time_end,
                is_open=ns.is_available,
                is_night=ns.is_night,
                eligibility=ns.eligibility,
                is_paid=ns.is_paid,
                was_open=False,
                status=ns.status,
                open_at=ns.open_at,
                close_at=ns.close_at,
                use_from=ns.use_from,
                use_to=ns.use_to,
                reserve_url=ns.reserve_url,
                first_seen=now,
                last_seen=now,
            )
            session.add(row)
            reopened = False
        else:
            # 직전에 '저장된' is_open이 이번 관측의 직전 상태다.
            # 재오픈(취소표) = 직전 close → 이번 open.
            prev_open = row.is_open
            reopened = (not prev_open) and ns.is_available
            row.was_open = prev_open
            row.is_open = ns.is_available
            row.is_night = ns.is_night
            row.region = ns.region
            row.eligibility = ns.eligibility
            row.is_paid = ns.is_paid
            row.status = ns.status
            row.open_at = ns.open_at
            row.close_at = ns.close_at
            row.use_from = ns.use_from
            row.use_to = ns.use_to
            row.reserve_url = ns.reserve_url
            row.facility_name = ns.facility_name
            row.last_seen = now
            session.add(row)

        if ns.is_available:
            if h not in notified_hashes:
                candidates.append(row)
            elif allow_reopen and reopened:
                candidates.append(row)

    # 이번 조회에 '없는' 슬롯은 더 이상 접수중이 아니므로 닫는다(옛 스냅샷 잔재 제거).
    # 단, 이번에 실제로 데이터를 받은 소스에 한정(수집 실패로 전체가 닫히는 것 방지).
    if current_sources:
        stale = session.exec(
            select(Slot).where(
                Slot.source_id.in_(current_sources), Slot.is_open.is_(True)
            )
        ).all()
        for row in stale:
            if row.slot_hash not in current_hashes:
                row.is_open = False
                session.add(row)

    # 화면·알람은 '마지막 성공 수집 회차'에 들어 있던 행만 쓴다(openings._fresh).
    from app.services import sync as SYNC
    for src in current_sources:
        SYNC.BATCH[src] = now

    # flush로 신규 row의 PK를 채워 후속 처리 가능하게
    session.flush()
    return candidates


def mark_notified(session: Session, slots: list[Slot]) -> None:
    """발송 성공한 슬롯을 notified_slot에 기록(없으면 insert, 있으면 reopen_count++)."""
    now = _now()
    for s in slots:
        existing = session.exec(
            select(NotifiedSlot).where(NotifiedSlot.slot_hash == s.slot_hash)
        ).first()
        if existing is None:
            session.add(NotifiedSlot(slot_hash=s.slot_hash, notified_at=now, reopen_count=0))
        else:
            existing.reopen_count += 1
            existing.notified_at = now
            session.add(existing)

"""Diff 엔진 단위테스트 — 신규/중복/취소표 재오픈/해시 충돌(SlotDTO 기반)."""
from __future__ import annotations

from app.collectors.base import SlotDTO, identity_hash
from app.services.diff import mark_notified, upsert_and_extract_new


def _ns(src="seoul_open_api", court="1코트", date="2026-06-20", ts="06:00", te="08:00",
        is_open=True, night=False):
    return SlotDTO(
        source_id=src, tier=1, facility_name="양재테니스장", court_name=court,
        region="서초구", date=date, time_start=ts, time_end=te,
        is_available=is_open, is_night=night,
    )


def test_hash_includes_all_fields():
    base = identity_hash("seoul_open_api", "양재", "1코트", "2026-06-20", "06:00")
    assert base != identity_hash("gangnam", "양재", "1코트", "2026-06-20", "06:00")
    assert base != identity_hash("seoul_open_api", "양재", "2코트", "2026-06-20", "06:00")
    assert base != identity_hash("seoul_open_api", "양재", "1코트", "2026-06-21", "06:00")
    assert base != identity_hash("seoul_open_api", "양재", "1코트", "2026-06-20", "08:00")


def test_new_open_slot_is_candidate(session):
    out = upsert_and_extract_new(session, [_ns()])
    session.commit()
    assert len(out) == 1
    assert out[0].region == "서초구"
    assert out[0].time == "06:00-08:00"


def test_already_notified_is_not_recandidate(session):
    out = upsert_and_extract_new(session, [_ns()])
    session.commit()
    mark_notified(session, out)
    session.commit()
    out2 = upsert_and_extract_new(session, [_ns()])
    session.commit()
    assert out2 == []


def test_closed_slot_not_candidate(session):
    out = upsert_and_extract_new(session, [_ns(is_open=False)])
    session.commit()
    assert out == []


def test_reopen_only_with_flag(session):
    out = upsert_and_extract_new(session, [_ns(is_open=True)])
    session.commit()
    mark_notified(session, out)
    session.commit()
    upsert_and_extract_new(session, [_ns(is_open=False)])
    session.commit()
    out_no = upsert_and_extract_new(session, [_ns(is_open=True)], allow_reopen=False)
    session.commit()
    assert out_no == []
    upsert_and_extract_new(session, [_ns(is_open=False)])
    session.commit()
    out_yes = upsert_and_extract_new(session, [_ns(is_open=True)], allow_reopen=True)
    session.commit()
    assert len(out_yes) == 1

"""Notifier 테스트 — 카카오 발송/토큰갱신을 respx로 mock.

검증 포인트:
- 정상 발송(result_code=0)
- access_token 만료(-401) → refresh → 1회 재시도 성공
- 갱신 응답의 새 refresh_token 저장(회전)
- 발송 성공분만 notified_slot 기록
"""
from __future__ import annotations

import httpx
import pytest
import respx

from app.models import KakaoToken, NotifiedSlot, Slot
from app.services import notifier
from app.services.notifier import KAKAO_SEND_URL, KAKAO_TOKEN_URL, notify_slots


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    monkeypatch.setattr(notifier.settings, "kakao_rest_key", "restkey")
    monkeypatch.setattr(notifier.settings, "quiet_hours", "")     # 무음 비활성
    monkeypatch.setattr(notifier.settings, "daily_send_limit", 0)  # 상한 무제한
    monkeypatch.setattr(notifier.settings, "batch_max", 10)


def _seed_token(session, access="good", expires_future=True):
    from datetime import timedelta

    from app.clock import now as _now
    exp = _now() + (timedelta(hours=1) if expires_future else timedelta(hours=-1))
    session.add(KakaoToken(id=1, access_token=access, refresh_token="refresh0",
                           access_expires_at=exp))
    session.commit()


def _slot(h="h1"):
    return Slot(slot_hash=h, source_id="seoul_open_api", tier=1, facility_name="양재",
                court_name="1", region="서초구", date="2026-06-20",
                time_start="06:00", time_end="08:00", is_open=True)


@pytest.mark.asyncio
@respx.mock
async def test_send_success_and_records(session):
    _seed_token(session)
    respx.post(KAKAO_SEND_URL).mock(return_value=httpx.Response(200, json={"result_code": 0}))

    s = _slot()
    session.add(s)
    session.commit()

    n = await notify_slots(session, [s])
    assert n == 1
    rec = session.get(NotifiedSlot, 1)
    assert rec is not None and rec.slot_hash == "h1"


@pytest.mark.asyncio
@respx.mock
async def test_expired_token_refreshes_and_retries(session):
    _seed_token(session, access="stale", expires_future=False)
    # 갱신 응답: 새 access + 회전된 refresh
    respx.post(KAKAO_TOKEN_URL).mock(
        return_value=httpx.Response(200, json={
            "access_token": "fresh", "refresh_token": "refresh1", "expires_in": 21600,
        })
    )
    respx.post(KAKAO_SEND_URL).mock(return_value=httpx.Response(200, json={"result_code": 0}))

    s = _slot("h2")
    session.add(s)
    session.commit()

    n = await notify_slots(session, [s])
    assert n == 1
    token = session.get(KakaoToken, 1)
    assert token.access_token == "fresh"
    assert token.refresh_token == "refresh1"  # 회전 저장 확인


@pytest.mark.asyncio
@respx.mock
async def test_send_failure_does_not_record(session):
    _seed_token(session)
    respx.post(KAKAO_SEND_URL).mock(return_value=httpx.Response(200, json={"result_code": -1}))

    s = _slot("h3")
    session.add(s)
    session.commit()

    n = await notify_slots(session, [s])
    assert n == 0
    assert session.get(NotifiedSlot, 1) is None


def test_format_slot_line_shows_paid_and_eligibility():
    s = Slot(slot_hash="h", source_id="seoul_open_api", tier=1, facility_name="양재",
             court_name="1", region="서초구", date="2026-06-20", time_start="19:00",
             time_end="21:00", is_open=True, is_night=True, is_paid=True,
             eligibility="서초구민 전용")
    line = notifier._format_slot_line(s)
    assert "[서초구]" in line
    assert "(야간)" in line
    assert "유료" in line
    assert "서초구민 전용" in line


@pytest.mark.asyncio
@respx.mock
async def test_daily_limit_blocks_sending(session, monkeypatch):
    monkeypatch.setattr(notifier.settings, "daily_send_limit", 1)
    _seed_token(session)
    from app.models import SendLog
    session.add(SendLog(slot_count=1))  # 이미 1슬롯 발송 → 상한 도달
    session.commit()
    route = respx.post(KAKAO_SEND_URL).mock(
        return_value=httpx.Response(200, json={"result_code": 0})
    )
    s = _slot("h_lim")
    session.add(s)
    session.commit()
    n = await notify_slots(session, [s])
    assert n == 0
    assert route.call_count == 0  # 발송 시도조차 안 함


@pytest.mark.asyncio
@respx.mock
async def test_repeated_401_refreshes_once_then_fails(session):
    _seed_token(session)
    refresh_route = respx.post(KAKAO_TOKEN_URL).mock(
        return_value=httpx.Response(200, json={"access_token": "x", "expires_in": 21600})
    )
    # 발송이 계속 -401 (만료) 반환
    respx.post(KAKAO_SEND_URL).mock(
        return_value=httpx.Response(200, json={"code": -401, "msg": "expired"})
    )
    s = _slot("h_401")
    session.add(s)
    session.commit()
    n = await notify_slots(session, [s])
    assert n == 0
    # 무한루프 방지: 갱신은 단 1회만
    assert refresh_route.call_count == 1
    assert session.get(NotifiedSlot, 1) is None


@pytest.mark.asyncio
@respx.mock
async def test_refresh_preserves_token_when_not_rotated(session):
    _seed_token(session, access="stale", expires_future=False)
    # 갱신 응답에 refresh_token 없음 → 기존 값 보존돼야 함
    respx.post(KAKAO_TOKEN_URL).mock(
        return_value=httpx.Response(200, json={"access_token": "fresh", "expires_in": 21600})
    )
    respx.post(KAKAO_SEND_URL).mock(return_value=httpx.Response(200, json={"result_code": 0}))
    s = _slot("h_norot")
    session.add(s)
    session.commit()
    n = await notify_slots(session, [s])
    assert n == 1
    token = session.get(KakaoToken, 1)
    assert token.access_token == "fresh"
    assert token.refresh_token == "refresh0"  # 비회전 → 기존 유지

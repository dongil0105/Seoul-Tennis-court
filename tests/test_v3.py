"""v3 테스트 — 상태 보정 · 요일/시간 조합 · 날짜용 회차/상시/마감/오픈 예정 · 달력 · D-5 · 앱 알림."""
from __future__ import annotations

import json
from datetime import date, datetime

import pytest

from app.models import Slot
from app.services import openings as OP
from app.services import webpush as WP

NOW = datetime(2026, 10, 31, 16, 0)   # 토요일 오후


@pytest.fixture(autouse=True)
def _fixed_now(monkeypatch):
    monkeypatch.setattr(OP, "_now", lambda: NOW)


def _slot(h, name, place="한남테니스장", region="용산구", status="접수중", open_at="2026-10-01 09:00",
          close_at="2026-12-31 22:59", use_from="", use_to="", ts="06:00", te="22:00"):
    return Slot(slot_hash=h, source_id="seoul_open_api", tier=1, facility_name=name,
                court_name=place, region=region, date="", time_start=ts, time_end=te,
                is_open=status == "접수중", status=status, open_at=open_at, close_at=close_at,
                use_from=use_from, use_to=use_to, reserve_url=f"https://yeyak.seoul.go.kr/{h}")


def test_effective_status_fixes_lagging_api():
    s = _slot("e1", "한남 1번코트", status="안내중", open_at="2026-10-31 09:00")
    assert OP.effective_status(s, NOW) == "접수중"          # 09:00 지났는데 API는 아직 안내중
    s2 = _slot("e2", "한남 1번코트", status="안내중", open_at="2026-11-01 09:00")
    assert OP.effective_status(s2, NOW) == "안내중"
    s3 = _slot("e3", "코트", status="접수중", close_at="2026-10-30 23:00")
    assert OP.effective_status(s3, NOW) == "접수종료"
    s4 = _slot("e4", "코트", status="예약마감")
    assert OP.effective_status(s4, NOW) == "예약마감"


@pytest.mark.parametrize("name,day,part,ok", [
    ("한남테니스장 10번코트 월요일 야간 및 주말", date(2026, 11, 2), "야간", True),   # 월 야간
    ("한남테니스장 10번코트 월요일 야간 및 주말", date(2026, 11, 2), "주간", False),  # 월 주간 X
    ("한남테니스장 10번코트 월요일 야간 및 주말", date(2026, 11, 1), "주간", True),   # 일요일 전체
    ("한남테니스장 10번코트 월요일 야간 및 주말", date(2026, 11, 3), None, False),    # 화요일 X
    ("한남테니스장 2번코트 금요일 야간 및 일요일", date(2026, 11, 6), "야간", True),
    ("한남테니스장 2번코트 금요일 야간 및 일요일", date(2026, 11, 7), None, False),   # 토요일 X
    ("한남테니스장 1번코트 일요일", date(2026, 11, 1), None, True),
    ("한남테니스장 3번코트 평일 새벽,주간", date(2026, 11, 2), "야간", False),
    ("테니스장1(토/일/공휴일)-2026년 응봉공원", date(2026, 12, 25), None, True),     # 금요일 성탄절
    ("테니스장1(평일)-2026년 응봉공원", date(2026, 12, 25), None, False),            # 공휴일엔 평일 코트 X
    ("마루공원 테니스장 1면", date(2026, 12, 25), None, True),                         # 요일 표기 없음 = 매일
])
def test_matches_day(name, day, part, ok):
    assert OP.matches_day(name, day, part, "06:00", "22:00") is ok


def test_period_korean_forms():
    assert OP.period_from_name("A코트 주말 및 공휴일 11월1일~15일", 2026) == (date(2026, 11, 1), date(2026, 11, 15))
    assert OP.period_from_name("11/1~11/15  장충테니스장 2번코트", 2026) == (date(2026, 11, 1), date(2026, 11, 15))
    assert OP.period_from_name("11월 16일 ~ 11월 30일 코트", 2026) == (date(2026, 11, 16), date(2026, 11, 30))


def _seed(session):
    add = session.add
    # 날짜용 회차(이름 기간), 접수중
    add(_slot("d1", "동부 도로사업소 테니스장 A코트 주말 및 공휴일 11월1일~15일", place="동부도로사업소 테니스장",
              region="강남구", use_from="2026-10-25", use_to="2026-11-15"))
    # 날짜용 회차인데 다 참
    add(_slot("j1", "11/1~11/15장충테니스장 2번코트(주말 및 공휴일)", place="장충테니스장", region="중구",
              status="예약마감", use_from="2026-10-24", use_to="2026-11-15"))
    # 오늘 09:00 열렸는데 API 상태가 늦은 한남(이용 10/31~11/15) → 접수중으로 보정
    add(_slot("h1", "한남테니스장 1번코트 일요일", status="안내중", open_at="2026-10-31 09:00",
              close_at="2026-11-11 23:59", use_from="2026-10-31", use_to="2026-11-15"))
    # 다음 회차(11/16~)는 11/12 09:00 오픈 예정
    add(_slot("h2", "한남테니스장 1번코트 일요일", status="안내중", open_at="2026-11-12 09:00",
              close_at="2026-11-26 23:59", use_from="2026-11-16", use_to="2026-11-30"))
    # 상시 코트(마루공원)
    for i in (1, 2):
        add(_slot(f"m{i}", f"마루공원 테니스장 {i}면", place="마루공원", region="강남구",
                  use_from="2025-06-01", use_to="2026-12-31"))
    session.commit()


def test_available_sorts_exact_rolling_full_later(session):
    _seed(session)
    av = OP.available(session, date(2026, 11, 1))
    places = lambda k: [e["place"] for e in av[k]]  # noqa: E731
    assert places("exact") == ["동부도로사업소 테니스장", "한남테니스장"]
    assert places("rolling") == ["마루공원"] and av["rolling"][0]["court_count"] == 2
    assert av["rolling"][0]["period"] == "상시 예약"
    assert places("full") == ["장충테니스장"]
    assert av["exact"][0]["period"] == "11/1~11/15"
    # 11/22(일): 한남은 아직 안 열린 회차 → later, 동부는 기간 밖
    av2 = OP.available(session, date(2026, 11, 22))
    assert [e["place"] for e in av2["later"]] == ["한남테니스장"]
    assert av2["later"][0]["open_at"] == "2026-11-12 09:00"
    assert av2["exact"] == []
    # 지난 날짜는 빈 결과
    assert OP.available(session, date(2026, 10, 30))["exact"] == []


def test_calendar_counts(session):
    _seed(session)
    cal = OP.calendar(session, days=3)
    by = {d["date"]: d for d in cal["days"]}
    assert by["2026-11-01"]["exact"] == 2 and by["2026-11-01"]["rolling"] == 1
    assert by["2026-11-01"]["full"] == 1
    assert by["2026-11-02"]["exact"] == 0          # 월요일: 동부 주말·한남 일요일 둘 다 아님
    assert by["2026-10-31"]["weekday"] == "토"


def test_soon_groups_d5(session):
    _seed(session)
    session.add(_slot("s1", "서울숲 테니스장 주말 2027년", place="서울숲>서울숲 테니스장 테스트",
                      region="성동구", status="안내중", open_at="2026-11-03 09:01",
                      use_from="2026-10-29", use_to="2027-12-31"))
    session.add(_slot("s2", "멀리 열리는 코트", status="안내중", open_at="2026-11-20 09:00"))
    session.commit()
    ov = OP.overview(session)
    soon = [(e["place"], e["d_day"], e["opened"]) for e in ov["soon"]]
    assert ("한남테니스장", 0, True) in soon
    assert ("서울숲 테니스장", 3, False) in soon       # '테스트' 꼬리 제거
    assert all(p != "멀리 열리는 코트" for p, _, _ in soon)  # D-20 은 제외
    assert ov["areas"] == ["서초", "강남", "성동", "용산", "한남", "장충"]


def test_webpush_key_is_deterministic(monkeypatch):
    WP._keys.cache_clear()
    monkeypatch.setattr(WP.settings, "vapid_private_key", "")
    monkeypatch.setattr(WP.settings, "seoul_api_key", "test-secret")
    k1 = WP.public_key()
    WP._keys.cache_clear()
    assert WP.public_key() == k1 and len(WP._b64u_dec(k1)) == 65
    WP._keys.cache_clear()


def test_webpush_area_filter(session, monkeypatch):
    WP._keys.cache_clear()
    monkeypatch.setattr(WP.settings, "seoul_api_key", "test-secret")
    sub = lambda ep: {"endpoint": f"https://push.example/{ep}", "keys": {"p256dh": "x", "auth": "y"}}  # noqa: E731
    assert WP.subscribe(session, sub("a"), ["강남"], d1=True, h1=False)["ok"]
    assert WP.subscribe(session, sub("b"), ["용산", "한남"], d1=True, h1=True)["ok"]
    assert WP.subscribe(session, {"endpoint": "http://bad"})["ok"] is False
    sent = []
    monkeypatch.setattr(WP, "_send", lambda s, row, payload, ttl=0: sent.append((row.endpoint, payload)) or True)
    groups = [{"kind": "h1", "place": "한남테니스장", "areas": ["용산", "한남"], "open_at": "2026-11-12 09:00",
               "count": 21, "reserve_url": "https://y/1"},
              {"kind": "d1", "place": "마루공원", "areas": ["강남"], "open_at": "2026-11-01 14:00",
               "count": 6, "reserve_url": "https://y/2"}]
    assert WP.send_opening_alerts(session, groups, badge=2) == 2
    got = {ep.rsplit("/", 1)[1]: p for ep, p in sent}
    assert "마루공원" in got["a"]["body"] and "한남" not in got["a"]["body"]     # 강남만, 1시간 전 꺼짐
    assert got["b"]["title"].startswith("한남테니스장") and got["b"]["badge"] == 2
    assert json.loads(json.dumps(got["b"]))  # 직렬화 가능
    WP._keys.cache_clear()

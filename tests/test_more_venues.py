"""테니스장 두 곳 추가(2026-11-15) — 잠원한강공원(서울시 자료에 있음) · 대치유수지체육공원(자체 예약 사이트).

대치유수지는 서울시 자료에 없어서 예약 상태는 모른다. 시설 누리집에 적힌 정기 오픈 일정
('월 예약의 기준일은 매월 셋째 주 월요일 09:00')만으로 다음 오픈 날짜를 보여 주고 알린다.
"""
from __future__ import annotations

from datetime import datetime

import pytest

from app.models import Slot
from app.services import notice as N
from app.services import openings as OP
from app.services import webpush as WP

ALL = ["한남", "장충", "마루공원", "선우공원", "서울숲", "잠원", "대치유수지"]


@pytest.fixture()
def clock(monkeypatch):
    box = {"now": datetime(2026, 11, 15, 10, 50)}          # 일요일 — 다음 날이 11월의 셋째 주 월요일
    monkeypatch.setattr(OP, "_now", lambda: box["now"])
    return box


def _s(h, name, place, region, status="접수중", open_at="2026-11-01 00:00", close_at="2026-11-30 00:01",
       use_from="2026-11-01", use_to="2026-11-30"):
    return Slot(slot_hash=h, source_id="seoul_open_api", tier=1, facility_name=name, court_name=place,
                region=region, date="", time_start="08:00", time_end="18:00", is_open=status == "접수중",
                status=status, open_at=open_at, close_at=close_at, use_from=use_from, use_to=use_to,
                reserve_url=f"https://yeyak.seoul.go.kr/{h}")


def test_watch_list_now_has_seven_places():
    assert OP.all_areas() == ALL
    # 잠원: 서울시 자료의 이름 그대로 잡힌다
    assert OP.is_watched("서초구", "잠원 한강공원 테니스장 1번 코트 평일", "잠원한강테니스장")
    assert OP.areas_of("서초구", "잠원 한강공원 테니스장 3번 코트 저녁", "잠원한강테니스장") == ["잠원"]
    # 관심 밖의 곳은 여전히 아니다
    assert not OP.is_watched("마포구", "[평일주간]망원유수지 소프트테니스장", "망원유수지 소프트테니스장")
    assert not OP.is_watched("강남구", "탄천센터 테니스장 2면", "서울물재생시설공단>탄천물재생센터")


def test_jamwon_shows_like_the_other_seoul_places(session, clock):
    session.add(_s("z1", "잠원 한강공원 테니스장 1번 코트 평일", "잠원한강테니스장", "서초구"))
    session.add(_s("z2", "잠원 한강공원 테니스장 2번 코트 저녁", "잠원한강테니스장", "서초구", "예약마감"))
    session.add(_s("z3", "잠원 한강공원 테니스장 3번 코트 주말.공휴일", "잠원한강테니스장", "서초구", "예약일시중지"))
    session.commit()
    b = OP.board(session)
    assert b["areas"] == ALL
    place = next(p for p in b["places"] if p["area"] == "잠원")
    assert (place["region"], place["available"], place["closed"]) == ("서초구", 1, 2)
    avail = [g for g in b["available"] if g["area"] == "잠원"]
    assert len(avail) == 1 and [c["court"] for c in avail[0]["courts"]] == ["1번"]
    assert sorted(c["state"] for g in b["closed"] if g["area"] == "잠원" for c in g["courts"]) == ["full", "paused"]


def test_third_monday_rule():
    rule = N.STATIC["대치유수지"]
    assert rule == ((N.nth_weekday(3, 0), "09:00"),)
    assert N.label(rule) == "매월 셋째 주 월요일 09:00"
    # 2026년 11월은 1일이 일요일 → 월요일은 2 · 9 · 16일
    assert N.next_at(rule, datetime(2026, 11, 15, 10, 50)) == datetime(2026, 11, 16, 9, 0)
    assert N.next_at(rule, datetime(2026, 11, 16, 9, 0)) == datetime(2026, 12, 21, 9, 0)      # 정각이 지나면 다음 달
    assert N.prev_at(rule, datetime(2026, 11, 16, 9, 30)) == datetime(2026, 11, 16, 9, 0)
    assert N.next_at(rule, datetime(2027, 2, 1)) == datetime(2027, 2, 15, 9, 0)               # 1일이 월요일인 달
    # 다섯째 ○요일이 없는 달은 건너뛴다(2026년 11월의 월요일은 다섯 번, 12월은 네 번)
    fifth = ((N.nth_weekday(5, 0), "09:00"),)
    assert N.next_at(fifth, datetime(2026, 11, 1)) == datetime(2026, 11, 30, 9, 0)
    assert N.next_at(fifth, datetime(2026, 12, 1)) is None            # 12월 · 1월 · 2월에는 다섯째 월요일이 없다(석 달 안에 없으면 '모름')
    # 날짜 일정과 섞여도 이름이 읽힌다
    assert N.label(((15, "09:00"), (N.LAST, "09:00"))) == "매월 15일·말일 09:00"


def test_daechi_is_listed_with_its_regular_opening_only(session, clock):
    b = OP.board(session)                                     # 서울시 자료가 하나도 없어도
    place = next(p for p in b["places"] if p["area"] == "대치유수지")
    assert place == {"area": "대치유수지", "place": "대치유수지체육공원 테니스장", "region": "강남구",
                     "next_open": "2026-11-16 09:00", "next_expected": True, "open_rule": "매월 셋째 주 월요일 09:00",
                     "available": 0, "closed": 0, "past_opens": []}
    op = [e for e in b["openings"] if e["area"] == "대치유수지"]
    assert [(e["open_at"], e["opened"], e["expected"], e["rule"], e["courts"]) for e in op] == [
        ("2026-11-16 09:00", False, True, "매월 셋째 주 월요일 09:00", [])]
    assert op[0]["place"] == "대치유수지체육공원 테니스장" and op[0]["region"] == "강남구"
    # 예약 상태는 모른다 — 코트 묶음을 지어내지 않는다
    assert not [g for g in b["available"] + b["closed"] if g["area"] == "대치유수지"]
    # 오픈 시각이 지난 뒤 2시간 동안은 '공지된 시각이 지났다'고만 알린다(열렸다고 단정하지 않는다)
    clock["now"] = datetime(2026, 11, 16, 9, 40)
    op = [e for e in OP.board(session)["openings"] if e["area"] == "대치유수지"]
    assert [(e["open_at"], e["opened"]) for e in op] == [("2026-11-16 09:00", True), ("2026-12-21 09:00", False)]


def test_daechi_alerts_the_day_before_and_an_hour_before(session, clock):
    clock["now"] = datetime(2026, 11, 14, 12, 0)             # 이틀 전 — 아직 아님
    assert OP.pending_alerts(session) == []
    clock["now"] = datetime(2026, 11, 15, 10, 50)            # 전날
    due = OP.pending_alerts(session)
    assert [(k, s.slot_hash, s.open_at) for k, s in due] == [("d1", "rule:대치유수지", "2026-11-16 09:00")]
    g = OP.group_for_message(due)
    assert [(x["kind"], x["place"], x["region"], x["open_at"], x["expected"], x["areas"]) for x in g] == [
        ("d1", "대치유수지체육공원 테니스장", "강남구", "2026-11-16 09:00", True, ["대치유수지"])]
    OP.mark_alerted(session, due)
    assert OP.pending_alerts(session) == []                  # 한 번만
    clock["now"] = datetime(2026, 11, 16, 8, 10)             # 1시간 전
    assert [(k, s.slot_hash) for k, s in OP.pending_alerts(session)] == [("h1", "rule:대치유수지")]


def test_daechi_is_dropped_when_not_watched(session, clock, monkeypatch):
    from app.config import settings as cfg
    monkeypatch.setattr(cfg, "watch_keywords", "한남테니스장,장충테니스장")
    assert "대치유수지" not in [p["area"] for p in OP.board(session)["places"]]
    assert OP.pending_alerts(session) == []                  # 관심 목록에서 빼면 알림도 없다


def test_devices_can_pick_the_new_places():
    assert WP._clean_areas(["잠원", "대치유수지", "없는곳"]) == ["잠원", "대치유수지"]
    assert WP._clean_areas(None) == ALL

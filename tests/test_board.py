"""5곳 전용 보드(/board) — 다음 예약 오픈 + 지금 예약 가능한 코트 번호."""
from __future__ import annotations

from datetime import datetime

import pytest

from app.models import Slot
from app.services import openings as OP

NOW = datetime(2026, 10, 31, 16, 0)


@pytest.fixture(autouse=True)
def _fixed_now(monkeypatch):
    monkeypatch.setattr(OP, "_now", lambda: NOW)


def _s(h, name, place, region, status="접수중", open_at="2026-10-01 09:00", close_at="2026-12-31 22:59",
       use_from="", use_to=""):
    return Slot(slot_hash=h, source_id="seoul_open_api", tier=1, facility_name=name, court_name=place,
                region=region, date="", time_start="06:00", time_end="22:00", is_open=status == "접수중",
                status=status, open_at=open_at, close_at=close_at, use_from=use_from, use_to=use_to,
                reserve_url=f"https://yeyak.seoul.go.kr/{h}")


def test_watch_is_five_places_only():
    assert OP.all_areas() == ["한남", "장충", "마루공원", "선우공원", "서울숲"]
    assert OP.is_watched("용산구", "한남테니스장 1번코트 일요일", "한남테니스장")
    assert OP.is_watched("관악구", "선우공원테니스장 B코트 평일주간", "선우공원")
    assert not OP.is_watched("서초구", "잠원 한강공원 테니스장 1번 코트 평일", "잠원한강테니스장")
    assert not OP.is_watched("강남구", "탄천센터 테니스장 2면", "서울물재생시설공단>탄천물재생센터")


def test_board_openings_then_available(session):
    add = session.add
    # 다음 오픈: 한남 11/12 09:00 (2개 코트), 장충 11/10 10:00
    add(_s("h1", "한남테니스장 2번코트 금요일 야간 및 일요일", "한남테니스장", "용산구", "안내중",
           "2026-11-12 09:00", "2026-11-26 09:01", "2026-11-16", "2026-11-30"))
    add(_s("h2", "한남테니스장 1번코트 일요일", "한남테니스장", "용산구", "안내중",
           "2026-11-12 09:00", "2026-11-26 09:01", "2026-11-16", "2026-11-30"))
    add(_s("j1", "11/16~11/30장충테니스장 3번코트(주말 및 공휴일)", "장충테니스장", "중구", "안내중",
           "2026-11-10 10:00", "2026-11-30 22:00", "2026-11-09", "2026-11-30"))
    # 오늘 열렸는데 공식 상태 미갱신 → 오늘 오픈됨으로
    add(_s("h3", "한남테니스장 3번코트 평일 새벽,주간", "한남테니스장", "용산구", "안내중",
           "2026-10-31 09:00", "2026-11-11 09:01", "2026-10-31", "2026-11-15"))
    # 지금 예약 가능(공식 접수중): 마루공원 1면·2면 조명, 선우 B코트(11/15까지)
    add(_s("m1", "마루공원 테니스장 1면", "마루공원", "강남구", use_from="2025-06-01", use_to="2026-12-31"))
    add(_s("m2", "마루공원 테니스장 2면 (조명)", "마루공원", "강남구", use_from="2025-05-18", use_to="2026-12-31"))
    add(_s("s1", "선우공원테니스장 B코트 평일주간", "선우공원", "관악구", use_from="2026-11-01", use_to="2026-11-15"))
    # 마감·지난 회차는 안 나옴
    add(_s("j2", "11/1~11/15장충테니스장 2번코트(주말 및 공휴일)", "장충테니스장", "중구", "예약마감",
           use_from="2026-10-24", use_to="2026-11-15"))
    add(_s("s2", "선우공원테니스장 A코트 평일주간", "선우공원", "관악구", use_from="2026-10-01", use_to="2026-10-15"))
    session.commit()

    b = OP.board(session)
    op = [(e["area"], e["open_at"], e["opened"], [c["court"] for c in e["courts"]]) for e in b["openings"]]
    assert op == [("한남", "2026-10-31 09:00", True, ["3번"]),
                  ("장충", "2026-11-10 10:00", False, ["3번"]),
                  ("한남", "2026-11-12 09:00", False, ["1번", "2번"])]
    av = {e["area"]: ([c["court"] for c in e["courts"]], e["until_label"]) for e in b["available"]}
    assert av == {"마루공원": (["1면", "2면 조명"], "상시 예약"), "선우공원": (["B"], "11/15까지 이용")}
    assert [x["area"] for x in b["available"]] == ["마루공원", "선우공원"]
    pl = {p["area"]: p for p in b["places"]}
    assert pl["한남"]["next_open"] == "2026-11-12 09:00" and pl["장충"]["next_open"] == "2026-11-10 10:00"
    assert pl["마루공원"]["available"] == 2 and pl["서울숲"]["available"] == 0
    assert b["badge"] == 0          # 내일·오늘 남은 오픈 없음
    assert all(c["reserve_url"] for e in b["available"] for c in e["courts"])


@pytest.mark.parametrize("label,short", [("1번 코트", "1번"), ("10번 코트", "10번"), ("A코트", "A"),
                                         ("1면 조명", "1면 조명"), ("코트", "코트")])
def test_short_court(label, short):
    assert OP.short_court(label) == short


def test_monthly_reception_and_next_year_label(session):
    # 선우공원: 이용기간은 1년, 접수는 한 달(10/27~11/30) → '11/30까지 접수'
    session.add(_s("w1", "선우공원테니스장 B코트 평일주간", "선우공원", "관악구", "접수중",
                   "2026-10-27 09:30", "2026-11-30 18:00", "2026-01-01", "2026-12-31"))
    # 서울숲 2027년분 12/1 오픈 → '2027년 이용분'
    session.add(_s("w2", "서울숲 테니스장 주말 2027년", "서울숲>서울숲 테니스장 테스트", "성동구", "안내중",
                   "2026-12-01 09:01", "2027-12-31 23:59", "2026-10-29", "2027-12-31"))
    session.commit()
    b = OP.board(session)
    assert b["available"][0]["until_label"] == "11/30까지 접수"
    assert b["openings"][0]["period"] == "2027년 이용분" and b["openings"][0]["area"] == "서울숲"


def test_same_day_opened_and_upcoming_are_separate(session):
    session.add(_s("x1", "한남테니스장 1번코트 평일 주간", "한남테니스장", "용산구", "안내중",
                   "2026-10-31 09:00", "2026-11-11 09:01", "2026-11-01", "2026-11-15"))
    session.add(_s("x2", "한남테니스장 2번코트 평일 주간", "한남테니스장", "용산구", "안내중",
                   "2026-10-31 18:00", "2026-11-11 09:01", "2026-11-01", "2026-11-15"))
    session.commit()
    b = OP.board(session)
    got = [(e["open_at"], e["opened"], [c["court"] for c in e["courts"]]) for e in b["openings"]]
    assert got == [("2026-10-31 09:00", True, ["1번"]), ("2026-10-31 18:00", False, ["2번"])]
    assert {p["area"]: p["next_open"] for p in b["places"]}["한남"] == "2026-10-31 18:00"
    assert b["badge"] == 1


@pytest.mark.parametrize("name,uf,ut", [
    ("11/1~11/15 한남테니스장 1번코트", "2026-12-01", "2026-12-31"),   # 이름 기간이 공식 기간과 안 겹침
    ("한남테니스장 1번코트", "2026-12-01", "2026-11-30"),              # 공식 기간 역전
])
def test_contradictory_period_hidden(session, name, uf, ut):
    session.add(_s("y1", name, "한남테니스장", "용산구", "접수중", use_from=uf, use_to=ut))
    session.add(_s("y2", name, "한남테니스장", "용산구", "안내중", "2026-11-01 09:00",
                   use_from=uf, use_to=ut))
    session.commit()
    b = OP.board(session)
    assert b["available"] == [] and b["openings"] == []
    assert OP.pending_alerts(session) == []


def test_different_batches_same_day_not_merged(session):
    # 둘 다 아직 안 열림: 18:00 (11/1~11/15) · 19:00 (11/16~11/30) → 두 카드
    session.add(_s("z1", "한남테니스장 1번코트 평일 주간", "한남테니스장", "용산구", "안내중",
                   "2026-11-02 18:00", "2026-11-11 09:01", "2026-11-01", "2026-11-15"))
    session.add(_s("z2", "한남테니스장 2번코트 평일 주간", "한남테니스장", "용산구", "안내중",
                   "2026-11-02 19:00", "2026-11-26 09:01", "2026-11-16", "2026-11-30"))
    # 09:00 / 09:03 같은 회차는 한 카드
    session.add(_s("z3", "한남테니스장 3번코트 평일 주간", "한남테니스장", "용산구", "안내중",
                   "2026-11-03 09:00", "2026-11-11 09:01", "2026-11-01", "2026-11-15"))
    session.add(_s("z4", "한남테니스장 4번코트 평일 주간", "한남테니스장", "용산구", "안내중",
                   "2026-11-03 09:03", "2026-11-11 09:01", "2026-11-01", "2026-11-15"))
    session.commit()
    got = [(e["open_at"], e["period"], [c["court"] for c in e["courts"]]) for e in OP.board(session)["openings"]]
    assert got == [("2026-11-02 18:00", "11/1~11/15", ["1번"]),
                   ("2026-11-02 19:00", "11/16~11/30", ["2번"]),
                   ("2026-11-03 09:00", "11/1~11/15", ["3번", "4번"])]

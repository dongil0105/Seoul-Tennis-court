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


def test_past_opens_and_full_count(session):
    # 장충: 11/10 10:00 에 열린 회차 — 2개 접수중, 3개 마감 / 10/25 10:00 회차는 전부 마감
    for i, st in enumerate(["접수중", "접수중", "예약마감", "예약마감", "예약마감"]):
        session.add(_s(f"p{i}", f"11/16~11/30 장충테니스장 {i + 2}번코트(평일주간)", "장충테니스장", "중구", st,
                       "2026-10-30 10:00", "2026-11-30 23:00", "2026-10-29", "2026-11-30"))
    session.add(_s("q1", "10/16~10/31 장충테니스장 2번코트(평일주간)", "장충테니스장", "중구", "예약마감",
                   "2026-10-10 10:00", "2026-10-31 23:00", "2026-10-09", "2026-10-31"))
    # 한남: 오늘 09:00·09:03 에 열림(같은 날 → 한 번), 마루공원: 상시(지난 오픈 없음)
    session.add(_s("r1", "한남테니스장 1번코트 평일 주간", "한남테니스장", "용산구", "안내중",
                   "2026-10-31 09:00", "2026-11-11 09:01", "2026-10-31", "2026-11-15"))
    session.add(_s("r2", "한남테니스장 6번코트 평일 주간", "한남테니스장", "용산구", "안내중",
                   "2026-10-31 09:03", "2026-11-11 09:01", "2026-10-31", "2026-11-15"))
    session.add(_s("r3", "마루공원 테니스장 1면", "마루공원", "강남구", "접수중",
                   "2026-10-08 14:00", "2026-12-31 22:59", "2025-06-01", "2026-12-31"))
    session.commit()
    b = OP.board(session)
    pl = {p["area"]: p for p in b["places"]}
    assert pl["장충"]["past_opens"] == ["2026-10-30 10:00", "2026-10-10 10:00"]
    assert pl["장충"]["region"] == "중구" and pl["장충"]["place"] == "장충테니스장"
    assert pl["한남"]["past_opens"] == ["2026-10-31 09:00"]
    assert pl["마루공원"]["past_opens"] == [] and pl["선우공원"]["past_opens"] == []
    av = {e["area"]: e for e in b["available"]}
    assert av["장충"]["court_count"] == 2 and av["장충"]["full_count"] == 3   # 10/10 회차 마감분은 세지 않음
    assert av["장충"]["period"] == "11/16~11/30" and av["장충"]["until_kind"] == "use"
    assert av["마루공원"]["period"] == "" and av["마루공원"]["until_label"] == "상시 예약"
    assert av["마루공원"]["full_count"] == 0


def test_available_split_by_batch_and_full_count_per_batch(session):
    # 장충: 11/1~11/15 회차와 11/16~11/30 회차가 함께 접수중 → 묶음도, 마감 수도 회차별로
    session.add(_s("a1", "11/1~11/15 장충테니스장 2번코트(평일주간)", "장충테니스장", "중구", "접수중",
                   "2026-10-25 10:00", "2026-11-15 23:00", "2026-10-24", "2026-11-15"))
    session.add(_s("a2", "11/1~11/15 장충테니스장 3번코트(평일주간)", "장충테니스장", "중구", "예약마감",
                   "2026-10-25 10:00", "2026-11-15 23:00", "2026-10-24", "2026-11-15"))
    session.add(_s("b1", "11/16~11/30 장충테니스장 8번코트(평일주간)", "장충테니스장", "중구", "접수중",
                   "2026-10-30 10:00", "2026-11-30 23:00", "2026-10-29", "2026-11-30"))
    for i in range(3):
        session.add(_s(f"b{i + 2}", f"11/16~11/30 장충테니스장 {i + 2}번코트(평일주간)", "장충테니스장", "중구",
                       "예약마감", "2026-10-30 10:00", "2026-11-30 23:00", "2026-10-29", "2026-11-30"))
    # 마루공원(상시 예약): 마감된 것이 있어도 '나머지 마감'으로 세지 않는다
    session.add(_s("m1", "마루공원 테니스장 1면", "마루공원", "강남구", use_from="2025-06-01", use_to="2026-12-31"))
    session.add(_s("m2", "마루공원 테니스장 2면", "마루공원", "강남구", "예약마감",
                   use_from="2025-06-01", use_to="2026-12-31"))
    session.commit()
    b = OP.board(session)
    jang = [(e["period"], [c["court"] for c in e["courts"]], e["full_count"], e["until_label"])
            for e in b["available"] if e["area"] == "장충"]
    assert jang == [("11/1~11/15", ["2번"], 1, "11/15까지 이용"), ("11/16~11/30", ["8번"], 3, "11/30까지 이용")]
    maru = next(e for e in b["available"] if e["area"] == "마루공원")
    assert maru["full_count"] == 0 and maru["until_kind"] == "" and maru["until_label"] == "상시 예약"
    assert {p["area"]: p["available"] for p in b["places"]}["장충"] == 2


def test_opened_courts_carry_confirmed_flag(session):
    # 오늘 09:00 에 열림: 1번은 공식 상태가 '접수중'으로 바뀜, 2번은 아직 '안내중'(접수 여부 미확인)
    session.add(_s("c1", "한남테니스장 1번코트 평일 주간", "한남테니스장", "용산구", "접수중",
                   "2026-10-31 09:00", "2026-11-11 09:01", "2026-11-01", "2026-11-15"))
    session.add(_s("c2", "한남테니스장 2번코트 평일 주간", "한남테니스장", "용산구", "안내중",
                   "2026-10-31 09:00", "2026-11-11 09:01", "2026-11-01", "2026-11-15"))
    session.add(_s("c3", "한남테니스장 3번코트 평일 주간", "한남테니스장", "용산구", "안내중",
                   "2026-11-12 09:00", "2026-11-26 09:01", "2026-11-16", "2026-11-30"))
    session.commit()
    ops = OP.board(session)["openings"]
    assert ops[0]["opened"] and {c["court"]: c["confirmed"] for c in ops[0]["courts"]} == {"1번": True, "2번": False}
    assert not ops[1]["opened"] and [c["confirmed"] for c in ops[1]["courts"]] == [False]


def test_refresh_failure_is_not_retried_immediately(monkeypatch):
    import asyncio

    from app.services import sync as SYNC

    calls = []

    async def boom(tiers=None):
        calls.append(1)
        raise RuntimeError("down")

    monkeypatch.setattr("app.collectors.registry.collect", boom)
    monkeypatch.setattr(SYNC, "_LAST", None)
    monkeypatch.setattr(SYNC, "_LAST_FAIL", None)
    first = asyncio.run(SYNC.refresh())
    second = asyncio.run(SYNC.refresh())
    assert first["reason"] == "error" and second["reason"] == "error"
    assert len(calls) == 1          # 방금 실패했으면 공식 API를 다시 부르지 않는다


def test_closed_courts_listed_so_every_place_can_be_entered(session):
    # NOW = 2026-10-31 16:00
    # 장충: 이번 회차가 모두 마감 → 접수 중인 코트는 없지만 코트 번호와 예약 화면 주소는 내려온다
    for i in (2, 3):
        session.add(_s(f"j{i}", f"11/1~11/15 장충테니스장 {i}번코트(평일주간)", "장충테니스장", "중구", "예약마감",
                       "2026-10-25 10:00", "2026-11-15 23:00", "2026-10-24", "2026-11-15"))
    # 한남: 이용 기간은 남았는데 접수가 끝남
    session.add(_s("h1", "한남테니스장 1번코트 평일 주간", "한남테니스장", "용산구", "접수종료",
                   "2026-10-15 09:00", "2026-10-28 09:01", "2026-10-15", "2026-10-31"))
    # 한남: 이용 기간까지 끝난 더 옛 회차 → 이번 회차 정보가 있으니 안 나옴
    session.add(_s("h0", "한남테니스장 1번코트 평일 주간", "한남테니스장", "용산구", "접수종료",
                   "2026-09-30 09:00", "2026-10-13 09:01", "2026-10-01", "2026-10-14"))
    # 선우공원(월 단위 접수): 접수 중 1 + 이번 달 마감 1, 지난달 접수분(접수종료)은 안 나옴
    session.add(_s("s1", "선우공원테니스장 A코트 평일주간", "선우공원", "관악구", "접수중",
                   "2026-10-27 09:30", "2026-11-30 18:00", "2026-01-01", "2026-12-31"))
    session.add(_s("s2", "선우공원테니스장 B코트 평일주간", "선우공원", "관악구", "예약마감",
                   "2026-10-27 09:30", "2026-11-30 18:00", "2026-01-01", "2026-12-31"))
    session.add(_s("s3", "선우공원테니스장 B코트 평일주간", "선우공원", "관악구", "접수종료",
                   "2026-09-23 09:30", "2026-10-30 18:00", "2026-01-01", "2026-12-31"))
    # 서울숲(상시 예약): 마감 1
    session.add(_s("f1", "서울숲 테니스장 평일", "서울숲 테니스장", "성동구", "예약마감",
                   "2025-12-03 00:00", "2026-12-31 00:00", "2025-12-03", "2026-12-31"))
    # 마루공원: 지난 회차뿐(이용 기간 끝) → 다른 정보가 없으니 가장 최근 지난 회차 하나만
    session.add(_s("m1", "10/1~10/15 마루공원 테니스장 1면", "마루공원", "강남구", "예약마감",
                   "2026-09-25 10:00", "2026-10-15 22:00", "2026-10-01", "2026-10-15"))
    session.add(_s("m2", "10/16~10/30 마루공원 테니스장 1면", "마루공원", "강남구", "예약마감",
                   "2026-10-10 10:00", "2026-10-30 22:00", "2026-10-16", "2026-10-30"))
    session.commit()

    b = OP.board(session)
    got = [(g["area"], g["state"], g["past"], g["period"] or g["until_label"],
            [(c["court"], c["state"]) for c in g["courts"]]) for g in b["closed"]]
    assert got == [
        ("한남", "ended", False, "10/15~10/31", [("1번", "ended")]),
        ("장충", "full", False, "11/1~11/15", [("2번", "full"), ("3번", "full")]),
        ("마루공원", "ended", True, "10/16~10/30", [("1면", "ended")]),
        ("선우공원", "full", False, "11/30까지 접수", [("B", "full")]),
        ("서울숲", "full", False, "상시 예약", [("코트", "full")]),
    ]
    assert all(c["reserve_url"].startswith("https://yeyak.seoul.go.kr/") for g in b["closed"] for c in g["courts"])
    # 5곳이 빠짐없이 — 접수 중이거나, 접수하지 않는 코트 정보가 있거나
    assert [(p["area"], p["available"], p["closed"]) for p in b["places"]] == [
        ("한남", 0, 1), ("장충", 0, 2), ("마루공원", 0, 1), ("선우공원", 1, 1), ("서울숲", 0, 1)]


def test_opened_but_status_not_updated_is_listed_as_unknown(session):
    # 어제 09:00 에 열렸는데 공식 상태가 아직 '안내중' — 오픈 일정에서는 빠지지만 곳 목록에는 '확인 필요'로 남는다
    session.add(_s("h1", "한남테니스장 1번코트 평일 주간", "한남테니스장", "용산구", "안내중",
                   "2026-10-30 09:00", "2026-11-11 09:01", "2026-11-01", "2026-11-15"))
    session.commit()
    b = OP.board(session)
    assert b["openings"] == [] and b["available"] == []
    assert [(g["area"], g["state"], g["past"]) for g in b["closed"]] == [("한남", "unknown", False)]

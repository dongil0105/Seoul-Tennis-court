"""시설 공지의 정기 오픈 일정 — 읽기 · 다음 오픈 계산 · 화면 자료(/board) · 알림 판정."""
from __future__ import annotations

from datetime import datetime

import pytest
from sqlmodel import select

from app.collectors.base import SlotDTO
from app.models import OpenRule, Slot
from app.services import notice as N
from app.services import openings as OP

HANNAM = "<p>[예약 안내]</p><p>예약 오픈: 매월 2회</p><p>오픈 일시: 매월 말일 09:00 / 매월 15일 09:00</p>" \
         "<p>예약 한도: 동일 코트 기준 1일최대 4시간 예약 가능</p>"
JANG = "<div>11/16~11/30 예약 11/10(목)오전 10시에 오픈됩니다. (매달 10일, 25일 오전 10시 예약 오픈)</div>"
R_HANNAM = ((15, "09:00"), (N.LAST, "09:00"))
SEEN = datetime(2026, 12, 31)


@pytest.fixture()
def clock(monkeypatch):
    box = {"now": datetime(2026, 11, 12, 14, 0)}
    monkeypatch.setattr(OP, "_now", lambda: box["now"])
    return box


def _s(h, name, place, region, status="접수종료", open_at="2026-10-31 09:00", close_at="2026-11-11 09:01",
       use_from="2026-10-31", use_to="2026-11-15"):
    return Slot(slot_hash=h, source_id="seoul_open_api", tier=1, facility_name=name, court_name=place,
                region=region, date="", time_start="06:00", time_end="22:00", is_open=status == "접수중",
                status=status, open_at=open_at, close_at=close_at, use_from=use_from, use_to=use_to,
                reserve_url=f"https://yeyak.seoul.go.kr/{h}",
                last_seen=SEEN, first_seen=SEEN)   # 시계를 돌려도 '최근 수집분'으로 남게


def _rule(session, area, rule):
    import json
    session.add(OpenRule(area=area, rule=json.dumps([list(x) for x in rule])))


def _hannam(session):
    session.add(_s("h1", "한남테니스장 1번코트 평일 주간", "한남테니스장", "용산구"))
    _rule(session, "한남", R_HANNAM)
    session.commit()


# ── 읽기 ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text, want", [
    (HANNAM, "매월 15일·말일 09:00"),
    (JANG, "매월 10일·25일 10:00"),
    ("매월 25일 오후 2시 30분 예약 오픈", "매월 25일 14:30"),
    ("매월 10일 10:00, 25일 14:00 오픈", "매월 10일 10:00 · 25일 14:00"),
    ("예약 오픈: 매월 2회", ""),                       # 날짜·시각이 없으면 일정이 아니다
    ("매월 1일 오픈, 1회 2시간 이용", ""),             # '2시간'은 시각이 아니다
    ("동일 코트 기준 1일최대 4시간 예약 가능", ""),
    ("매월 20일까지 접수, 오픈 09:00", ""),            # '까지'는 오픈 날짜가 아니다
    ("※ 체육시설 오픈시간 06:00", ""),
    ("", ""),
])
def test_parse(text, want):
    assert N.label(N.parse(text)) == want


def test_next_and_prev():
    at = lambda *a: datetime(*a)   # noqa: E731
    assert N.next_at(R_HANNAM, at(2026, 11, 12, 14, 0)) == at(2026, 11, 15, 9, 0)
    assert N.prev_at(R_HANNAM, at(2026, 11, 12, 14, 0)) == at(2026, 10, 31, 9, 0)
    assert N.next_at(R_HANNAM, at(2026, 11, 15, 9, 0)) == at(2026, 11, 30, 9, 0)      # 그 시각이 되면 다음 회차로
    assert N.next_at(R_HANNAM, at(2026, 12, 31, 9, 1)) == at(2027, 1, 15, 9, 0)       # 해 넘김
    assert N.next_at(R_HANNAM, at(2027, 2, 20, 0, 0)) == at(2027, 2, 28, 9, 0)        # 말일 = 2월 28일
    assert N.next_at(((31, "10:00"),), at(2027, 2, 10, 0, 0)) == at(2027, 3, 31, 10, 0)   # 없는 날은 건너뜀


def _dto(name, place, region, detail=None):
    return SlotDTO(source_id="seoul_open_api", tier=1, facility_name=name, court_name=place, region=region,
                   date="2026-10-31", time_start="06:00", time_end="22:00", is_available=False,
                   raw={} if detail is None else {"DTLCONT": detail})


def test_update_saves_changes_and_removes(session):
    N.update(session, [_dto("한남테니스장 1번코트 평일 주간", "한남테니스장", "용산구", HANNAM),
                       _dto("11/16~11/30 장충테니스장 2번코트(평일주간)", "장충테니스장", "중구", JANG),
                       _dto("마루공원 테니스장 1면", "마루공원", "강남구", "<p>운영시간 : 06시~22시</p>"),
                       _dto("잠원 한강공원 테니스장 1번", "잠원한강테니스장", "서초구", HANNAM)])   # 5곳 밖
    session.commit()
    assert {a: N.label(r) for a, r in N.rules(session).items()} == {
        "한남": "매월 15일·말일 09:00", "장충": "매월 10일·25일 10:00"}
    # 안내문이 없는 수집분(다른 소스·시험용)은 저장된 일정을 건드리지 않는다
    N.update(session, [_dto("한남테니스장 1번코트 평일 주간", "한남테니스장", "용산구")])
    session.commit()
    assert set(N.rules(session)) == {"한남", "장충"}
    # 공지가 바뀌면 따라가고, 공지에서 빠지면 지운다
    N.update(session, [_dto("한남테니스장 1번코트 평일 주간", "한남테니스장", "용산구", "매월 20일 10:00 예약 오픈"),
                       _dto("11/16~11/30 장충테니스장 2번코트(평일주간)", "장충테니스장", "중구", "<p>이용 안내</p>")])
    session.commit()
    assert {a: N.label(r) for a, r in N.rules(session).items()} == {"한남": "매월 20일 10:00"}
    assert len(session.exec(select(OpenRule)).all()) == 1


# ── 화면 자료(/board) ───────────────────────────────────────────────

def test_board_fills_next_open_from_notice(session, clock):
    _hannam(session)
    # 장충: 서울시 자료에 11/25 회차가 이미 올라와 있음 → 공지 일정으로 또 내지 않는다
    session.add(_s("j1", "12/1~12/15 장충테니스장 2번코트(평일주간)", "장충테니스장", "중구", "안내중",
                   "2026-11-25 10:00", "2026-12-15 23:00", "2026-11-24", "2026-12-15"))
    _rule(session, "장충", ((10, "10:00"), (25, "10:00")))
    session.commit()
    b = OP.board(session)
    got = [(e["area"], e["open_at"], e["opened"], bool(e.get("expected")), e.get("rule", ""), len(e["courts"]))
           for e in b["openings"]]
    assert got == [("한남", "2026-11-15 09:00", False, True, "매월 15일·말일 09:00", 0),
                   ("장충", "2026-11-25 10:00", False, False, "", 1)]
    place = {p["area"]: p for p in b["places"]}
    assert (place["한남"]["next_open"], place["한남"]["next_expected"]) == ("2026-11-15 09:00", True)
    assert (place["장충"]["next_open"], place["장충"]["next_expected"]) == ("2026-11-25 10:00", False)
    assert place["장충"]["open_rule"] == "매월 10일·25일 10:00" and place["마루공원"]["open_rule"] == ""
    assert place["마루공원"]["next_open"] == ""


def test_board_notice_time_passed_without_official_rows(session, clock):
    _hannam(session)
    clock["now"] = datetime(2026, 11, 15, 9, 30)
    b = OP.board(session)
    # 공지된 시각이 지났지만 서울시 자료에 새 회차가 없음 → '공지 시각 지남'으로만 알리고, 다음 회차도 같이
    assert [(e["open_at"], e["opened"], e["expected"]) for e in b["openings"]] == [
        ("2026-11-15 09:00", True, True), ("2026-11-30 09:00", False, True)]
    # 2시간이 지나면 지난 회차 안내는 내린다
    clock["now"] = datetime(2026, 11, 15, 11, 0)
    assert [(e["open_at"], e["opened"]) for e in OP.board(session)["openings"]] == [("2026-11-30 09:00", False)]


def test_board_official_rows_replace_notice(session, clock):
    _hannam(session)
    # 서울시 자료에 실제 회차가 올라와 오늘 09:00 에 열림 → 공지 일정의 '오늘'은 빠지고 다음 회차만 남는다
    session.add(_s("h2", "한남테니스장 2번코트 평일 주간", "한남테니스장", "용산구", "접수중",
                   "2026-11-15 09:00", "2026-11-26 09:01", "2026-11-16", "2026-11-30"))
    session.commit()
    clock["now"] = datetime(2026, 11, 15, 9, 30)
    got = [(e["open_at"], e["opened"], bool(e.get("expected"))) for e in OP.board(session)["openings"]]
    assert got == [("2026-11-15 09:00", True, False), ("2026-11-30 09:00", False, True)]


def test_board_official_date_near_notice_wins(session, clock):
    _hannam(session)
    # 시설이 이번에는 하루 늦게(11/16) 연다고 올림 → 공지 일정(11/15)은 내지 않는다
    session.add(_s("h2", "한남테니스장 2번코트 평일 주간", "한남테니스장", "용산구", "안내중",
                   "2026-11-16 09:00", "2026-11-26 09:01", "2026-11-16", "2026-11-30"))
    session.commit()
    got = [(e["open_at"], bool(e.get("expected"))) for e in OP.board(session)["openings"]]
    assert got == [("2026-11-16 09:00", False)]


# ── 알림 판정 ───────────────────────────────────────────────────────

def test_alerts_from_notice_once_each(session, clock):
    _hannam(session)
    assert OP.pending_alerts(session) == []                       # 사흘 전 — 아직 아님
    clock["now"] = datetime(2026, 11, 14, 10, 0)                  # 전날
    due = OP.pending_alerts(session)
    assert [(k, s.slot_hash, s.open_at) for k, s in due] == [("d1", "rule:한남", "2026-11-15 09:00")]
    g = OP.group_for_message(due)
    assert [(x["kind"], x["place"], x["open_at"], x["expected"], x["areas"]) for x in g] == [
        ("d1", "한남테니스장", "2026-11-15 09:00", True, ["한남"])]
    OP.mark_alerted(session, due)
    assert OP.pending_alerts(session) == []                       # 한 번만
    clock["now"] = datetime(2026, 11, 15, 8, 20)                  # 1시간 전
    due = OP.pending_alerts(session)
    assert [(k, s.slot_hash) for k, s in due] == [("h1", "rule:한남")]
    OP.mark_alerted(session, due)
    # 그 뒤에 서울시 자료에 실제 회차가 올라와도 같은 오픈을 또 알리지 않는다
    session.add(_s("h2", "한남테니스장 2번코트 평일 주간", "한남테니스장", "용산구", "안내중",
                   "2026-11-15 09:00", "2026-11-26 09:01", "2026-11-16", "2026-11-30"))
    session.commit()
    assert OP.pending_alerts(session) == []
    # 앱 알림(채널이 다름)은 따로 한 번 — 공지 일정이 아니라 실제 회차로
    assert [(k, s.slot_hash) for k, s in OP.pending_alerts(session, prefix="p")] == [("h1", "h2")]


def test_official_rows_alert_instead_of_notice(session, clock):
    _hannam(session)
    session.add(_s("h2", "한남테니스장 2번코트 평일 주간", "한남테니스장", "용산구", "안내중",
                   "2026-11-15 09:00", "2026-11-26 09:01", "2026-11-16", "2026-11-30"))
    session.add(_s("h3", "한남테니스장 6번코트 평일 야간 및 주말", "한남테니스장", "용산구", "안내중",
                   "2026-11-15 09:03", "2026-11-26 09:01", "2026-11-16", "2026-11-30"))
    session.commit()
    clock["now"] = datetime(2026, 11, 14, 10, 0)
    due = OP.pending_alerts(session)
    assert sorted((k, s.slot_hash) for k, s in due) == [("d1", "h2"), ("d1", "h3")]
    # 09:00 과 09:03 은 한 묶음(공지 일정으로 보낸 앱 알림과 같은 열쇠가 되어 두 번 가지 않는다)
    g = OP.group_for_message(due)
    assert [(x["place"], x["open_at"], x["count"], x["expected"]) for x in g] == [
        ("한남테니스장", "2026-11-15 09:00", 2, False)]

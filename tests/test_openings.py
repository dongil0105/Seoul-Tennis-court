"""오픈 일정 엔진 테스트 — 스크리닝·이름 파싱·버킷·날짜 찾기·알람 판정."""
from __future__ import annotations

from datetime import date, timedelta

from app.clock import now as _now
from app.models import Slot
from app.services import openings as OP
from app.services.openings import day_type, is_watched, period_from_name, time_parts


def _slot(h, facility, place="한남테니스장", region="용산구", status="안내중",
          open_at="", use_from="", use_to="", ts="06:00", te="22:00"):
    return Slot(slot_hash=h, source_id="seoul_open_api", tier=1,
                facility_name=facility, court_name=place, region=region,
                date="", time_start=ts, time_end=te,
                is_open=(status == "접수중"), status=status, open_at=open_at,
                use_from=use_from, use_to=use_to,
                reserve_url="https://yeyak.seoul.go.kr/x")


def test_is_watched_region_and_keyword():
    assert is_watched("서초구", "아무 코트", "") is True
    assert is_watched("중구", "10/16~10/31장충테니스장 2번코트", "장충테니스장") is True  # 키워드
    assert is_watched("구로구", "계남테니스", "계남근린공원") is False


def test_day_type_and_time_parts():
    assert day_type("한남테니스장 3번코트 평일 새벽,주간") == "wd"
    assert day_type("장충테니스장 2번코트(주말 및 공휴일)") == "we"
    assert day_type("한남테니스장 11번코트 평일 야간 및 토요일") == "both"
    assert day_type("마루공원 테니스장 1면") == "any"
    assert "새벽" in time_parts("평일 새벽,주간", "06:00", "18:00")
    assert time_parts("마루공원 1면", "06:00", "22:00") == {"새벽", "주간", "야간"}
    assert time_parts("코트", "09:00", "17:00") == {"주간"}


def test_period_from_name():
    assert period_from_name("10/16~10/31장충테니스장", 2026) == (date(2026, 10, 16), date(2026, 10, 31))
    assert period_from_name("[평일]11월 망원나들목 2번 코트", 2026) == (date(2026, 11, 1), date(2026, 11, 30))
    # 연말 넘김: 12/16~1/15
    assert period_from_name("12/16~1/15 코트", 2026) == (date(2026, 12, 16), date(2027, 1, 15))
    assert period_from_name("마루공원 테니스장 1면", 2026) is None


def test_overview_buckets(session):
    now = _now()
    today = now.strftime("%Y-%m-%d")
    tmr = (now + timedelta(days=1)).strftime("%Y-%m-%d")
    nxt = (now + timedelta(days=10)).strftime("%Y-%m-%d")
    session.add(_slot("h1", "한남 1코트", open_at=f"{today} 23:59"))
    session.add(_slot("h2", "한남 2코트", open_at=f"{tmr} 09:00"))
    session.add(_slot("h3", "서울숲 주말 2027", place="서울숲", region="성동구", open_at=f"{nxt} 09:00"))
    session.add(_slot("h4", "마루공원 1면", place="마루공원", region="강남구", status="접수중",
                      open_at="2026-01-01 09:00"))
    session.add(_slot("h5", "다른구 코트", place="계남", region="구로구", status="접수중"))  # 비관심
    session.commit()
    ov = OP.overview(session)
    assert len(ov["today"]) == 1 and len(ov["tomorrow"]) == 1 and len(ov["upcoming"]) == 1
    assert len(ov["open_now"]) == 1
    assert ov["badge"] == 2
    assert ov["watched_total"] == 4  # 구로구 제외


def test_available_weekday_period_part(session, monkeypatch):
    # 2026-11-01은 일요일 (지난 날짜는 빈 결과라 '오늘'을 10/31로 고정)
    from datetime import datetime
    monkeypatch.setattr(OP, "_now", lambda: datetime(2026, 10, 31, 12, 0))
    target = date(2026, 11, 1)
    session.add(_slot("a1", "동부 도로사업소 A코트 주말 및 공휴일", place="동부도로", region="강남구",
                      status="접수중", use_from="2026-11-01", use_to="2026-11-15"))
    session.add(_slot("a2", "동부 도로사업소 A코트 평일주간", place="동부도로", region="강남구",
                      status="접수중", use_from="2026-11-01", use_to="2026-11-15"))
    session.add(_slot("a3", "10/16~10/31장충테니스장 2번코트(주말 및 공휴일)", place="장충테니스장",
                      region="중구", status="접수중"))  # 이름 기간이 지남 → 제외
    session.add(_slot("a4", "한남 5번코트 평일 야간 및 주말", status="접수중",
                      use_from="2026-01-01", use_to="2026-12-31"))
    session.commit()
    av = OP.available(session, target)
    names = [i["facility"] for i in av["items"]]
    assert "동부 도로사업소 A코트 주말 및 공휴일" in names
    assert "동부 도로사업소 A코트 평일주간" not in names      # 일요일이라 평일 제외
    assert all("장충" not in n for n in names)               # 기간 지난 회차 제외
    assert any("한남" in n for n in names)                   # both → 포함
    av_n = OP.available(session, target, part="야간")
    assert any("한남" in i["facility"] for i in av_n["items"])


def test_pending_alerts_d1_h1(session):
    now = _now()
    tmr = (now + timedelta(days=1)).strftime("%Y-%m-%d")
    soon = (now + timedelta(minutes=40)).strftime("%Y-%m-%d %H:%M")
    past = (now - timedelta(hours=3)).strftime("%Y-%m-%d %H:%M")
    session.add(_slot("p1", "내일 오픈 코트", open_at=f"{tmr} 09:00"))
    session.add(_slot("p2", "곧 오픈 코트", open_at=soon))
    session.add(_slot("p3", "이미 오픈 코트", open_at=past))
    session.commit()
    due = OP.pending_alerts(session)
    kinds = sorted(k for k, _ in due)
    assert kinds.count("d1") == 1
    assert kinds.count("h1") == 1          # p2만(p3는 지났고, p1은 내일이라 h1 아님)
    OP.mark_alerted(session, due)
    assert OP.pending_alerts(session) == []  # 중복 발송 방지


def test_group_for_message(session):
    now = _now()
    tmr = (now + timedelta(days=1)).strftime("%Y-%m-%d")
    pairs = []
    for i in range(3):
        s = _slot(f"g{i}", f"한남테니스장 {i}번코트 평일", open_at=f"{tmr} 09:00")
        pairs.append(("d1", s))
    g = OP.group_for_message(pairs)
    assert len(g) == 1 and g[0]["count"] == 3 and g[0]["place"] == "한남테니스장"

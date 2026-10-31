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
    assert OP.effective_status(s, NOW) == OP.UNCONFIRMED   # 09:00 지났는데 API는 아직 안내중 → 단정 안 함
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


def test_available_sections_court_level(session):
    _seed(session)
    av = OP.available(session, date(2026, 11, 1))
    sec = {x["key"]: x for x in av["sections"]}
    assert [x["key"] for x in av["sections"]] == ["open", "unconfirmed", "later", "rolling", "full"]
    # 공식 '접수중' 날짜용 회차만 open
    assert [p["place"] for p in sec["open"]["places"]] == ["동부도로사업소 테니스장"]
    # 한남: 오픈 시각은 지났지만 공식 상태 '안내중' → 확인 필요(접수중으로 단정 X)
    han = sec["unconfirmed"]["places"][0]
    assert han["place"] == "한남테니스장"
    assert han["courts"][0]["court"] == "1번 코트" and han["courts"][0]["slot"] == "일"
    assert han["courts"][0]["reserve_url"].endswith("/h1") and han["courts"][0]["state_label"] == "확인 필요"
    # 상시 코트는 코트별로(1면, 2면)
    maru = sec["rolling"]["places"][0]
    assert maru["place"] == "마루공원" and [c["court"] for c in maru["courts"]] == ["1면", "2면"]
    assert maru["courts"][0]["period"] == "상시 예약"
    assert [p["place"] for p in sec["full"]["places"]] == ["장충테니스장"]
    assert av["counts"] == {"open": 1, "unconfirmed": 1, "later": 0, "rolling": 2, "full": 1}
    # 11/22(일): 한남 다음 회차는 아직 오픈 전
    av2 = OP.available(session, date(2026, 11, 22))
    later = {x["key"]: x for x in av2["sections"]}["later"]["places"]
    assert later[0]["place"] == "한남테니스장" and later[0]["courts"][0]["open_at"] == "2026-11-12 09:00"
    assert OP.available(session, date(2026, 10, 30))["counts"]["open"] == 0   # 지난 날짜


def test_calendar_counts(session):
    _seed(session)
    cal = OP.calendar(session, days=3)
    by = {d["date"]: d for d in cal["days"]}
    assert (by["2026-11-01"]["open"], by["2026-11-01"]["unconfirmed"], by["2026-11-01"]["rolling"],
            by["2026-11-01"]["full"]) == (1, 1, 2, 1)
    assert by["2026-11-02"]["open"] == 0          # 월요일: 동부 주말·한남 일요일 둘 다 아님
    assert by["2026-10-31"]["weekday"] == "토"


@pytest.mark.parametrize("name,court,slot", [
    ("한남테니스장 10번코트 월요일 야간 및 주말", "10번 코트", "월 야간 · 주말·공휴일"),
    ("한남테니스장 2번코트 금요일 야간 및 일요일 ", "2번 코트", "금 야간 · 일"),
    ("한남테니스장 3번코트 평일 새벽,주간", "3번 코트", "평일 새벽·주간"),
    ("11/1~11/15장충테니스장 2번코트(주말 및 공휴일)", "2번 코트", "주말·공휴일"),
    ("마루공원 테니스장 1면 (조명)", "1면 조명", "매일"),
    ("2026년 중랑물재생센터 테니스장 B", "B코트", "매일"),
    ("테니스장1(토/일/공휴일)-2026년 응봉공원(대현산배수지)", "1번 코트", "주말·공휴일"),
    ("동부 도로사업소 테니스장 A코트 평일야간 11월1일~15일", "A코트", "평일 야간"),
    ("인재개발원 테니스장(인조잔디 A면) 대관", "A면", "매일"),
    ("탄천센터 테니스장 1면 조명쪽 (일원1,개포3동 주민 전용 시설) ", "1면", "매일"),
    ("탄천센터 테니스장 1면 조명쪽 (일원1,개포3동 주민 전용 시설) 조명", "1면 조명", "매일"),
    ("이촌 한강공원 테니스장 3번 코트 - 저녁", "3번 코트", "야간"),
])
def test_court_and_slot_labels(name, court, slot):
    assert OP.court_label(name) == court
    assert OP.slot_label(name) == slot


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
    sub = lambda ep: {"endpoint": f"https://fcm.googleapis.com/fcm/send/{ep}", "keys": {"p256dh": "x", "auth": "y"}}  # noqa: E731
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


# ── Codex 검수(REVIEW.md) 꼭 고칠 것 회귀 테스트 ─────────────────────

def test_use_period_year_by_overlap():
    s1 = _slot("y1", "12/16~1/15 테스트", use_from="2027-01-01", use_to="2027-01-15")
    assert OP.use_period(s1)[:2] == (date(2026, 12, 16), date(2027, 1, 15))
    s2 = _slot("y2", "10/1~10/15 테스트", use_from="2026-10-16", use_to="2026-10-31")
    assert OP.use_period(s2)[:2] == (date(2026, 10, 1), date(2026, 10, 15))   # 모순이면 다음 해로 안 밀기


def test_vanished_service_not_shown(session):
    from datetime import timedelta
    a = _slot("v1", "사라진 코트 1면", place="마루공원", region="강남구")
    b = _slot("v2", "남은 코트 1면", place="마루공원", region="강남구")
    a.last_seen = NOW - timedelta(minutes=20)      # 마지막 수집에 없었음
    b.last_seen = NOW
    session.add(a); session.add(b); session.commit()
    names = [c["name"] for sec in OP.available(session, date(2026, 11, 1))["sections"]
             for p in sec["places"] for c in p["courts"]]
    assert names == ["남은 코트 1면"]


def test_long_period_status_first(session):
    session.add(_slot("l1", "테니스장 매일", place="상시A", region="강남구", status="안내중",
                      open_at="2026-10-30 09:00", use_from="2026-01-01", use_to="2027-12-31"))
    session.add(_slot("l2", "테니스장 매일", place="상시B", region="강남구", status="안내중",
                      open_at="2026-11-01 09:00", use_from="2026-01-01", use_to="2027-12-31"))
    session.add(_slot("l3", "서울숲 테니스장 주말 2027년", place="서울숲", region="성동구", status="안내중",
                      open_at="2026-12-01 09:01", use_from="2026-10-29", use_to="2027-12-31"))
    session.commit()
    c = OP.available(session, date(2026, 11, 1))["counts"]
    assert c["unconfirmed"] == 1 and c["later"] == 1 and c["rolling"] == 0   # 2027년 서비스는 2026 날짜에 안 나옴


def test_midnight_hours():
    assert OP._hour_parts("22:00", "02:00") == {"야간", "새벽"}
    assert "주간" not in OP._hour_parts("22:00", "02:00")


def test_alerts_skip_suspended(session):
    session.add(_slot("a1", "중지된 코트", status="예약일시중지", open_at="2026-11-01 09:00"))
    session.add(_slot("a2", "열릴 코트", status="안내중", open_at="2026-11-01 09:00"))
    session.commit()
    due = OP.pending_alerts(session)
    assert [s.facility_name for _, s in due] == ["열릴 코트"]
    assert all(e["place"] for e in OP.overview(session)["soon"])


def test_push_endpoint_allowlist():
    assert WP.endpoint_allowed("https://fcm.googleapis.com/fcm/send/abc")
    assert WP.endpoint_allowed("https://web.push.apple.com/QK")
    assert WP.endpoint_allowed("https://wns2-bl2p.notify.windows.com/w/?token=x")
    assert not WP.endpoint_allowed("https://yeyak.seoul.go.kr/web/x")
    assert not WP.endpoint_allowed("http://fcm.googleapis.com/x")
    assert not WP.endpoint_allowed("https://fcm.googleapis.com.evil.com/x")
    assert not WP.endpoint_allowed("https://127.0.0.1/x")


def test_push_retry_only_failed_and_no_duplicate(session, monkeypatch):
    WP._keys.cache_clear()
    monkeypatch.setattr(WP.settings, "seoul_api_key", "test-secret")
    for ep in ("ok", "bad"):
        WP.subscribe(session, {"endpoint": f"https://fcm.googleapis.com/fcm/send/{ep}",
                               "keys": {"p256dh": "x", "auth": "y"}})
    calls = []
    def fake(s, row, payload, ttl=0):
        calls.append(row.endpoint.rsplit("/", 1)[1])
        return not row.endpoint.endswith("bad")
    monkeypatch.setattr(WP, "_send", fake)
    g = [{"kind": "d1", "place": "한남테니스장", "areas": ["용산", "한남"], "open_at": "2026-11-01 09:00",
          "count": 3, "reserve_url": "https://y/1"}]
    assert WP.send_opening_alerts(session, g) == 1
    assert sorted(calls) == ["bad", "ok"]
    calls.clear()
    assert WP.send_opening_alerts(session, g) == 0       # 실패한 기기만 다시 시도
    assert calls == ["bad"]
    WP._keys.cache_clear()


def test_subscription_change_keeps_settings(session, monkeypatch):
    WP._keys.cache_clear()
    monkeypatch.setattr(WP.settings, "seoul_api_key", "test-secret")
    k = {"p256dh": "x", "auth": "y"}
    WP.subscribe(session, {"endpoint": "https://fcm.googleapis.com/fcm/send/old", "keys": k},
                 ["강남"], d1=False, h1=True)
    r = WP.subscribe(session, {"endpoint": "https://fcm.googleapis.com/fcm/send/new", "keys": k},
                     None, None, None, old_endpoint="https://fcm.googleapis.com/fcm/send/old")
    assert r["ok"]
    from sqlmodel import select
    rows = session.exec(select(WP.PushSub)).all()
    assert [x.endpoint.rsplit("/", 1)[1] for x in rows] == ["new"]
    assert json.loads(rows[0].areas) == ["강남"] and rows[0].d1 is False and rows[0].h1 is True
    WP._keys.cache_clear()


# ── Codex 재검수(REVIEW2.md) 회귀 테스트 ─────────────────────────────

def test_vanished_service_90s_gap(session):
    from datetime import timedelta
    a = _slot("w1", "사라진 코트 2면", place="마루공원", region="강남구")
    b = _slot("w2", "남은 코트 2면", place="마루공원", region="강남구")
    a.last_seen = NOW - timedelta(seconds=90)      # 새로 고침 쿨다운 직후 수집에서 빠짐
    b.last_seen = NOW
    session.add(a); session.add(b); session.commit()
    names = [c["name"] for sec in OP.available(session, date(2026, 11, 1))["sections"]
             for p in sec["places"] for c in p["courts"]]
    assert names == ["남은 코트 2면"]


def test_no_alert_when_use_period_ends_before_open(session):
    session.add(_slot("c1", "모순 코트", status="안내중", open_at="2026-11-01 09:00",
                      use_from="2026-10-01", use_to="2026-10-30"))
    session.commit()
    assert OP.pending_alerts(session) == []
    assert OP.overview(session)["soon"] == []


def test_send_refuses_legacy_endpoint(session, monkeypatch):
    WP._keys.cache_clear()
    monkeypatch.setattr(WP.settings, "seoul_api_key", "test-secret")
    row = WP.PushSub(endpoint="https://yeyak.seoul.go.kr/legacy", p256dh="x", auth="y")
    session.add(row); session.commit()
    called = []
    import pywebpush
    monkeypatch.setattr(pywebpush, "webpush", lambda **kw: called.append(kw))
    assert WP._send(session, row, {"title": "t"}) is False
    assert called == []
    from sqlmodel import select
    assert session.exec(select(WP.PushSub)).all() == []
    WP._keys.cache_clear()


def test_endpoint_bad_port_and_short_vapid(monkeypatch):
    assert WP.endpoint_allowed("https://fcm.googleapis.com:bad/a") is False
    WP._keys.cache_clear()
    monkeypatch.setattr(WP.settings, "vapid_private_key", "AQ")       # 1바이트 → 무시하고 대체 키
    monkeypatch.setattr(WP.settings, "seoul_api_key", "test-secret")
    k_short = WP.public_key()
    WP._keys.cache_clear()
    monkeypatch.setattr(WP.settings, "vapid_private_key", "")
    assert WP.public_key() == k_short
    WP._keys.cache_clear()


def test_empty_official_result_hides_old_rows(session, monkeypatch):
    from datetime import timedelta
    from app.services import sync as SYNC
    s = _slot("e9", "옛 코트 1면", place="마루공원", region="강남구")
    s.last_seen = NOW - timedelta(minutes=10)
    session.add(s); session.commit()
    assert OP.available(session, date(2026, 11, 1))["counts"]["rolling"] == 1
    monkeypatch.setitem(SYNC.EMPTY_OK, "seoul_open_api", NOW)       # 정상 응답 · 테니스 0건
    assert OP.available(session, date(2026, 11, 1))["counts"]["rolling"] == 0


def test_send_opening_alerts_own_session(session, monkeypatch):
    WP._keys.cache_clear()
    monkeypatch.setattr(WP.settings, "seoul_api_key", "test-secret")
    import app.db as DB
    from contextlib import contextmanager
    @contextmanager
    def fake_session():
        yield session
    monkeypatch.setattr(DB, "get_session", fake_session)
    WP.subscribe(session, {"endpoint": "https://fcm.googleapis.com/fcm/send/z", "keys": {"p256dh": "x", "auth": "y"}})
    monkeypatch.setattr(WP, "_send", lambda s, row, payload, ttl=0: True)
    g = [{"kind": "d1", "place": "한남테니스장", "areas": ["한남"], "open_at": "2026-11-01 09:00",
          "count": 1, "reserve_url": "https://y/1"}]
    assert WP.send_opening_alerts(None, g) == 1
    WP._keys.cache_clear()


@pytest.mark.parametrize("payload,expect", [
    ({"ListPublicReservationSport": {"RESULT": {"CODE": "INFO-000"}, "row": [{"SVCNM": "축구장", "MINCLASSNM": "축구장", "PLACENM": "x"}]}}, True),
    ({"RESULT": {"CODE": "INFO-200", "MESSAGE": "해당하는 데이터가 없습니다."}}, True),
    ({"ListPublicReservationSport": {"RESULT": {"CODE": "ERROR-500"}, "row": [{"SVCNM": "축구장", "MINCLASSNM": "축구장", "PLACENM": "x"}]}}, False),
    ({"ListPublicReservationSport": {"RESULT": {"CODE": "INFO-000"}, "row": [{}]}}, False),
    ({"ListPublicReservationSport": {"row": [{"SVCNM": "축구장", "MINCLASSNM": "축구장"}]}}, False),
])
def test_empty_ok_only_for_valid_response(monkeypatch, payload, expect):
    import asyncio
    from app.collectors import seoul_open_api as C
    from app.services import sync as SYNC
    monkeypatch.setattr(C.settings, "seoul_api_key", "k")
    monkeypatch.setattr(SYNC, "EMPTY_OK", {})

    class R:
        def json(self):
            return payload

    async def fake(*a, **kw):
        return R()
    monkeypatch.setattr(C, "request_with_retry", fake)
    assert asyncio.run(C.SeoulOpenApiCollector().fetch()) == []
    assert ("seoul_open_api" in SYNC.EMPTY_OK) is expect

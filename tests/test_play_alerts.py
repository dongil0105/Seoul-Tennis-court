"""반포 알림 — 예약 오픈 예고(전날 20시 · 1시간 전)와 새로 생긴 빈 시간.

실제 테니스플레이·카카오·푸시 서버에는 접속하지 않는다(가짜 서버 · 가짜 발송).
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta

import pytest

import app.models  # noqa: F401  (표 정의를 먼저 불러와야 테스트용 DB에 표가 생긴다)
from app.models import PushSub
from app.services import openings as OP
from app.services import tennisplay as TP
from app.services import webpush as WP
from tests.test_tennisplay import Fake, _b, _use

DAY = "2026-11-14"                                  # 토요일


class Clock:
    def __init__(self, at: datetime):
        self.at = at

    def __call__(self) -> datetime:
        return self.at

    def add(self, minutes: int) -> None:
        self.at += timedelta(minutes=minutes)


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    c = Clock(datetime(2026, 11, 13, 14, 20))       # 금요일 14:20
    TP.reset()
    for mod in (TP, OP, WP):
        monkeypatch.setattr(mod, "_now", c)
    monkeypatch.setattr(TP, "PAUSE", 0)
    monkeypatch.setattr(TP.settings, "ttp_email", "me@example.com")
    monkeypatch.setattr(TP.settings, "ttp_password", "pw-not-real")
    monkeypatch.setattr(TP.settings, "ttp_facility_keyword", "반포")
    monkeypatch.setattr(TP.settings, "ttp_notify_open", True)
    monkeypatch.setattr(TP.settings, "ttp_notify_free", True)
    monkeypatch.setattr(TP.settings, "ttp_free_daily_max", 40)
    yield c
    TP.TRANSPORT = None
    TP.reset()


def _cells(items):
    return [(i["date"], i["s"], i["e"], i["court"]) for i in items]


# ── 예약 오픈 예고 ─────────────────────────────────────────────────

def test_open_alert_times_eve_20_and_one_hour_before():
    f, at = TP.open_alert_times, datetime(2026, 11, 14, 9, 0)
    assert f(datetime(2026, 11, 13, 19, 59)) == []
    assert f(datetime(2026, 11, 13, 20, 0)) == [("d1", at)]
    assert f(datetime(2026, 11, 13, 23, 59)) == [("d1", at)]
    assert f(datetime(2026, 11, 14, 0, 30)) == []           # 자정이 지나면 '내일 오픈'이 아니다
    assert f(datetime(2026, 11, 14, 7, 59)) == []
    assert f(datetime(2026, 11, 14, 8, 0)) == [("h1", at)]
    assert f(datetime(2026, 11, 14, 8, 59)) == [("h1", at)]
    assert f(datetime(2026, 11, 14, 9, 0)) == []            # 열린 뒤에는 다음 날 것을 기다린다


def test_open_alerts_off_when_disabled_or_not_configured(monkeypatch):
    eve = datetime(2026, 11, 13, 21, 0)
    assert TP.open_alert_times(eve) and TP.open_badge(eve) == 1
    monkeypatch.setattr(TP.settings, "ttp_notify_open", False)
    assert TP.open_alert_times(eve) == [] and TP.open_badge(eve) == 0
    monkeypatch.setattr(TP.settings, "ttp_notify_open", True)
    monkeypatch.setattr(TP.settings, "ttp_password", "")
    assert TP.open_alert_times(eve) == [] and TP.open_badge(eve) == 0


def test_open_badge_from_eve_until_open():
    assert TP.open_badge(datetime(2026, 11, 13, 19, 59)) == 0
    assert TP.open_badge(datetime(2026, 11, 13, 20, 0)) == 1
    assert TP.open_badge(datetime(2026, 11, 14, 3, 0)) == 1
    assert TP.open_badge(datetime(2026, 11, 14, 8, 59)) == 1
    assert TP.open_badge(datetime(2026, 11, 14, 9, 0)) == 0
    assert TP.open_note(datetime(2026, 11, 14, 9, 0)) == "11.21(토) 이용분"


def test_pending_alerts_include_banpo_once_per_channel(session, clock):
    clock.at = datetime(2026, 11, 13, 20, 5)
    play = [(k, s) for k, s in OP.pending_alerts(session) if s.source_id == TP.SOURCE]
    assert [(k, s.open_at) for k, s in play] == [("d1", "2026-11-14 09:00")]
    g = OP.group_for_message(play)[0]
    assert g["place"] == "반포종합운동장 테니스장" and g["areas"] == ["반포"]
    assert g["opt_in"] is True and g["note"] == "11.21(토) 이용분" and g["expected"] is False
    OP.mark_alerted(session, play)
    assert not [1 for _, s in OP.pending_alerts(session) if s.source_id == TP.SOURCE]      # 카카오는 한 번만
    assert [k for k, s in OP.pending_alerts(session, prefix="p") if s.source_id == TP.SOURCE] == ["d1"]
    clock.at = datetime(2026, 11, 14, 8, 10)
    assert [k for k, s in OP.pending_alerts(session) if s.source_id == TP.SOURCE] == ["h1"]


def test_other_places_groups_are_not_opt_in(session):
    from app.models import Slot
    s = Slot(slot_hash="x", source_id="seoul_open_api", tier=1, facility_name="한남테니스장 1번",
             court_name="한남테니스장", region="용산구", date="2026-11-15", time_start="", time_end="",
             is_open=False, status="안내중", open_at="2026-11-15 09:00", reserve_url=None)
    g = OP.group_for_message([("d1", s)])[0]
    assert g["opt_in"] is False and g["note"] == ""


# ── 앱 알림: 고른 기기에만 ─────────────────────────────────────────

def _subs(session, **areas):
    for name, a in areas.items():
        session.add(PushSub(endpoint=f"https://fcm.googleapis.com/{name}", p256dh="k", auth="a",
                            areas=json.dumps(a, ensure_ascii=False)))
    session.commit()


@pytest.fixture()
def outbox(monkeypatch):
    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(WP, "ready", lambda: True)
    monkeypatch.setattr(WP, "_send",
                        lambda s, row, payload, ttl=3600: sent.append((row.endpoint[-1], payload)) or True)
    return sent


def test_open_push_only_to_devices_that_chose_banpo(session, clock, outbox):
    _subs(session, a=["한남"], b=["한남", "반포"], c=[])       # c = 예전 구독(전체) — 반포는 고른 적 없음
    clock.at = datetime(2026, 11, 13, 20, 5)
    groups = OP.group_for_message(
        [(k, s) for k, s in OP.pending_alerts(session, prefix="p") if s.source_id == TP.SOURCE])
    assert WP.send_opening_alerts(session, groups, badge=1, play_badge=1) == 1
    assert [who for who, _ in outbox] == ["b"]
    p = outbox[0][1]
    assert p["title"] == "반포종합운동장 테니스장 예약 내일 09:00 오픈"
    assert "11.21(토) 이용분" in p["body"] and p["badge"] == 2
    assert WP.send_opening_alerts(session, groups, 1, 1) == 0     # 같은 알림은 다시 가지 않는다


def test_other_place_badge_adds_banpo_only_for_its_devices(session, outbox):
    _subs(session, a=["한남"], b=["한남", "반포"])
    g = {"kind": "d1", "place": "한남테니스장", "region": "용산구", "areas": ["한남"],
         "open_at": "2026-11-14 09:00", "count": 3, "reserve_url": None, "expected": False}
    assert WP.send_opening_alerts(session, [g], badge=1, play_badge=1) == 2
    assert {who: p["badge"] for who, p in outbox} == {"a": 1, "b": 2}


def test_free_push_only_to_devices_that_turned_it_on(session, outbox):
    _subs(session, a=["한남", "반포"], b=["한남", "반포 빈 시간"], c=["반포", "반포 빈 시간"], d=[])
    n = WP.send_play_free(session, "반포 빈 시간이 생겼어요", "11.14(토) 20~21시 · 1번 코트", 1, 1)
    assert n == 2 and sorted(who for who, _ in outbox) == ["b", "c"]
    by = dict(outbox)
    assert by["b"]["badge"] == 1 and by["c"]["badge"] == 2
    assert by["b"]["url"] == "/#play" and by["b"]["body"].startswith("11.14(토)")
    assert WP.send_play_free(session, "t", "", 0, 0) == 0


def test_clean_areas_keeps_banpo_only_when_this_server_reads_it(monkeypatch):
    base = OP.all_areas()
    one = base[0]
    assert WP._clean_areas([one, "반포", "반포 빈 시간", "엉뚱한 곳"]) == [one, "반포", "반포 빈 시간"]
    assert WP._clean_areas(None) == base            # 설정 없이 온 구독은 원래 5곳만 — 반포는 고른 기기에만
    assert WP._clean_areas([]) == base
    assert "반포" not in base
    monkeypatch.setattr(TP.settings, "ttp_password", "")
    assert WP._clean_areas([one, "반포", "반포 빈 시간"]) == [one]


# ── 새로 생긴 빈 시간 ──────────────────────────────────────────────

async def test_first_read_is_baseline_not_an_alert():
    _use(Fake([_b(11, DAY, 6, 20)]))                 # 20~22시가 처음부터 비어 있음
    assert await TP.refresh()
    assert TP.take_new_free() == []


async def test_cancelled_booking_is_alerted_once(clock):
    fake = _use(Fake([_b(11, DAY, 6, 22)]))
    await TP.refresh()
    fake.bookings = [_b(11, DAY, 6, 20), _b(11, DAY, 21, 22)]      # 20~21시 예약이 취소됨
    clock.add(10)
    await TP.refresh()
    items = TP.take_new_free()
    assert _cells(items) == [(DAY, 20.0, 21.0, "1번")]
    assert TP.free_message(items) == ("반포 빈 시간이 생겼어요", "11.14(토) 20~21시 · 1번 코트")
    assert TP.take_new_free() == []                  # 꺼낸 뒤에는 다시 나오지 않는다
    clock.add(10)
    await TP.refresh()                               # 그대로 비어 있어도 다시 알리지 않는다
    assert TP.take_new_free() == []


async def test_same_cell_is_not_repeated_within_cooldown(clock):
    booked, freed = [_b(11, DAY, 6, 22)], [_b(11, DAY, 6, 20), _b(11, DAY, 21, 22)]
    fake = _use(Fake(booked))
    await TP.refresh()
    for step in (freed, booked, freed):
        fake.bookings = step
        clock.add(10)
        await TP.refresh()
        if step is freed:
            got = TP.take_new_free()
    assert got == []                                 # 두 번째로 비었을 때는 3시간 안이라 건너뜀
    fake.bookings = booked
    clock.add(10)
    await TP.refresh()
    fake.bookings = freed
    clock.add(181)                                   # 3시간이 지난 뒤 다시 비면 알린다
    await TP.refresh()
    assert _cells(TP.take_new_free()) == [(DAY, 20.0, 21.0, "1번")]


async def test_rebooked_before_sending_is_dropped(clock):
    fake = _use(Fake([_b(11, DAY, 6, 22)]))
    await TP.refresh()
    fake.bookings = [_b(11, DAY, 6, 20), _b(11, DAY, 21, 22)]
    clock.add(10)
    await TP.refresh()                               # 비었지만(무음 시간 등으로) 아직 안 보냄
    fake.bookings = [_b(11, DAY, 6, 22)]
    clock.add(10)
    await TP.refresh()                               # 그사이 누가 다시 예약
    assert TP.take_new_free() == []


async def test_newly_opened_day_is_not_an_alert(clock):
    clock.at = datetime(2026, 11, 13, 8, 50)
    _use(Fake([]))
    await TP.refresh()                               # 11/19 까지
    clock.at = datetime(2026, 11, 13, 9, 0, 20)
    await TP.refresh()                               # 11/20 이 새로 열려 전부 비어 있음
    assert TP.take_new_free() == []


async def test_started_or_past_time_is_not_alerted(clock):
    today = "2026-11-13"
    fake = _use(Fake([_b(11, today, 6, 22)]))
    await TP.refresh()                               # 14:20
    fake.bookings = [_b(11, today, 6, 14), _b(11, today, 16, 22)]   # 14~15시(이미 시작) · 15~16시가 빔
    clock.add(10)
    await TP.refresh()
    assert _cells(TP.take_new_free()) == [(today, 15.0, 16.0, "1번")]


async def test_changed_court_list_is_not_compared(clock):
    fake = _use(Fake([_b(11, DAY, 6, 22)]))
    await TP.refresh()
    fake.courts = fake.courts + [{"id": 13, "court_name": "3번 코트", "use_start_time": "6",
                                  "use_end_time": "22", "num_of_hour_divided": 1}]
    clock.add(10)
    await TP.refresh()                               # 코트가 늘었다고 그 코트 전부를 '새 빈 시간'으로 알리지 않는다
    assert TP.take_new_free() == []


def test_free_message_groups_courts_and_limits_lines():
    items = [{"date": "2026-11-17", "s": 14.0, "e": 15.0, "court": "2번", "n": 1},
             {"date": "2026-11-17", "s": 14.0, "e": 15.0, "court": "6번", "n": 5},
             {"date": "2026-11-16", "s": 9.5, "e": 10.0, "court": "실내 1번", "n": 0}]
    _, body = TP.free_message(items)
    assert body.split("\n") == ["11.16(월) 9:30~10:00 · 실내 1번 코트", "11.17(화) 14~15시 · 2·6번 코트"]
    many = [{"date": "2026-11-17", "s": float(h), "e": float(h + 1), "court": "1번", "n": 0} for h in range(6, 13)]
    lines = TP.free_message(many)[1].split("\n")
    assert len(lines) == 5 and lines[-1] == "외 3건"


def test_free_budget_limits_per_day(monkeypatch, clock):
    monkeypatch.setattr(TP.settings, "ttp_free_daily_max", 2)
    assert TP.free_budget() and TP.free_budget() and not TP.free_budget()
    clock.at = datetime(2026, 11, 14, 6, 5)
    assert TP.free_budget()


async def test_scheduler_sends_after_quiet_hours_only_what_is_still_free(monkeypatch, clock, session):
    from contextlib import contextmanager

    import app.scheduler as SCH
    from app.services import feed as FEED
    sent: list[tuple[str, str]] = []

    @contextmanager
    def mem_session():                               # 보낸 알림 기록이 실제 DB 파일에 남지 않게
        yield session
    monkeypatch.setattr(SCH, "get_session", mem_session)

    async def fake_kakao(session, title, body):
        sent.append((title, body))
        return True

    quiet = {"on": True}
    monkeypatch.setattr(SCH, "kakao_ready", lambda: True)
    monkeypatch.setattr(SCH, "send_play_free", fake_kakao)
    monkeypatch.setattr(SCH, "in_quiet_hours", lambda: quiet["on"])
    monkeypatch.setattr(SCH.WP, "ready", lambda: False)
    fake = _use(Fake([_b(11, DAY, 6, 22), _b(12, DAY, 6, 22)]))
    await TP.refresh()
    fake.bookings = [_b(11, DAY, 6, 20), _b(11, DAY, 21, 22), _b(12, DAY, 6, 21)]   # 1번 20시 · 2번 21시가 빔
    clock.add(10)
    await TP.refresh()
    await SCH._notify_play_free()
    assert sent == []                                # 무음 시간에는 보내지 않고 모아 둔다
    fake.bookings = [_b(11, DAY, 6, 22), _b(12, DAY, 6, 21)]                         # 1번 20시는 다시 예약됨
    clock.add(10)
    await TP.refresh()
    quiet["on"] = False
    await SCH._notify_play_free()
    assert sent == [("반포 빈 시간이 생겼어요", "11.14(토) 21~22시 · 2번 코트")]
    await SCH._notify_play_free()
    assert len(sent) == 1
    # 카카오톡으로만 보냈어도 앱 안 '새 알림'에 뜨게 기록한다
    assert [(r["area"], r["kind"], r["text"]) for r in FEED.recent(session)] == [
        ("반포", "free", "11.14(토) 21~22시 · 2번 코트")]


async def test_scheduler_free_alerts_can_be_turned_off(monkeypatch, clock):
    import app.scheduler as SCH
    monkeypatch.setattr(TP.settings, "ttp_notify_free", False)
    monkeypatch.setattr(SCH, "kakao_ready", lambda: (_ for _ in ()).throw(AssertionError("보내면 안 됨")))
    fake = _use(Fake([_b(11, DAY, 6, 22)]))
    await TP.refresh()
    fake.bookings = []
    clock.add(10)
    await TP.refresh()
    await SCH._notify_play_free()
    assert TP.S.pending == {}


def test_public_view_tells_the_app_about_alerts(clock):
    pub = TP.public()
    assert pub["alerts"] == {"open": True, "free": True} and pub["badge"] == 0
    clock.at = datetime(2026, 11, 13, 21, 0)
    assert TP.public()["badge"] == 1

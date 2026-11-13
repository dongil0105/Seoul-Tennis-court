"""테니스플레이(반포종합운동장) 빈 시간 — 계산·로그인·실패 처리. 실제 사이트에는 접속하지 않는다(가짜 서버)."""
from __future__ import annotations

import json
from datetime import date, datetime

import httpx
import pytest

import app.models  # noqa: F401  (표 정의를 먼저 불러와야 테스트용 DB에 표가 생긴다)
from app.services import tennisplay as TP

NOW = datetime(2026, 11, 13, 14, 20)          # 금요일 14:20


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    TP.reset()
    monkeypatch.setattr(TP, "_now", lambda: NOW)
    monkeypatch.setattr(TP, "PAUSE", 0)
    monkeypatch.setattr(TP.settings, "ttp_email", "me@example.com")
    monkeypatch.setattr(TP.settings, "ttp_password", "pw-not-real")
    monkeypatch.setattr(TP.settings, "ttp_facility_keyword", "반포")
    yield
    TP.TRANSPORT = None
    TP.reset()


COURTS = [
    {"id": 12, "court_name": "2번 코트", "use_start_time": "6", "use_end_time": "22", "num_of_hour_divided": 1},
    {"id": 11, "court_name": "1번 코트", "use_start_time": "6", "use_end_time": "22", "num_of_hour_divided": 1},
]


def _b(court, day, start, end, kind="unavailable", **extra):
    return {"id": f"{court}-{day}-{start}", "court_id": court, "booking_date": day,
            "start_time": str(start), "end_time": str(end), "booking_type": kind, **extra}


class Fake:
    """테니스플레이 서버 흉내. 요청 기록을 남긴다."""

    def __init__(self, bookings=(), *, courts=COURTS, combined_ok=True, token="T1"):
        self.bookings, self.courts, self.combined_ok, self.token = list(bookings), courts, combined_ok, token
        self.calls: list[tuple[str, str, list[str]]] = []
        self.logins = 0
        self.login_status = 200
        self.fail_range: int | None = None
        self.expired: set[str] = set()

    def __call__(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path.replace("/api/v1", "")
        dates = req.url.params.get_list("date_array[]")
        self.calls.append((req.method, path, dates))
        if path == "/users/sso_sessions" and req.method == "POST":
            self.logins += 1
            body = json.loads(req.content)
            assert body["provider"] == "email" and set(body["user_params"]) == {"email", "password"}
            if self.login_status != 200:
                return httpx.Response(self.login_status, json={"error": "x"})
            return httpx.Response(200, json={"access_token": self.token, "role": "player", "user_id": 7})
        auth = req.headers.get("authorization", "")
        if auth != f"Bearer {self.token}" or self.token in self.expired:
            self.expired.discard(self.token)
            return httpx.Response(401, json={})
        if path == "/facilities/":
            return httpx.Response(200, json={"facilities": [
                {"id": 2, "facility_name": "다른 테니스장"},
                {"id": 5, "facility_name": "반포종합운동장 테니스장", "configurations": {}}]})
        if path == "/bookings/player_bookings_in_range":
            assert req.url.params["facility_id"] == "5"
            if self.fail_range:
                return httpx.Response(self.fail_range, json={})
            use = dates if self.combined_ok else dates[:1]      # 첫 날짜만 듣는 서버 흉내
            return httpx.Response(200, json={"courts": self.courts,
                                             "bookings": [b for b in self.bookings if b["booking_date"] in use]})
        return httpx.Response(404, json={})


def _use(fake: Fake) -> Fake:
    TP.TRANSPORT = httpx.MockTransport(fake)
    return fake


def _day(pub, day):
    return next(d for d in pub["days"] if d["date"] == day)


def _hours(d):
    return [(s["s"], s["e"], s["courts"]) for s in d["slots"]]


# ── 계산 ──────────────────────────────────────────────────────────

def test_court_label():
    assert TP.court_label("1번 코트") == "1번"
    assert TP.court_label("코트 3") == "3번"
    assert TP.court_label("07") == "7번"
    assert TP.court_label("A코트") == "A코트"
    assert TP.court_label("실내 1번") == "실내 1번"
    assert TP.court_label("") == "?"


def test_selectable_dates_and_next_open():
    before = datetime(2026, 11, 13, 8, 59)
    assert TP.selectable_dates(before)[-1] == date(2026, 11, 19)        # 09시 전에는 6일 뒤까지
    assert TP.next_open(before) == (date(2026, 11, 20), datetime(2026, 11, 13, 9, 0))
    after = datetime(2026, 11, 13, 9, 0)
    assert TP.selectable_dates(after)[-1] == date(2026, 11, 20)         # 09시부터 7일 뒤까지
    assert len(TP.selectable_dates(after)) == 8
    assert TP.next_open(after) == (date(2026, 11, 21), datetime(2026, 11, 14, 9, 0))


def test_build_days_free_is_hours_minus_bookings():
    courts = TP.parse_courts(COURTS)
    assert [c["label"] for c in courts] == ["1번", "2번"]                # 코트는 id 순
    busy = TP.parse_busy([_b(11, "2026-11-14", 6, 21), _b(12, "2026-11-14", 6, 20),
                          _b(12, "2026-11-14", 21, 22)], {"2026-11-14"})
    d = TP.build_days(courts, busy, [date(2026, 11, 14)], NOW)[0]
    assert _hours(d) == [(20.0, 21.0, ["2번"]), (21.0, 22.0, ["1번"])]


def test_today_starts_from_current_hour():
    courts = TP.parse_courts(COURTS[:1])
    d = TP.build_days(courts, {}, [date(2026, 11, 13)], NOW)[0]         # 14:20 → 14시 칸부터(테니스플레이 화면과 같게)
    assert d["slots"][0]["s"] == 14.0 and d["slots"][-1]["e"] == 22.0
    late = datetime(2026, 11, 13, 22, 5)
    assert TP.build_days(courts, {}, [date(2026, 11, 13)], late)[0]["slots"] == []


def test_half_hour_slots_and_long_booking():
    courts = TP.parse_courts([{"id": 1, "court_name": "1", "use_start_time": "9", "use_end_time": "11",
                               "num_of_hour_divided": 2}])
    busy = TP.parse_busy([_b(1, "2026-11-14", 9.5, 10.5)], {"2026-11-14"})   # 한 건이 두 칸을 덮음
    d = TP.build_days(courts, busy, [date(2026, 11, 14)], NOW)[0]
    assert _hours(d) == [(9.0, 9.5, ["1번"]), (10.5, 11.0, ["1번"])]


def test_camel_case_and_clock_strings_are_read():
    courts = TP.parse_courts([{"id": 1, "courtName": "1번", "useStartTime": "06:00", "useEndTime": "08:00"}])
    busy = TP.parse_busy([{"courtId": 1, "bookingDate": "2026-11-14T00:00:00", "startTime": "06:00",
                           "endTime": "07:00", "bookingType": "reserved"}], {"2026-11-14"})
    d = TP.build_days(courts, busy, [date(2026, 11, 14)], NOW)[0]
    assert _hours(d) == [(7.0, 8.0, ["1번"])]


def test_unreadable_booking_is_an_error_not_a_free_slot():
    with pytest.raises(TP.PlayError):
        TP.parse_busy([{"court_id": 1, "booking_date": "2026-11-14", "start_time": "x", "end_time": "7",
                        "booking_type": "unavailable"}], {"2026-11-14"})
    with pytest.raises(TP.PlayError):
        TP.parse_courts([])
    with pytest.raises(TP.PlayError):
        TP.parse_courts([{"id": 1, "court_name": "1번"}])            # 운영 시간이 없음


def test_open_type_is_not_busy():
    busy = TP.parse_busy([_b(11, "2026-11-14", 6, 7, kind="open")], {"2026-11-14"})
    assert busy == {}


# ── 조회 흐름 ─────────────────────────────────────────────────────

async def test_not_configured_does_nothing(monkeypatch):
    monkeypatch.setattr(TP.settings, "ttp_password", "")
    fake = _use(Fake())
    assert TP.ready() is False
    assert await TP.refresh() is False
    assert TP.public() is None and fake.calls == []


async def test_refresh_builds_public_view():
    fake = _use(Fake([_b(11, "2026-11-13", h, h + 1) for h in range(6, 22)]              # 오늘 1번은 종일 참
                     + [_b(12, "2026-11-13", h, h + 1) for h in range(6, 20)]           # 오늘 2번은 20시부터 빔
                     + [_b(c, "2026-11-15", h, h + 1) for c in (11, 12) for h in range(6, 22)]))   # 일요일 마감
    assert TP.public()["ok"] is False and TP.public()["state"] == "loading"
    assert await TP.refresh() is True
    pub = TP.public()
    assert pub["ok"] is True and pub["place"] == "반포종합운동장 테니스장"
    assert pub["url"] == "https://www.thetennisplay.com/schedule-booking"
    assert pub["courts"] == ["1번", "2번"] and pub["stale"] is False
    assert [d["date"] for d in pub["days"]] == [f"2026-11-{n}" for n in range(13, 21)]   # 오늘 ~ 7일 뒤
    assert _hours(_day(pub, "2026-11-13")) == [(20.0, 21.0, ["2번"]), (21.0, 22.0, ["2번"])]
    assert _day(pub, "2026-11-15")["slots"] == []
    assert len(_day(pub, "2026-11-14")["slots"]) == 16                                  # 예약 없는 날은 전부 빔
    assert pub["next_open"] == {"date": "2026-11-21", "at": "2026-11-14 09:00"}
    assert fake.logins == 1


async def test_per_date_first_then_combined_when_verified():
    fake = _use(Fake([_b(11, "2026-11-13", 20, 21), _b(11, "2026-11-14", 7, 8)]))
    assert await TP.refresh() is True
    ranges = [c for c in fake.calls if c[1].endswith("in_range")]
    assert [len(c[2]) for c in ranges] == [1] * 8 + [8]        # 날짜별 8번 + 확인용 한 번
    assert TP.S.combined is True
    fake.calls.clear()
    assert await TP.refresh() is True
    assert [len(c[2]) for c in fake.calls if c[1].endswith("in_range")] == [8]   # 그 뒤로는 한 번만
    assert _hours(_day(TP.public(), "2026-11-14"))[1][2] == ["2번"]              # 07시는 2번만 빔


async def test_server_that_ignores_extra_dates_keeps_per_date():
    fake = _use(Fake([_b(11, "2026-11-13", 20, 21), _b(11, "2026-11-14", 7, 8)], combined_ok=False))
    assert await TP.refresh() is True
    assert TP.S.combined is False
    fake.calls.clear()
    assert await TP.refresh() is True
    assert [len(c[2]) for c in fake.calls if c[1].endswith("in_range")] == [1] * 8   # 계속 날짜별, 확인은 하루 한 번
    assert _hours(_day(TP.public(), "2026-11-14"))[1][2] == ["2번"]


async def test_combined_not_trusted_without_two_busy_days():
    _use(Fake([_b(11, "2026-11-13", 20, 21)]))                # 예약 있는 날이 하루뿐 → 가려낼 수 없음
    assert await TP.refresh() is True
    assert TP.S.combined is False


async def test_expired_token_logs_in_again_once():
    fake = _use(Fake([_b(11, "2026-11-13", 20, 21), _b(11, "2026-11-14", 7, 8)]))
    assert await TP.refresh() is True
    fake.expired.add("T1")                                    # 다음 요청 한 번은 401
    assert await TP.refresh() is True
    assert fake.logins == 2


async def test_login_failure_backs_off_and_hides_nothing_wrong(monkeypatch):
    fake = _use(Fake())
    fake.login_status = 401
    assert await TP.refresh() is False
    pub = TP.public()
    assert pub["ok"] is False and pub["state"] == "error" and pub["days"] == []
    assert TP.status()["error"] == "login"
    assert await TP.refresh() is False                        # 30분 안에는 다시 로그인하지 않는다
    assert fake.logins == 1
    monkeypatch.setattr(TP, "_now", lambda: datetime(2026, 11, 13, 14, 51))
    fake.login_status = 200
    assert await TP.refresh() is True
    assert TP.status()["error"] == "" and TP.public()["ok"] is True


async def test_failure_keeps_last_good_result_and_marks_stale(monkeypatch):
    fake = _use(Fake([_b(11, "2026-11-13", 20, 21), _b(11, "2026-11-14", 7, 8)]))
    assert await TP.refresh() is True
    fake.fail_range = 500
    monkeypatch.setattr(TP, "_now", lambda: datetime(2026, 11, 13, 15, 10))
    assert await TP.refresh() is False
    pub = TP.public()
    assert pub["ok"] is True and pub["stale"] is True         # 마지막으로 읽은 내용 + '오래됨'
    assert _day(pub, "2026-11-13")["slots"][0]["s"] == 15.0   # 지난 시간은 그 사이에도 빠진다


async def test_facility_not_found():
    _use(Fake())
    TP.settings.ttp_facility_keyword = "없는곳"
    assert await TP.refresh() is False
    st = TP.status()
    assert st["error"] == "facility" and "반포종합운동장 테니스장" in st["diag"]["facilities"]


async def test_quiet_hours_skip(monkeypatch):
    fake = _use(Fake())
    monkeypatch.setattr(TP, "_now", lambda: datetime(2026, 11, 13, 3, 0))
    assert await TP.refresh() is False and fake.calls == []


async def test_day_rolls_over_without_new_fetch(monkeypatch):
    _use(Fake([_b(11, "2026-11-13", 20, 21), _b(11, "2026-11-14", 7, 8)]))
    assert await TP.refresh() is True
    monkeypatch.setattr(TP, "_now", lambda: datetime(2026, 11, 14, 0, 5))
    pub = TP.public()
    assert pub["days"][0]["date"] == "2026-11-14"             # 어제는 빠지고
    assert pub["days"][-1]["date"] == "2026-11-20"            # 09시 전이라 새 날짜는 아직
    assert pub["next_open"] == {"date": "2026-11-21", "at": "2026-11-14 09:00"}


def test_no_personal_fields_leave_the_module():
    busy = TP.parse_busy([_b(11, "2026-11-14", 6, 7, kind="reserved",
                             profile={"name": "mine", "phone_number": "010-0000-0000"})], {"2026-11-14"})
    courts = TP.parse_courts(COURTS)
    TP.S.snapshot = {"at": NOW, "courts": courts, "busy": busy, "dates": [date(2026, 11, 14)]}
    text = json.dumps([TP.public(), TP.status()], ensure_ascii=False)
    assert "010-0000-0000" not in text and "mine" not in text and "pw-not-real" not in text
    assert "me@example.com" not in text


def test_board_route_carries_play(monkeypatch, session):
    from contextlib import contextmanager

    from app.routers import openings as R

    @contextmanager
    def fake_session():
        yield session
    monkeypatch.setattr(R, "get_session", fake_session)
    monkeypatch.setattr(TP.settings, "ttp_password", "")
    assert R.get_board()["play"] is None                      # 계정 없는 서버: 화면에 안 나옴
    monkeypatch.setattr(TP.settings, "ttp_password", "pw-not-real")
    assert R.get_board()["play"]["state"] == "loading"
    assert R.get_play_status()["configured"] is True

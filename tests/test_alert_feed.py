"""보낸 알림 기록 — 카카오톡으로만 받은 알림도 앱을 열면 '새 알림'으로 보이게 한다.

서버: 알림을 보낸 뒤 '어느 곳의 무슨 알림인지'를 적고 화면 자료(/board 의 feed)에 싣는다.
화면: 그 기록에서 이 기기가 아직 보여 주지 않은 것만 '새 알림'에 넣는다(tests/js/feed_harness.js 가짜 브라우저).
실제 카카오톡·푸시 서버에는 접속하지 않는다.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import time
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path

import pytest
from sqlmodel import select

import app.models  # noqa: F401
from app.models import AlertFeed, PushSub, Slot
from app.services import feed as FEED
from app.services import notifier as N
from app.services import webpush as WP

ROOT = Path(__file__).resolve().parents[1]


def _group(place, area, open_at, kind="d1", **more):
    return {"kind": kind, "place": place, "region": "", "areas": [area], "open_at": open_at,
            "count": 1, "reserve_url": None, "expected": False, **more}


# ── 적기 · 꺼내기 ─────────────────────────────────────────────────

def test_record_keeps_one_line_per_alert(session):
    groups = [_group("한남테니스장", "한남", "2026-11-14 09:00"),
              _group("반포종합운동장 테니스장", "반포", "2026-11-14 09:00", opt_in=True, note="11.21(토) 이용분")]
    assert FEED.record(session, FEED.open_items(groups)) == 2
    assert FEED.record(session, FEED.open_items(groups)) == 0          # 카카오톡 다음에 앱 알림이 또 보내도 한 줄
    h1 = [_group("한남테니스장", "한남", "2026-11-14 09:00", "h1")]
    assert FEED.record(session, FEED.open_items(h1)) == 1              # 1시간 전 알림은 새 알림
    rows = FEED.recent(session)
    assert [(r["area"], r["kind"], r["key"]) for r in rows] == [
        ("한남", "d1", "open|2026-11-14 09:00"), ("반포", "d1", "open|2026-11-14 09:00"),
        ("한남", "h1", "open|2026-11-14 09:00")]
    assert rows[0]["text"] == "11.14(토) 09:00 예약 오픈" and rows[0]["place"] == "한남테니스장"
    assert rows[1]["text"] == "11.14(토) 09:00 예약 오픈 · 11.21(토) 이용분" and rows[1]["areas"] == ["반포"]
    assert abs(rows[0]["at"] - time.time() * 1000) < 60_000            # 보낸 때 = 지금(UTC 밀리초)


def test_feed_items_match_the_push_items(session, monkeypatch):
    """같은 알림이 앱 알림과 기록 두 길로 와도 화면에서 한 줄로 합쳐지게, 이름·key·문구가 같다."""
    sent = []
    monkeypatch.setattr(WP, "ready", lambda: True)
    monkeypatch.setattr(WP, "_send", lambda s, row, payload, ttl=3600: sent.append(payload) or True)
    session.add(PushSub(endpoint="https://fcm.googleapis.com/a", p256dh="k", auth="a",
                        areas=json.dumps(["한남", "반포 빈 시간"], ensure_ascii=False)))
    session.commit()
    g = [_group("한남테니스장", "한남", "2026-11-14 09:00", expected=True)]
    delivered: list = []
    assert WP.send_opening_alerts(session, g, delivered=delivered) == 1
    assert delivered == g                                              # 실제로 보낸 묶음만 기록에 넘긴다
    body = "11.16(월) 14~15시 · 3번 코트"
    assert WP.send_play_free(session, "반포 빈 시간이 생겼어요", body) == 1
    pushed = sent[0]["items"] + sent[1]["items"]
    fed = FEED.open_items(g) + FEED.free_items(body)
    pick = lambda xs: [(x["area"], x["kind"], x["key"], x["text"]) for x in xs]   # noqa: E731
    assert pick(pushed) == pick(fed)
    assert FEED.free_items("") == []


def test_nothing_delivered_means_nothing_recorded(session, monkeypatch):
    """앱 알림을 받을 기기가 없는 묶음은 '보낸 알림'으로 적지 않는다."""
    monkeypatch.setattr(WP, "ready", lambda: True)
    monkeypatch.setattr(WP, "_send", lambda s, row, payload, ttl=3600: True)
    session.add(PushSub(endpoint="https://fcm.googleapis.com/a", p256dh="k", auth="a",
                        areas=json.dumps(["장충"], ensure_ascii=False)))
    session.commit()
    groups = [_group("한남테니스장", "한남", "2026-11-14 09:00"), _group("장충테니스장", "장충", "2026-11-14 10:00")]
    delivered: list = []
    assert WP.send_opening_alerts(session, groups, delivered=delivered) == 1
    assert [g["place"] for g in delivered] == ["장충테니스장"]


def test_old_lines_are_dropped(session):
    session.add(AlertFeed(area="한남", areas='["한남"]', place="한남테니스장", kind="d1", key="open|x",
                          text="옛 알림", at=FEED._now() - timedelta(hours=25)))
    session.add(AlertFeed(area="장충", areas="broken", place="장충테니스장", kind="d1", key="open|y",
                          text="어제 알림", at=FEED._now() - timedelta(hours=23)))
    session.commit()
    assert [r["text"] for r in FEED.recent(session)] == ["어제 알림"]   # 24시간 지난 것은 싣지 않는다
    assert FEED.recent(session)[0]["areas"] == ["장충"]                 # 깨진 값이어도 대표 이름으로
    FEED.record(session, FEED.free_items("11.16(월) 14~15시 · 3번 코트"))
    assert sorted(r.text for r in session.exec(select(AlertFeed))) == [
        "11.16(월) 14~15시 · 3번 코트", "어제 알림"]                    # 적을 때 옛 줄을 지운다


def test_record_never_breaks_sending(session):
    class Broken:
        def exec(self, *a, **k):
            raise RuntimeError("db down")

        def rollback(self):
            raise RuntimeError("still down")
    assert FEED.record(Broken(), FEED.free_items("본문")) == 0        # 기록이 안 돼도 예외를 밖으로 내지 않는다
    assert FEED.record(session, []) == 0
    assert FEED.record(session, [{"area": "한남", "key": "", "kind": "d1", "text": "key 없음"}]) == 0


def test_recent_is_capped(session):
    for i in range(FEED.MAX_ROWS + 5):
        session.add(AlertFeed(area="반포", areas='["반포"]', place="반포", kind="free", key=f"free|{i}",
                              text=f"빈 시간 {i}", at=FEED._now() - timedelta(minutes=FEED.MAX_ROWS + 5 - i)))
    session.commit()
    rows = FEED.recent(session)
    assert len(rows) == FEED.MAX_ROWS
    assert rows[-1]["text"] == f"빈 시간 {FEED.MAX_ROWS + 4}" and rows[0]["text"] == "빈 시간 5"   # 최근 것, 오래된 순


# ── 화면 자료(/board) · 알림을 보낸 직후 ──────────────────────────────

def test_board_route_carries_the_feed(monkeypatch, session):
    from app.routers import openings as R

    @contextmanager
    def fake_session():
        yield session
    monkeypatch.setattr(R, "get_session", fake_session)
    assert R.get_board()["feed"] == []
    FEED.record(session, FEED.open_items([_group("한남테니스장", "한남", "2026-11-14 09:00")]))
    feed = R.get_board()["feed"]
    assert [(r["area"], r["text"]) for r in feed] == [("한남", "11.14(토) 09:00 예약 오픈")]
    assert set(feed[0]) == {"area", "areas", "place", "kind", "key", "text", "at"}   # 개인정보 · 기기 정보 없음


async def test_kakao_opening_alert_is_recorded(monkeypatch, session):
    """카카오톡으로만 보낸(앱 알림 기기가 한 대도 없는) 오픈 알림도 기록에 남는다."""
    import app.scheduler as SCH
    slot = Slot(slot_hash="s1", source_id="seoul", facility_name="한남테니스장", court_name="한남테니스장",
                region="용산구", date="2026-11-14", time_start="", time_end="", is_open=False,
                status="안내중", open_at="2026-11-14 09:00")
    texts = []

    async def fake_kakao(s, groups):
        texts.append(groups)
        return ok["v"]
    ok = {"v": False}
    monkeypatch.setattr(SCH.settings, "notify_openings", True)
    monkeypatch.setattr(SCH, "in_quiet_hours", lambda: False)
    monkeypatch.setattr(SCH, "kakao_ready", lambda: True)
    monkeypatch.setattr(SCH, "send_opening_alerts", fake_kakao)
    monkeypatch.setattr(SCH.OP, "pending_alerts", lambda s, prefix="": [("d1", slot)])
    monkeypatch.setattr(SCH.WP, "ready", lambda: False)
    await SCH._check_opening_alerts(session)
    assert FEED.recent(session) == []                                  # 카카오톡 발송이 실패하면 적지 않는다
    ok["v"] = True
    await SCH._check_opening_alerts(session)
    rows = FEED.recent(session)
    assert [(r["area"], r["kind"], r["text"]) for r in rows] == [("한남", "d1", "11.14(토) 09:00 예약 오픈")]


async def test_push_only_opening_alert_is_recorded(monkeypatch, session):
    """카카오톡이 없는 서버에서도, 앱 알림으로 한 대에라도 보냈으면 기록한다."""
    import app.scheduler as SCH
    slot = Slot(slot_hash="s1", source_id="seoul", facility_name="장충테니스장", court_name="장충테니스장",
                region="중구", date="2026-11-14", time_start="", time_end="", is_open=False,
                status="안내중", open_at="2026-11-14 10:00")
    session.add(PushSub(endpoint="https://fcm.googleapis.com/a", p256dh="k", auth="a", areas='["한남"]'))
    session.commit()

    def fake_push(s, groups, badge=0, play_badge=0, delivered=None):
        if hit["v"]:
            delivered.extend(groups)
        return 1 if hit["v"] else 0
    hit = {"v": False}

    async def inline(fn, *a):                                         # 스레드 대신 바로 실행(같은 세션)
        return fn(*a)
    monkeypatch.setattr(SCH.settings, "notify_openings", True)
    monkeypatch.setattr(SCH, "in_quiet_hours", lambda: False)
    monkeypatch.setattr(SCH, "kakao_ready", lambda: False)
    monkeypatch.setattr(SCH.OP, "pending_alerts", lambda s, prefix="": [("h1", slot)])
    monkeypatch.setattr(SCH.OP, "board", lambda s: {"badge": 0})
    monkeypatch.setattr(SCH.WP, "ready", lambda: True)
    monkeypatch.setattr(SCH.WP, "send_opening_alerts", fake_push)
    monkeypatch.setattr(SCH.asyncio, "to_thread", inline)
    await SCH._check_opening_alerts(session)
    assert FEED.recent(session) == []                                  # 받을 기기가 없었으면 적지 않는다
    hit["v"] = True
    await SCH._check_opening_alerts(session)
    assert [(r["area"], r["kind"]) for r in FEED.recent(session)] == [("장충", "h1")]


# ── 카카오톡 메시지의 링크 ────────────────────────────────────────────

async def test_kakao_links_carry_the_mark(monkeypatch, session):
    """카카오톡 알림의 링크에는 k=1 이 붙는다 — 그 링크로 연 화면은 보낸 알림을 모두 보여 준다."""
    sent = []

    async def fake_send(s, text, link, buttons=None):
        sent.append((text, link))
        return True
    monkeypatch.setattr(N.settings, "dashboard_url", "https://court.example/")
    monkeypatch.setattr(N, "send_to_me", fake_send)
    assert N.alert_url() == "https://court.example/?k=1"
    assert N.alert_url("play") == "https://court.example/?k=1#play"
    await N.send_opening_alerts(session, [_group("한남테니스장", "한남", "2026-11-14 09:00", count=3)])
    await N.send_play_free(session, "반포 빈 시간이 생겼어요", "11.16(월) 14~15시 · 3번 코트")
    (t1, l1), (t2, l2) = sent
    assert l1 == "https://court.example/?k=1" and t1.endswith(l1) and "한남테니스장" in t1
    assert l2 == "https://court.example/?k=1#play" and t2.endswith(l2)
    assert len(t1) <= 200 and len(t2) <= 200
    monkeypatch.setattr(N.settings, "dashboard_url", "https://court.example/?v=2")
    assert N.alert_url() == "https://court.example/?v=2&k=1"


# ── 화면: 기록에서 아직 안 보여 준 것만 '새 알림'으로 ───────────────────

@pytest.mark.skipif(shutil.which("node") is None, reason="node 가 없으면 화면 검사는 건너뛴다")
def test_page_shows_alerts_that_only_came_by_kakaotalk():
    r = subprocess.run(["node", str(ROOT / "tests" / "js" / "feed_harness.js")],
                       capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    # 알림을 켜지 않은 기기: 5곳의 오픈 알림만(반포는 고른 기기에만)
    assert out["plain"] == {"added": True, "areas": ["한남"]}
    assert out["plainAgain"] == {"added": False, "n": 1}                 # 한 번 보여 준 것은 다시 넣지 않는다
    assert out["afterExpire"] == {"added": False, "n": 0}                # 표시가 사라진 뒤에도 다시 뜨지 않는다
    assert out["seenSaved"] is True
    # 카카오톡 알림의 링크(?k=1)로 연 브라우저: 서버가 보낸 알림 전부
    assert out["kakao"] == {"added": True, "areas": ["반포", "반포", "한남"], "kinds": ["d1", "d1", "free"],
                            "remembered": "1"}
    assert out["kakaoLater"]["showAll"] is True                          # 다음에 그냥 열어도 유지
    # 앱 알림을 켠 기기: 그 기기에서 고른 곳 · 시간만
    assert out["picked"] == {"added": True, "areas": ["반포", "장충"], "kinds": ["free", "h1"]}
    # 앱 알림으로 먼저 받은 것은 기록으로 또 뜨지 않는다
    assert out["pushFirst"] == {"added": False, "n": 1, "seen": 111}
    # 같은 오픈의 전날 알림 → 1시간 전 알림은 한 줄로 바뀐다
    assert out["hourBefore"] == {"added": True, "n": 1, "kind": "h1"}
    # 서버가 다시 켜져 같은 알림을 또 보냈으면(시각이 다름) 새 알림
    assert out["resent"] == {"added": True, "n": 1}
    assert out["old"] == {"added": False, "n": 0}                        # 24시간 지난 것
    assert out["hidden"] == {"added": False, "n": 0}                     # 화면을 안 보고 있을 때는 '보여 줬다'고 하지 않는다
    assert out["hiddenThenVisible"] == {"added": True, "n": 1}
    assert out["garbage"] == {"added": False, "n": 0}                    # 이상한 값


def test_page_reads_the_feed_on_every_load():
    page = (ROOT / "app" / "static" / "dashboard.html").read_text(encoding="utf-8")
    assert "takeFeed(d.feed)" in page and "takeFeed(board.feed)" in page
    assert "tn_seen" in page and "tn_all" in page
    assert "markSeen(x)" in page                                         # 앱 알림으로 받은 것도 '보여 줬다'고 적는다

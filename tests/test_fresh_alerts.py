"""앱 안의 '새 알림' 표시 — 알림에 '어느 곳의 무슨 알림인지'(items)를 실어 보내고,
서비스워커가 그것을 적어 두었다가 앱 아이콘 숫자(아직 안 본 알림 수)로 쓴다.

실제 푸시 서버에는 접속하지 않는다(가짜 발송 · 가짜 브라우저).
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

import app.models  # noqa: F401
from app.models import PushSub
from app.services import webpush as WP

ROOT = Path(__file__).resolve().parents[1]


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


def _group(place, area, open_at, kind="d1", **more):
    return {"kind": kind, "place": place, "region": "", "areas": [area], "open_at": open_at,
            "count": 1, "reserve_url": None, "expected": False, **more}


def test_opening_push_says_which_places(session, outbox):
    _subs(session, a=["한남", "장충"], b=["장충"])
    groups = [_group("한남테니스장", "한남", "2026-11-14 09:00"),
              _group("장충테니스장", "장충", "2026-11-14 10:00", expected=True)]
    assert WP.send_opening_alerts(session, groups, badge=2) == 2
    by = dict(outbox)
    assert [(i["area"], i["kind"], i["text"]) for i in by["a"]["items"]] == [
        ("한남", "d1", "11.14(토) 09:00 예약 오픈"),
        ("장충", "d1", "11.14(토) 10:00 예약 오픈 · 공지 일정")]
    assert [i["area"] for i in by["b"]["items"]] == ["장충"]            # 고른 곳만
    assert by["a"]["items"][0]["place"] == "한남테니스장"
    assert by["a"]["badge"] == 2                                        # 옛 서비스워커용 숫자는 그대로


def test_eve_and_hour_before_share_one_key(session, outbox):
    """같은 오픈의 전날 알림과 1시간 전 알림은 앱에서 한 줄로 합쳐지게 key 가 같다."""
    _subs(session, a=["한남"])
    WP.send_opening_alerts(session, [_group("한남테니스장", "한남", "2026-11-14 09:00", "d1")])
    WP.send_opening_alerts(session, [_group("한남테니스장", "한남", "2026-11-14 09:00", "h1")])
    d1, h1 = (p["items"][0] for _, p in outbox)
    assert d1["key"] == h1["key"] == "open|2026-11-14 09:00"
    assert (d1["kind"], h1["kind"]) == ("d1", "h1")


def test_banpo_open_item_keeps_the_note(session, outbox, monkeypatch):
    from app.services import tennisplay as TP
    monkeypatch.setattr(TP, "ready", lambda: True)
    _subs(session, a=["한남", "반포"])
    g = _group("반포종합운동장 테니스장", "반포", "2026-11-14 09:00", opt_in=True, note="11.21(토) 이용분")
    assert WP.send_opening_alerts(session, [g]) == 1
    item = outbox[0][1]["items"][0]
    assert item["area"] == "반포" and item["text"] == "11.14(토) 09:00 예약 오픈 · 11.21(토) 이용분"


def test_free_push_carries_the_new_times(session, outbox):
    _subs(session, a=["반포 빈 시간"])
    body = "11.16(월) 14~15시 · 3번 코트\n11.17(화) 14~15시 · 2번, 6번 코트"
    assert WP.send_play_free(session, "반포 빈 시간이 생겼어요", body) == 1
    items = outbox[0][1]["items"]
    assert len(items) == 1
    assert items[0]["area"] == "반포" and items[0]["kind"] == "free" and items[0]["text"] == body
    assert items[0]["key"].startswith("free|11.16(월)")


def test_long_payload_drops_items_but_keeps_the_message():
    items = [{"area": "한남", "place": "한남테니스장", "kind": "d1", "key": f"open|{i}", "text": "가" * 280}
             for i in range(8)]
    p = WP._fit({"title": "제목", "body": "본문", "url": "/", "tag": "t", "badge": 1, "items": items})
    assert p["title"] == "제목" and p["body"] == "본문"
    assert 0 < len(p["items"]) < 8
    assert len(json.dumps(p, ensure_ascii=False).encode("utf-8")) <= WP.MAX_PAYLOAD
    assert "items" not in WP._fit({"title": "t", "body": "b", "items": []})
    many = WP._fit({"title": "t", "body": "b", "items": [{"area": "a", "text": "x"}] * 20})
    assert len(many["items"]) == WP.MAX_ITEMS


def test_test_push_has_no_items(session, monkeypatch):
    """'알림이 켜졌어요' 시험 알림은 새 알림으로 세지 않는다."""
    sent = []
    monkeypatch.setattr(WP, "_send", lambda s, row, payload, ttl=3600: sent.append(payload) or True)
    monkeypatch.setattr(WP, "_TEST_AT", {})
    _subs(session, a=["한남"])
    assert WP.send_test(session, "https://fcm.googleapis.com/a")["ok"] is True
    assert "items" not in sent[0]


# ── 서비스워커: 받은 알림 적어 두기 + 아이콘 숫자 ─────────────────────

@pytest.mark.skipif(shutil.which("node") is None, reason="node 가 없으면 서비스워커 검사는 건너뛴다")
def test_service_worker_keeps_an_inbox_and_counts_unread():
    r = subprocess.run(["node", str(ROOT / "tests" / "js" / "sw_harness.js")],
                       capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out["afterD1"] == {"n": 2, "badge": 2, "posted": 1, "shown": 1}      # 두 곳 → 숫자 2, 열린 화면에 알림
    assert out["afterH1"]["n"] == 2 and out["afterH1"]["badge"] == 2            # 전날 + 1시간 전 = 한 줄
    assert "한남:h1" in out["afterH1"]["kinds"]
    assert out["afterFree"] == {"n": 3, "badge": 3}
    assert out["afterTest"]["n"] == 3 and out["afterTest"]["badgeCallsSame"]    # 시험 알림은 숫자를 건드리지 않는다
    assert out["afterTest"]["cleared"] == 0
    assert out["afterOpen"] == {"n": 1, "badge": 1}                             # 앱이 비운 뒤에는 1부터
    assert out["afterDay"] == {"n": 1, "texts": ["새 것"], "badge": 1}           # 하루 지난 것 · 이상한 항목 제거
    assert out["afterBroken"]["n"] == 1                                         # 보관함이 깨져도 다시 적는다


def test_page_clears_the_number_instead_of_setting_it():
    """화면은 앱을 열 때 아이콘 숫자를 지우기만 한다(예전처럼 숫자를 다시 올리지 않는다)."""
    page = (ROOT / "app" / "static" / "dashboard.html").read_text(encoding="utf-8")
    assert "clearAppBadge" in page and "navigator.setAppBadge(" not in page
    assert 'id="fresh"' in page and "checkInbox(true)" in page
    sw = (ROOT / "app" / "static" / "sw.js").read_text(encoding="utf-8")
    assert "tn-inbox" in sw and "/__tn_inbox" in sw and "/__tn_inbox" in page

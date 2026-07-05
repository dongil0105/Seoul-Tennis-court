"""무음시간/하루상한/보안 마스킹/quiet 파싱 경계 테스트."""
from __future__ import annotations

from datetime import datetime

from app.config import Settings
from app.http_util import _safe_url
from app.services import notifier


def _at(hour: int) -> datetime:
    return datetime(2026, 6, 20, hour, 0, 0)


def test_quiet_hours_overnight_boundary(monkeypatch):
    monkeypatch.setattr(notifier.settings, "quiet_hours", "23-06")
    assert notifier.in_quiet_hours(_at(23)) is True
    assert notifier.in_quiet_hours(_at(2)) is True
    assert notifier.in_quiet_hours(_at(5)) is True
    assert notifier.in_quiet_hours(_at(6)) is False   # 06시는 발송
    assert notifier.in_quiet_hours(_at(12)) is False


def test_quiet_hours_disabled_when_empty(monkeypatch):
    monkeypatch.setattr(notifier.settings, "quiet_hours", "")
    assert notifier.in_quiet_hours(_at(2)) is False


def test_quiet_range_accepts_hhmm():
    s = Settings(quiet_hours="23:30-06:15")
    assert s.quiet_range() == (23, 6)


def test_quiet_range_invalid_returns_none():
    s = Settings(quiet_hours="밤-아침")
    assert s.quiet_range() is None


def test_safe_url_masks_seoul_key():
    key = "SECRETKEY123"
    url = f"http://openapi.seoul.go.kr:8088/{key}/json/ListPublicReservationSport/1/1000/"
    masked = _safe_url(url)
    assert key not in masked
    assert "openapi.seoul.go.kr" in masked

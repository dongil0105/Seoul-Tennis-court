"""필터 매칭 단위테스트 — 구/요일/시간대/야간/자격·유료 제외."""
from __future__ import annotations

from app.models import Slot, UserFilter
from app.services.filters import match_filters, match_one


def _slot(region="서초구", date="2026-06-20", ts="06:00", te="08:00",
          night=False, paid=False, eligibility=None):
    # 2026-06-20 은 토요일(weekday=5)
    return Slot(
        slot_hash="h", source_id="seoul_open_api", tier=1, facility_name="양재",
        court_name="1", region=region, date=date, time_start=ts, time_end=te,
        is_open=True, is_night=night, is_paid=paid, eligibility=eligibility,
    )


def test_no_filters_passes_all():
    assert match_filters(_slot(), []) is True


def test_gu_filter():
    f = UserFilter(gus='["강남구"]')
    assert match_one(_slot(region="서초구"), f) is False
    assert match_one(_slot(region="강남구"), f) is True


def test_weekday_filter_saturday():
    f = UserFilter(weekdays="[5,6]")
    assert match_one(_slot(date="2026-06-20"), f) is True   # 토
    assert match_one(_slot(date="2026-06-22"), f) is False  # 월


def test_time_window():
    f = UserFilter(time_from="06:00", time_to="10:00")
    assert match_one(_slot(ts="06:00"), f) is True
    assert match_one(_slot(ts="14:00"), f) is False


def test_night_exclusion():
    f = UserFilter(include_night=False)
    assert match_one(_slot(night=True), f) is False
    assert match_one(_slot(night=False), f) is True


def test_exclude_paid():
    f = UserFilter(exclude_paid=True)
    assert match_one(_slot(paid=True), f) is False
    assert match_one(_slot(paid=False), f) is True


def test_exclude_restricted():
    f = UserFilter(exclude_restricted=True)
    assert match_one(_slot(eligibility="강남구민 전용"), f) is False
    assert match_one(_slot(eligibility=None), f) is True


def test_or_semantics_across_filters():
    f1 = UserFilter(gus='["강남구"]')
    f2 = UserFilter(gus='["서초구"]')
    assert match_filters(_slot(region="서초구"), [f1, f2]) is True

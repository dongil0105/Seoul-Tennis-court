"""멀티소스 오케스트레이터 테스트 — dedup 우선순위 / 소스 격리 / opt-in 게이트."""
from __future__ import annotations

import pytest

from app.collectors import registry
from app.collectors.base import SlotDTO


def _dto(src, tier, court="1코트", available=True):
    return SlotDTO(
        source_id=src, tier=tier, facility_name="양재", court_name=court,
        region="서초구", date="2026-06-20", time_start="06:00", time_end="08:00",
        is_available=available,
    )


def test_dedup_keeps_lower_tier():
    # 같은 물리적 슬롯이 tier1(공식)·tier2에 동시 등장 → tier1만 남는다.
    out = registry._dedup([_dto("gangnam", 2), _dto("seoul_open_api", 1)])
    assert len(out) == 1
    assert out[0].source_id == "seoul_open_api"


def test_dedup_distinct_slots_kept():
    out = registry._dedup([_dto("seoul_open_api", 1, court="1코트"),
                           _dto("seoul_open_api", 1, court="2코트")])
    assert len(out) == 2


def test_dedup_normalizes_whitespace_and_parens():
    # 공백/괄호 차이는 _norm으로 흡수 → 같은 슬롯으로 합쳐진다.
    a = _dto("gangnam", 2, court="1 코트")
    b = _dto("seoul_open_api", 1, court="1코트")
    out = registry._dedup([a, b])
    assert len(out) == 1
    assert out[0].source_id == "seoul_open_api"


def test_dedup_cannot_merge_different_facility_names():
    # known-limitation: 시설명 자체가 다르면 같은 물리 슬롯이라도 합쳐지지 않는다(중복 알림 가능).
    a = SlotDTO(source_id="seoul_open_api", tier=1, facility_name="양재시민의숲",
                court_name="1코트", region="서초구", date="2026-06-20",
                time_start="06:00", time_end="08:00", is_available=True)
    b = SlotDTO(source_id="seocho", tier=2, facility_name="매헌(양재)테니스장",
                court_name="1코트", region="서초구", date="2026-06-20",
                time_start="06:00", time_end="08:00", is_available=True)
    out = registry._dedup([a, b])
    assert len(out) == 2  # 현재 한계 고정


def test_enabled_collectors_default_excludes_optin(monkeypatch):
    monkeypatch.setattr(registry.settings, "enabled_sources", "")
    ids = {c.source_id for c in registry.enabled_collectors()}
    assert "seoul_open_api" in ids
    assert "gangnam" not in ids  # opt-in은 기본 비활성(무단 크롤링 방지)


def test_enabled_collectors_explicit_includes_gangnam(monkeypatch):
    monkeypatch.setattr(registry.settings, "enabled_sources", "seoul_open_api,gangnam")
    ids = {c.source_id for c in registry.enabled_collectors()}
    assert ids == {"seoul_open_api", "gangnam"}


@pytest.mark.asyncio
async def test_collect_isolates_failing_source(monkeypatch):
    class Good:
        source_id, tier = "good", 1
        async def fetch(self, filters=None):
            return [_dto("good", 1)]

    class Bad:
        source_id, tier = "bad", 1
        async def fetch(self, filters=None):
            raise RuntimeError("소스 장애")

    monkeypatch.setattr(registry, "_DEFAULT", [Good(), Bad()])
    monkeypatch.setattr(registry.settings, "enabled_sources", "")
    out = await registry.collect(tiers={1})
    # Bad가 터져도 Good 결과는 살아남는다(소스 격리).
    assert len(out) == 1
    assert out[0].source_id == "good"

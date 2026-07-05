"""강남(Tier2 opt-in) 합법성 게이트 테스트 — 파서 미검증 시 네트워크 호출 금지."""
from __future__ import annotations

import httpx
import pytest
import respx

from app.collectors import gangnam
from app.collectors.gangnam import GangnamCollector


@pytest.mark.asyncio
@respx.mock(assert_all_mocked=False)
async def test_unverified_parser_makes_no_network_call(monkeypatch):
    monkeypatch.setattr(gangnam, "_PARSER_VERIFIED", False)
    route = respx.get(url__startswith="https://life.gangnam.go.kr").mock(
        return_value=httpx.Response(200, text="<html/>")
    )
    out = await GangnamCollector().fetch()
    assert out == []
    assert route.call_count == 0  # 미검증 → 외부 GET 0회(무단 크롤링 차단)


@pytest.mark.asyncio
@respx.mock
async def test_verified_all_pages_fail_does_not_cache_empty(monkeypatch):
    monkeypatch.setattr(gangnam, "_PARSER_VERIFIED", True)
    respx.get(url__startswith="https://life.gangnam.go.kr").mock(
        return_value=httpx.Response(503)
    )
    c = GangnamCollector()
    await c.fetch()
    # 전 페이지 실패 → 빈 결과를 캐싱하지 않아 다음 주기 재시도 가능
    assert c._cache is None

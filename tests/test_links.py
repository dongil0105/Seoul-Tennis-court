"""link-only 등록기 테스트 — 멱등 시드 + 자동수집 안 함."""
from __future__ import annotations

from app.collectors.link_registry import list_links, seed_links


def test_seed_links_idempotent(session):
    n1 = seed_links(session)
    assert n1 >= 1
    n2 = seed_links(session)  # 재실행은 신규 0건
    assert n2 == 0
    links = list_links(session)
    # 사설 플랫폼은 모두 link-only(자동 빈자리 감지 대상 아님)
    assert all(lc.reserve_url.startswith("http") for lc in links)
    assert any(lc.source_id == "smaxh" for lc in links)

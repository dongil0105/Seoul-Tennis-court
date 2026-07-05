"""수집기 오케스트레이터 — 활성 collector 순회 호출 + 정규화 + cross-source 중복 제거.

- 소스 격리: 한 collector의 예외가 다른 소스 수집을 막지 않는다(try/except + 로깅).
- 중복 제거: 같은 물리적 슬롯(dedup_key)이 여러 소스에 잡히면 tier가 낮은(=공식에 가까운)
  소스 1건만 남긴다. 동률이면 source_id 사전순.
- tier 차등: fetch_tiers(tiers)로 특정 tier 집합만 수집(스케줄러가 주기를 달리 호출).
"""
from __future__ import annotations

import logging

from app.collectors.base import CollectFilters, CourtCollector, SlotDTO
from app.collectors.gangnam import GangnamCollector
from app.collectors.seoul_open_api import SeoulOpenApiCollector
from app.config import settings

logger = logging.getLogger("tennis.registry")

# 기본 활성 collector(공식 오픈API). ENABLED_SOURCES가 비면 이들만 동작.
_DEFAULT: list[CourtCollector] = [
    SeoulOpenApiCollector(),
]
# opt-in collector — 파서 미검증(자치구 HTML 등). ENABLED_SOURCES에 명시해야만 동작.
# 검증 안 된 파서로 정부 사이트를 무단 크롤링하지 않기 위한 안전장치.
_OPT_IN: list[CourtCollector] = [
    GangnamCollector(),
]


def enabled_collectors() -> list[CourtCollector]:
    """ENABLED_SOURCES(.env) 화이트리스트로 on/off.

    - 비어 있으면 기본(_DEFAULT)만 활성. opt-in 소스는 절대 자동 활성화되지 않는다.
    - 명시되면 명시된 source_id만 활성(기본 포함 여부도 명시 기준).
    """
    allow = settings.enabled_source_set()
    if not allow:
        return list(_DEFAULT)
    known = {c.source_id for c in (_DEFAULT + _OPT_IN)}
    unknown = allow - known
    if unknown:
        logger.warning("ENABLED_SOURCES에 알 수 없는 소스 무시됨: %s", ", ".join(sorted(unknown)))
    return [c for c in (_DEFAULT + _OPT_IN) if c.source_id in allow]


def _dedup(slots: list[SlotDTO]) -> list[SlotDTO]:
    """dedup_key 기준 1건만. tier 오름차순 → source_id 사전순 우선."""
    best: dict[tuple, SlotDTO] = {}
    for s in slots:
        cur = best.get(s.dedup_key)
        if cur is None or (s.tier, s.source_id) < (cur.tier, cur.source_id):
            best[s.dedup_key] = s
    return list(best.values())


async def collect(tiers: set[int] | None = None, filters: CollectFilters | None = None) -> list[SlotDTO]:
    """지정 tier(없으면 전체)의 활성 collector를 호출해 정규화·중복제거한 슬롯 반환."""
    merged: list[SlotDTO] = []
    for col in enabled_collectors():
        if tiers is not None and col.tier not in tiers:
            continue
        try:
            got = await col.fetch(filters)
            merged.extend(got)
        except Exception:  # noqa: BLE001 소스 격리 — 한 소스 실패가 전체를 막지 않음
            logger.exception("[%s] 수집 실패 — 이 소스만 건너뜀", col.source_id)
    deduped = _dedup(merged)
    if len(deduped) != len(merged):
        logger.info("cross-source 중복 %d건 제거 → %d건", len(merged) - len(deduped), len(deduped))
    return deduped

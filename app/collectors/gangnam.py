"""Tier 2 — 강남구 통합예약(life.gangnam.go.kr) 테니스장 수집기 [시범/opt-in].

───────────────────────────────────────────────────────────────────────────
robots/약관 확인 (조사 근거, docs/SOURCES.md):
- https://life.gangnam.go.kr/robots.txt → 예약 경로(/fmcs/*)를 차단하지 않음
  (User-agent:* 에 대해 Allow 우세). 따라서 '저빈도·읽기 전용' 조회는 조건부 허용.
- 대상 페이지: 통합예약 https://life.gangnam.go.kr/fmcs/54
  테니스: 봉은(/fmcs/107), 포이(/fmcs/108), 세곡 등.
- ⚠️ 비로그인 상태에서 슬롯(날짜·시간) 조회가 가능한지, 그리고 실제 HTML/JSON 구조는
  아직 '미검증'이다(조사 단계에서 SSL/로그인 등으로 끝까지 확인 못함).

안전장치:
- 이 수집기는 opt-in이다. ENABLED_SOURCES에 "gangnam"을 명시해야만 registry가 활성화한다.
  (검증 안 된 파서로 공공 사이트를 무단 크롤링하지 않기 위함.)
- 저빈도(Tier2 주기=기본 20분) + 캐시 + 매너 User-Agent.
- HTML 구조가 확정되기 전까지 _parse()는 빈 리스트를 반환한다(파이프라인 안전).
  scripts/probe_gangnam.py 로 실제 응답을 떠서 _parse를 채운 뒤 운영하라.
───────────────────────────────────────────────────────────────────────────
"""
from __future__ import annotations

import logging

import httpx

from app.clock import now as _now
from app.collectors.base import CollectFilters, SlotDTO

logger = logging.getLogger("tennis.collector.gangnam")

SOURCE_ID = "gangnam"
TIER = 2
REGION = "강남구"
BASE = "https://life.gangnam.go.kr"

# ⚠️ 합법성 이중 게이트: opt-in(ENABLED_SOURCES)만으로는 수집하지 않는다.
# 비로그인 조회 가부와 DOM 구조를 probe_gangnam.py로 '실측 확정'한 뒤에만 True로 바꾼다.
# False인 동안 fetch()는 네트워크 호출 자체를 하지 않는다(미검증 크롤링 원천 차단).
_PARSER_VERIFIED = False
# 테니스장 예약 페이지(조사 기준). TODO: probe로 비로그인 조회 가능 여부·실제 엔드포인트 확정.
TENNIS_PAGES = [
    f"{BASE}/fmcs/107",  # 봉은테니스장
    f"{BASE}/fmcs/108",  # 포이테니스장
]


class GangnamCollector:
    """Tier 2 강남구 통합예약 수집기(시범). 파서 미확정 → 기본 빈 반환."""
    source_id = SOURCE_ID
    tier = TIER

    def __init__(self) -> None:
        from app.config import settings
        self._ua = settings.crawl_user_agent
        self._cache_ttl = settings.crawl_cache_minutes
        self._cache: list[SlotDTO] | None = None
        self._cache_at = None

    def _cache_valid(self) -> bool:
        if self._cache is None or self._cache_at is None:
            return False
        age_min = (_now() - self._cache_at).total_seconds() / 60.0
        return age_min < self._cache_ttl

    async def fetch(self, filters: CollectFilters | None = None) -> list[SlotDTO]:
        # 합법성 게이트: 파서 미검증이면 네트워크 호출 자체를 하지 않는다.
        if not _PARSER_VERIFIED:
            logger.info("[gangnam] 파서 미검증 — 외부 호출 생략(probe_gangnam.py로 확정 필요)")
            return []
        if self._cache_valid():
            return list(self._cache)  # 방어적 복사 + 저빈도(캐시 유효 시 외부호출 안 함)

        slots: list[SlotDTO] = []
        any_success = False
        async with httpx.AsyncClient(
            timeout=10.0, headers={"User-Agent": self._ua}, follow_redirects=True
        ) as client:
            for url in TENNIS_PAGES:
                try:
                    resp = await client.get(url)
                    resp.raise_for_status()
                    slots.extend(self._parse(resp.text, url))
                    any_success = True
                except httpx.HTTPError as exc:
                    # 소스 격리: 실패해도 예외를 올리지 않고 이 페이지만 건너뜀.
                    logger.warning("[gangnam] %s 조회 실패: %s", url, type(exc).__name__)

        # 전 페이지 실패 시 빈 결과를 캐싱하지 않는다(데이터 공백 고착 방지). 다음 주기 재시도.
        if any_success:
            self._cache = slots
            self._cache_at = _now()
        return list(slots)

    def _parse(self, html: str, url: str) -> list[SlotDTO]:
        """HTML→SlotDTO 변환.

        TODO(probe_gangnam.py로 실제 응답 확인 후 구현):
          - 비로그인 조회 가능 여부 확인. 불가하면 이 소스는 link-only로 강등.
          - 날짜/시간/코트/예약가능 표시 selector를 실제 DOM에서 확정.
          - eligibility(구민 전용 등)·유료 여부를 페이지 안내문에서 추출.
        구조 확정 전에는 빈 리스트를 반환해 파이프라인을 안전하게 유지한다.
        """
        # 예시 스켈레톤(미사용 — selector 미확정):
        # rows = parse_dom(html)
        # return [SlotDTO(source_id=SOURCE_ID, tier=TIER, region=REGION, ...), ...]
        return []

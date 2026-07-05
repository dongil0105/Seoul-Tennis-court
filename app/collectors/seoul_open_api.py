"""Tier 1 — 서울 열린데이터광장 OA-2266 수집기(공식 오픈API).

robots/약관: 공식 오픈API이므로 인증키 기반 자유 폴링 가능(Tier 1).
응답 필드는 추측 금지 — FIELD_MAP 상수로 분리. scripts/probe_seoul.py로 실측 후 고정하라.
"""
from __future__ import annotations

import logging

from app.collectors.base import CollectFilters, SlotDTO
from app.config import settings
from app.http_util import request_with_retry

logger = logging.getLogger("tennis.collector.seoul")

SOURCE_ID = "seoul_open_api"
TIER = 1

# TODO: probe_seoul.py 결과로 실제 필드명 확정 후 고정할 것.
FIELD_MAP = {
    "svc_id": "SVCID",
    "svc_name": "SVCNM",
    "min_class": "MINCLASSNM",
    "max_class": "MAXCLASSNM",
    "area": "AREANM",
    "place": "PLACENM",
    "status_name": "SVCSTATNM",
    "status_code": "SVCSTAT",
    "url": "SVCURL",
    "use_tgt": "USETGTINFO",   # 이용대상(자격제한 텍스트 후보)
    "pay": "PAYATNM",          # 유무료(TODO: 실제 값 '유료/무료' 확인)
    "rcpt_bgn": "RCPTBGNDT",
    "rcpt_end": "RCPTENDDT",
    "v_min": "V_MIN",
    "v_max": "V_MAX",
}

# 실측(analyze_status.py) 기준 실제 상태값: 접수중 / 예약마감 / 접수종료 / 안내중 / 예약일시중지.
# '접수중'만 예약 접수가 열린 상태다. 나머지(마감·종료·중지·안내중)는 모두 제외.
# ⚠️ '접수중'은 시설 단위 '접수 기간 열림'이지 날짜별 잔여 확정이 아니다(잔여는 yeyak 상세페이지에만
#    있으나 서울시가 자동조회를 차단·경고 → 수집하지 않음). 라벨은 '접수중'으로 정직하게 표기한다.
OPEN_STATUS_NAMES = {"접수중"}
TENNIS_KEYWORDS = ("테니스", "정구")


def _build_url(start: int, end: int) -> str:
    return (
        f"{settings.seoul_api_base}/{settings.seoul_api_key}/json/"
        f"{settings.seoul_service_name}/{start}/{end}/"
    )


def _g(row: dict, key: str) -> str:
    return str(row.get(FIELD_MAP[key]) or "")


def _is_tennis(row: dict) -> bool:
    text = " ".join(_g(row, k) for k in ("min_class", "svc_name", "place"))
    return any(kw in text for kw in TENNIS_KEYWORDS)


def _is_open(row: dict) -> bool:
    return _g(row, "status_name").strip() in OPEN_STATUS_NAMES


def _is_night(row: dict) -> bool:
    digits = "".join(ch for ch in _g(row, "v_min") if ch.isdigit())
    if not digits:
        return False
    try:
        return int(digits[:2]) >= 18
    except ValueError:
        return False


def _is_paid(row: dict) -> bool:
    pay = _g(row, "pay")
    return "유료" in pay  # TODO: 실제 PAYATNM 값으로 검증


def _eligibility(row: dict) -> str | None:
    tgt = _g(row, "use_tgt").strip()
    # '제한없음'은 자격제한이 아니므로 None 처리(헛 자격표시 방지).
    if not tgt or tgt.replace(" ", "") == "제한없음":
        return None
    return tgt


def _normalize(row: dict) -> SlotDTO:
    # TODO: probe로 '슬롯 날짜·시간' 표현 확정. 우선 접수시작일 + 이용시간대로 구성.
    date = _g(row, "rcpt_bgn")[:10]
    return SlotDTO(
        source_id=SOURCE_ID,
        tier=TIER,
        facility_name=_g(row, "svc_name") or _g(row, "place"),
        court_name=_g(row, "place"),
        region=_g(row, "area") or None,
        date=date,
        time_start=_g(row, "v_min"),
        time_end=_g(row, "v_max"),
        is_available=_is_open(row),
        reserve_url=_g(row, "url") or None,
        eligibility=_eligibility(row),
        is_paid=_is_paid(row),
        is_night=_is_night(row),
        raw=row,
    )


def _extract_rows(payload: dict) -> list[dict]:
    block = payload.get(settings.seoul_service_name)
    if isinstance(block, dict) and isinstance(block.get("row"), list):
        return block["row"]
    if isinstance(payload.get("row"), list):
        return payload["row"]
    return []


class SeoulOpenApiCollector:
    """Tier 1 공식 오픈API 수집기."""
    source_id = SOURCE_ID
    tier = TIER

    async def fetch(self, filters: CollectFilters | None = None, max_rows: int = 1000) -> list[SlotDTO]:
        if not settings.seoul_api_key:
            logger.warning("SEOUL_API_KEY 미설정 — 수집 건너뜀.")
            return []
        resp = await request_with_retry("GET", _build_url(1, max_rows))
        rows = _extract_rows(resp.json())
        if not rows:
            logger.info("OA-2266 응답에 row 없음(또는 필드 매핑 불일치). probe 확인 필요.")
            return []
        slots = [_normalize(r) for r in rows if _is_tennis(r)]
        if filters and filters.regions:
            slots = [s for s in slots if (s.region or "") in filters.regions]
        logger.info("[seoul] 테니스 슬롯 %d건(전체 %d행)", len(slots), len(rows))
        return slots

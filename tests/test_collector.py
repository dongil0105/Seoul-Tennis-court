"""Collector 파서 단위테스트 — probe 없이도 FIELD_MAP 매핑 회귀를 방지.

고정 JSON fixture로 _extract_rows / _is_tennis / _is_open / _is_night / _normalize 검증.
"""
from __future__ import annotations

from app.collectors import seoul_open_api as sa
from app.config import settings


def _row(**over) -> dict:
    base = {
        "SVCID": "S123",
        "SVCNM": "양재 테니스장 대관",
        "MINCLASSNM": "테니스장",
        "MAXCLASSNM": "체육시설",
        "AREANM": "서초구",
        "PLACENM": "양재시민의숲 1코트",
        "SVCSTATNM": "접수중",
        "SVCSTAT": "RECEIPT",
        "SVCURL": "https://yeyak.seoul.go.kr/web/reservation/...",
        "V_MIN": "06:00",
        "V_MAX": "08:00",
        "RCPTBGNDT": "2026-06-20 09:00:00.0",
    }
    base.update(over)
    return base


def test_is_tennis_true_false():
    assert sa._is_tennis(_row()) is True
    assert sa._is_tennis(_row(MINCLASSNM="풋살장", SVCNM="풋살 대관", PLACENM="A구장")) is False


def test_is_open_status():
    assert sa._is_open(_row(SVCSTATNM="접수중")) is True
    assert sa._is_open(_row(SVCSTATNM="접수마감")) is False


def test_is_night_by_start_hour():
    assert sa._is_night(_row(V_MIN="19:00")) is True
    assert sa._is_night(_row(V_MIN="06:00")) is False
    assert sa._is_night(_row(V_MIN="")) is False


def test_normalize_fields():
    ns = sa._normalize(_row())
    assert ns.source_id == "seoul_open_api"
    assert ns.region == "서초구"
    assert ns.is_available is True
    assert ns.date == "2026-06-20"
    assert ns.time_start == "06:00"
    assert ns.time_label == "06:00-08:00"
    assert ns.hash  # 해시 생성 가능


def test_normalize_eligibility_and_paid():
    row = _row(USETGTINFO="강남구민 전용", PAYATNM="유료")
    ns = sa._normalize(row)
    assert ns.eligibility == "강남구민 전용"
    assert ns.is_paid is True
    none_row = _row(USETGTINFO="", PAYATNM="무료")
    ns2 = sa._normalize(none_row)
    assert ns2.eligibility is None
    assert ns2.is_paid is False


def test_extract_rows_service_block():
    payload = {settings.seoul_service_name: {"list_total_count": 2, "row": [_row(), _row()]}}
    assert len(sa._extract_rows(payload)) == 2


def test_extract_rows_top_level_and_empty():
    assert sa._extract_rows({"row": [_row()]}) == [_row()]  # 최상위 row 방어경로
    assert sa._extract_rows({"foo": "bar"}) == []

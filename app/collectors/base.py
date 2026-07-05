"""수집기 공통 인터페이스 + 표준 슬롯 DTO.

모든 소스(공공 오픈API/자치구 HTML/공단/사설/네이버)는 CourtCollector를 구현하고,
결과를 동일한 SlotDTO 스키마로 정규화해 반환한다. 새 소스는 이 인터페이스를 따르는
파일 하나만 추가하면 된다(플러그인 구조).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


def _norm(s: str) -> str:
    """이름 정규화(공백·괄호 흡수). cross-source dedup의 표기 차이를 일부 완화."""
    return "".join(ch for ch in (s or "") if not ch.isspace() and ch not in "()（）")


def identity_hash(source_id: str, facility: str, court: str, date: str, time_start: str) -> str:
    """슬롯 식별 해시 = sha256(소스|시설|코트|날짜|시작시각). 소스별 식별을 보장한다.

    cross-source 중복은 registry가 dedup_key로 사전 제거하므로, 여기서는 소스를 포함해
    per-source 스냅샷 정체성을 안정적으로 유지한다.
    """
    raw = f"{source_id}|{facility}|{court}|{date}|{time_start}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@dataclass
class SlotDTO:
    """소스 무관 표준 슬롯. 모든 collector의 공통 출력 타입."""
    source_id: str
    tier: int
    facility_name: str
    court_name: str
    region: str | None
    date: str             # YYYY-MM-DD
    time_start: str       # HH:MM
    time_end: str         # HH:MM
    is_available: bool
    reserve_url: str | None = None
    eligibility: str | None = None   # 자격제한 텍스트(예: 'OO구민 전용'). None=제한 없음
    is_paid: bool = False
    is_night: bool = False
    raw: dict = field(default_factory=dict)  # 원본(디버그용)

    @property
    def time_label(self) -> str:
        return f"{self.time_start}-{self.time_end}".strip("-")

    @property
    def hash(self) -> str:
        return identity_hash(
            self.source_id, self.facility_name, self.court_name, self.date, self.time_start
        )

    @property
    def dedup_key(self) -> tuple:
        """cross-source 중복 판정 키(소스 무관 — 같은 물리적 슬롯).

        ⚠️ known-limitation: facility/court 표기에 의존한다. 공백·괄호 차이는 _norm으로
        흡수하지만, 소스마다 이름 자체가 다르면(예: '양재시민의숲' vs '매헌(양재)테니스장')
        동일 슬롯을 합치지 못해 중복 알림이 날 수 있다. 별칭 매핑은 향후 과제(docs/SOURCES.md).
        """
        return (self.region or "", _norm(self.facility_name), _norm(self.court_name),
                self.date, self.time_start)


@dataclass
class CollectFilters:
    """수집 단계 최적화용 필터(선택). 본 필터는 수집량을 줄이기 위한 힌트이며,
    최종 사용자 조건 매칭은 services/filters.py가 담당한다."""
    regions: list[str] | None = None


@runtime_checkable
class CourtCollector(Protocol):
    """예약처 수집기 플러그인 공통 인터페이스."""
    source_id: str
    tier: int

    async def fetch(self, filters: CollectFilters | None = None) -> list[SlotDTO]:
        ...

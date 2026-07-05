"""현재 조건에 맞는 빈 슬롯 미리보기 + link-only 바로가기 목록(발송 없이 조회만)."""
from __future__ import annotations

from fastapi import APIRouter
from sqlmodel import select

from app.collectors.link_registry import list_links
from app.db import get_session
from app.models import Slot, UserFilter
from app.services.filters import match_filters

router = APIRouter()


@router.get("/preview")
def preview(limit: int = 50) -> dict:
    """현재 접수중(open)이고 필터를 통과하는 코트 목록 + 바로가기 링크.

    주의: OA-2266 리스트는 시설 단위 '접수중' 상태만 제공한다(슬롯별 날짜 없음).
    slot.date는 접수시작일이라 과거값이 많아 날짜로 거르면 유효한 코트가 사라진다.
    따라서 날짜 필터 없이 is_open 기준으로 노출한다.
    """
    with get_session() as session:
        filters = list(session.exec(select(UserFilter)).all())
        open_slots = list(session.exec(select(Slot).where(Slot.is_open.is_(True))))
        matched = [s for s in open_slots if match_filters(s, filters)][:limit]
        links = list_links(session)
        return {
            "count": len(matched),
            "slots": [
                {
                    "source": s.source_id,
                    "tier": s.tier,
                    "facility": s.facility_name,
                    "court": s.court_name,
                    "region": s.region,
                    "date": s.date,
                    "time": s.time,
                    "is_night": s.is_night,
                    "is_paid": s.is_paid,
                    "eligibility": s.eligibility,
                    "reserve_url": s.reserve_url,
                }
                for s in matched
            ],
            # Tier 4~5: 자동감지 없이 바로가기만 제공
            "link_only": [
                {
                    "source": lc.source_id,
                    "name": lc.name,
                    "region": lc.region,
                    "reserve_url": lc.reserve_url,
                    "is_paid": lc.is_paid,
                    "eligibility": lc.eligibility,
                    "note": lc.note,
                }
                for lc in links
            ],
        }

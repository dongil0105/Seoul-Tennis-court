"""Tier 4~5 link-only 등록기 — 자동 빈자리 감지를 '하지 않는' 예약처.

사설 플랫폼(스매시/베이스라인)·네이버 예약 등은 공개API/제휴가 없으면 약관상 자동수집이
위험하다. 따라서 빈자리 감지·알림 대상에서 제외하고, '예약 바로가기' 목록(link_court)에만
등록한다. 알림(notify)에는 절대 띄우지 않고 /preview·대시보드의 바로가기 섹션에만 노출.

⚠️ 이 모듈은 어떤 외부 사이트도 스크래핑하지 않는다. 사람이 등록한 정적 링크만 다룬다.
"""
from __future__ import annotations

import logging

from sqlmodel import Session, select

from app.models import LinkCourt

logger = logging.getLogger("tennis.linkreg")

# 시드 링크(사람이 큐레이션). 자동수집 없음 — 단순 바로가기.
# robots/약관: 자동수집을 하지 않으므로 해당 없음(정적 링크 보관일 뿐).
SEED_LINKS: list[dict] = [
    {
        "source_id": "smaxh",
        "name": "스매시(SMAXH) — 대관·레슨 매칭",
        "region": None,
        "reserve_url": "https://www.smaxh.com/",
        "eligibility": None,
        "is_paid": True,
        "note": "공개API 없음. 빈자리 자동감지 미지원 — 앱/웹에서 직접 확인.",
    },
    {
        "source_id": "baceline",
        "name": "베이스라인(Baceline) — 코트 예약",
        "region": None,
        "reserve_url": "https://baceline.io/",
        "eligibility": None,
        "is_paid": True,
        "note": "공개API 없음. 링크 바로가기 전용.",
    },
]


def seed_links(session: Session) -> int:
    """시드 링크를 link_court에 멱등 등록(이미 있으면 갱신). 등록 건수 반환."""
    count = 0
    for item in SEED_LINKS:
        existing = session.exec(
            select(LinkCourt).where(
                LinkCourt.source_id == item["source_id"],
                LinkCourt.reserve_url == item["reserve_url"],
            )
        ).first()
        if existing is None:
            session.add(LinkCourt(**item))
            count += 1
        else:
            # 전체 필드 갱신 — SEED_LINKS 값이 바뀌면 DB에 반영.
            existing.name = item["name"]
            existing.region = item["region"]
            existing.eligibility = item["eligibility"]
            existing.is_paid = item["is_paid"]
            existing.note = item["note"]
            session.add(existing)
    session.commit()
    if count:
        logger.info("link-only 코트 %d건 신규 등록", count)
    return count


def list_links(session: Session) -> list[LinkCourt]:
    return list(session.exec(select(LinkCourt)).all())

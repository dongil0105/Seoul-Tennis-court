"""DB 모델 — facility, slot, notified_slot, user_filter, kakao_token, send_log, link_court.

멀티소스 확장: slot에 source_id/eligibility/is_paid를 추가하고, 자동수집하지 않는
사설·네이버 코트는 link_court(바로가기 전용)로 분리 저장한다.
시간은 모두 KST naive(app.clock.now)로 저장.
"""
from __future__ import annotations

from datetime import datetime

from sqlmodel import Field, SQLModel

from app.clock import now as _now

# 슬롯 식별 해시는 collectors/base.identity_hash로 일원화(소스|시설|코트|날짜|시작시각).
from app.collectors.base import identity_hash as slot_hash  # noqa: F401  하위호환 re-export


class Facility(SQLModel, table=True):
    __tablename__ = "facility"
    id: int | None = Field(default=None, primary_key=True)
    source_id: str = Field(index=True)
    svc_id: str = Field(index=True)
    name: str
    region: str | None = Field(default=None, index=True)
    reserve_url: str | None = None
    updated_at: datetime = Field(default_factory=_now)


class Slot(SQLModel, table=True):
    __tablename__ = "slot"
    id: int | None = Field(default=None, primary_key=True)
    slot_hash: str = Field(index=True, unique=True)
    source_id: str = Field(index=True)
    tier: int = 1
    facility_name: str
    court_name: str
    region: str | None = Field(default=None, index=True)
    date: str = Field(index=True)
    time_start: str
    time_end: str
    is_open: bool = Field(index=True)
    is_night: bool = False
    eligibility: str | None = None  # 자격제한 텍스트(None=제한 없음)
    is_paid: bool = False
    was_open: bool = False  # 직전 사이클의 is_open (취소표=false→true 감지용)
    status: str = Field(default="", index=True)  # 접수중|안내중|예약마감|접수종료|예약일시중지
    open_at: str = Field(default="", index=True)  # 예약 접수 시작 'YYYY-MM-DD HH:MM'
    use_from: str = ""  # 이용(운영) 기간 시작 'YYYY-MM-DD'
    use_to: str = ""    # 이용(운영) 기간 끝
    reserve_url: str | None = None
    first_seen: datetime = Field(default_factory=_now)
    last_seen: datetime = Field(default_factory=_now)

    @property
    def time(self) -> str:
        """기존 표시/필터 호환용 'HH:MM-HH:MM' 라벨."""
        return f"{self.time_start}-{self.time_end}".strip("-")


class NotifiedSlot(SQLModel, table=True):
    __tablename__ = "notified_slot"
    id: int | None = Field(default=None, primary_key=True)
    slot_hash: str = Field(index=True, unique=True)
    notified_at: datetime = Field(default_factory=_now)
    reopen_count: int = 0


class UserFilter(SQLModel, table=True):
    __tablename__ = "user_filter"
    id: int | None = Field(default=None, primary_key=True)
    name: str = "default"
    gus: str = "[]"        # JSON 배열 문자열 (빈 배열=전체)
    weekdays: str = "[]"   # JSON 배열 문자열 월=0…일=6 (빈 배열=전체)
    time_from: str | None = None  # "06:00"
    time_to: str | None = None    # "10:00"
    include_night: bool = True
    exclude_paid: bool = False        # true면 유료 슬롯 제외
    exclude_restricted: bool = False  # true면 자격제한(eligibility 있음) 슬롯 제외
    enabled: bool = True


class KakaoToken(SQLModel, table=True):
    __tablename__ = "kakao_token"
    id: int | None = Field(default=None, primary_key=True)  # 단일 행 id=1
    access_token: str = ""
    refresh_token: str = ""
    access_expires_at: datetime | None = None
    updated_at: datetime = Field(default_factory=_now)


class SendLog(SQLModel, table=True):
    """하루 발송 총량 상한(DAILY_SEND_LIMIT) 계산용 발송 로그."""
    __tablename__ = "send_log"
    id: int | None = Field(default=None, primary_key=True)
    sent_at: datetime = Field(default_factory=_now, index=True)
    slot_count: int = 0


class OpeningAlert(SQLModel, table=True):
    """예약 오픈 D-1/당일 카카오 알림 발송 기록(같은 오픈 건 중복 발송 방지)."""
    __tablename__ = "opening_alert"
    id: int | None = Field(default=None, primary_key=True)
    slot_hash: str = Field(index=True)
    open_date: str = ""   # 알림 대상 오픈 날짜 YYYY-MM-DD
    kind: str = ""        # 'd1'(하루 전) | 'd0'(당일)
    sent_at: datetime = Field(default_factory=_now)


class LinkCourt(SQLModel, table=True):
    """link-only 예약처(Tier 4~5, 자동 빈자리 감지 안 함). 대시보드 '바로가기'에만 노출."""
    __tablename__ = "link_court"
    id: int | None = Field(default=None, primary_key=True)
    source_id: str = Field(index=True)
    name: str
    region: str | None = Field(default=None, index=True)
    reserve_url: str
    eligibility: str | None = None
    is_paid: bool = True
    note: str | None = None
    updated_at: datetime = Field(default_factory=_now)

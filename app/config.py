"""환경설정 로드 — .env를 pydantic-settings로 읽어 타입 안전하게 노출."""
from __future__ import annotations

import logging

from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("tennis.config")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # 서울 오픈API
    seoul_api_key: str = ""
    seoul_api_base: str = "http://openapi.seoul.go.kr:8088"
    seoul_service_name: str = "ListPublicReservationSport"

    # 카카오
    kakao_rest_key: str = ""
    kakao_refresh_token: str = ""
    kakao_access_token: str = ""

    # 앱 알림(웹 푸시) — 비우면 SEOUL_API_KEY 에서 키를 만든다
    vapid_private_key: str = ""

    # 동작
    poll_interval_minutes: int = 7        # Tier 1(공식 오픈API) 주기
    tier2_interval_minutes: int = 20      # Tier 2~3(HTML 저빈도) 주기
    batch_max: int = 10
    allow_reopen_alert: bool = False
    quiet_hours: str = "23-06"
    daily_send_limit: int = 50

    # 알림 시점: 서버 시작 시 1회 요약 발송 / 주기 폴링마다 발송 여부
    notify_on_startup: bool = True
    notify_on_poll: bool = False
    dashboard_url: str = "http://localhost:8000/"

    # ── 관심 코트 스크리닝(2026-10-31 개편의 핵심) ──
    # 지역(구) 또는 이름 키워드로 '내 코트'만 추려서 오픈 일정·알림을 만든다.
    watch_regions: str = ""
    watch_keywords: str = "한남테니스장,장충테니스장,마루공원,선우공원,서울숲"
    # 예약 오픈 D-1/당일 카카오 알림(매일 09:00, 카카오 키가 설정된 곳에서만 발송)
    notify_openings: bool = True

    # 공개 배포(클라우드) 시 true — 쓰기 엔드포인트(/filters 생성·삭제)를 차단해 읽기 전용화.
    public_readonly: bool = False

    # 멀티소스 on/off (CSV, 비우면 전체 활성). 예: "seoul_open_api,gangnam"
    enabled_sources: str = ""

    # Tier 2~3 준법 크롤링용 매너 설정
    crawl_user_agent: str = "SeoulTennisAlert/1.0 (personal use; contact: dongil0105@gmail.com)"
    crawl_cache_minutes: int = 10

    # 테니스플레이(반포종합운동장) 빈 시간 — 계정을 넣은 서버에서만 읽는다(비우면 꺼짐). 조회 전용.
    ttp_email: str = ""
    ttp_password: str = ""
    ttp_facility_keyword: str = "반포"
    ttp_place: str = "반포종합운동장 테니스장"
    ttp_interval_minutes: int = 10
    ttp_api_base: str = "https://play-tennis-production.herokuapp.com/api/v1"
    ttp_booking_url: str = "https://www.thetennisplay.com/schedule-booking"
    # 반포 알림: 예약 오픈 예고(전날 20시 · 1시간 전) / 빈 시간이 새로 생기면 / 하루 빈 시간 알림 상한
    ttp_notify_open: bool = True
    ttp_notify_free: bool = True
    ttp_free_daily_max: int = 40

    # 저장소
    db_url: str = "sqlite:///./data/app.db"

    def enabled_source_set(self) -> set[str]:
        return {s.strip() for s in self.enabled_sources.split(",") if s.strip()}

    def watch_region_set(self) -> set[str]:
        return {s.strip() for s in self.watch_regions.split(",") if s.strip()}

    def watch_keyword_list(self) -> list[str]:
        return [s.strip() for s in self.watch_keywords.split(",") if s.strip()]

    def quiet_range(self) -> tuple[int, int] | None:
        """무음 시간대를 (start_hour, end_hour)로 파싱. 비었거나 형식오류면 None.

        지원 형식: "23-06"(시 단위) 또는 "23:30-06:00"(분은 절삭, 시만 사용).
        형식 오류 시 조용히 무시하지 않고 경고를 남긴다(silent 무음 비활성 방지).
        """
        raw = (self.quiet_hours or "").strip()
        if not raw or "-" not in raw:
            return None
        try:
            start_s, end_s = raw.split("-", 1)
            start = int(start_s.split(":", 1)[0])
            end = int(end_s.split(":", 1)[0])
            if not (0 <= start <= 23 and 0 <= end <= 23):
                raise ValueError("hour out of range")
            return start, end
        except ValueError:
            logger.warning("QUIET_HOURS 형식 오류: %r — 무음 비활성(항상 발송)", self.quiet_hours)
            return None


settings = Settings()

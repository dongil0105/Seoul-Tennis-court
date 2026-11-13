"""APScheduler 주기 폴링 — tier별 차등 주기.

- Tier 1(공식 오픈API): poll_interval_minutes(기본 7분)
- Tier 2~3(HTML 저빈도): tier2_interval_minutes(기본 20분)
견고성: 잡 1회 실패 격리(try/except), max_instances=1, coalesce=True로 겹침 방지.
"""
from __future__ import annotations

import asyncio
import logging
import os

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlmodel import select

from app.clock import KST
from app.collectors.registry import collect
from app.config import settings
from app.db import get_session
from app.models import Slot, UserFilter
from app.services import openings as OP
from app.services import sync as SYNC
from app.services import tennisplay as PLAY
from app.services import webpush as WP
from app.services.diff import upsert_and_extract_new
from app.services.filters import match_filters
from app.services.notifier import (
    in_quiet_hours,
    kakao_ready,
    notify_slots,
    send_opening_alerts,
    send_play_free,
    send_startup_digest,
)

logger = logging.getLogger("tennis.scheduler")


async def _check_opening_alerts(session) -> None:
    """예약 오픈 알람(전날 d1 · 1시간 전 h1) — 매 폴링마다 판정, 중복은 기록으로 1회만.

    h1(1시간 전)은 시간이 급해 무음시간에도 보낸다. d1은 무음시간이 끝난 뒤 발송.
    카카오 키가 없는 서버(공개 클라우드 기본)는 판정만 하고 발송하지 않는다.
    """
    if not settings.notify_openings:
        return
    quiet = in_quiet_hours()
    if kakao_ready():
        due = OP.pending_alerts(session)
        if quiet:
            due = [(k, s) for k, s in due if k == "h1"]
        if due:
            groups = OP.group_for_message(due)
            if await send_opening_alerts(session, groups):
                OP.mark_alerted(session, due)
                logger.info("오픈 알람(카톡) %d건 (%s)", len(due), sorted({k for k, _ in due}))
    # 앱 알림(웹 푸시) — 구독한 친구들에게, 각자 고른 지역·시점만. 채널별로 따로 1회.
    if WP.ready() and WP.count(session):
        due = OP.pending_alerts(session, prefix="p")
        if quiet:
            due = [(k, s) for k, s in due if k == "h1"]
        if due:
            badge = OP.board(session)["badge"]   # 화면 배지와 같은 기준
            # 기기별 전송은 동기(최대 10초씩)라 이벤트 루프를 막지 않게 스레드에서.
            n = await asyncio.to_thread(WP.send_opening_alerts, None,
                                        OP.group_for_message(due), badge, PLAY.open_badge())
            if n:
                logger.info("오픈 알람(앱) 후보 %d건 → 기기 %d대", len(due), n)


async def startup_alert() -> None:
    """서버 시작 시: 대시보드용 DB를 항상 채우고, 알림이 켜져 있으면 카톡 요약 1건 발송.

    DB 채우기와 카톡 발송을 분리 — 클라우드(친구용, 카톡 없음)에서도 대시보드가 즉시 뜬다.
    """
    try:
        async with SYNC._LOCK:
            raw = await collect(tiers={1})
            with get_session() as session:
                upsert_and_extract_new(session, raw)  # 대시보드(/preview)용 DB 갱신 — 항상
                session.commit()
            if raw:
                SYNC.mark()
        with get_session() as session:
            if settings.notify_on_startup:  # 카톡 요약은 옵션(개인 PC에서만 켬)
                opens = list(session.exec(select(Slot).where(Slot.is_open.is_(True))))
                filters = list(session.exec(select(UserFilter)).all())
                matched = [s for s in opens if match_filters(s, filters)
                           and OP.is_watched(s.region, s.facility_name, s.court_name)]  # 5곳만
                await send_startup_digest(session, matched)
            await _check_opening_alerts(session)  # 시작 직후에도 오픈 알람 판정
    except Exception:  # noqa: BLE001  시작 처리 실패가 서버 기동을 막지 않게
        logger.exception("시작 처리 실패 — 무시하고 기동 계속")


async def _run_pipeline(tiers: set[int]) -> None:
    """수집(지정 tier) → diff → 필터 → 발송. 어떤 예외도 밖으로 던지지 않는다.

    tier1 은 수집·DB 반영 구간만 앱 새로 고침(POST /refresh)과 같은 잠금을 잡는다
    (알림 발송까지 잡으면 새로 고침이 오래 기다린다).
    """
    locked = False
    try:
        if 1 in tiers:
            await SYNC._LOCK.acquire()
            locked = True
        raw = await collect(tiers=tiers)
        if not raw:
            return
        with get_session() as session:
            candidates = upsert_and_extract_new(
                session, raw, allow_reopen=settings.allow_reopen_alert
            )
            session.commit()
            if locked:
                SYNC.mark()
                SYNC._LOCK.release()
                locked = False
            if 1 in tiers:  # 오픈 알람(전날/1시간 전)은 공식 데이터 갱신 직후마다 판정
                await _check_opening_alerts(session)
            if not candidates:
                logger.info("tier%s: 새 빈 슬롯 없음", sorted(tiers))
                return
            filters = list(session.exec(select(UserFilter)).all())
            matched = [s for s in candidates if match_filters(s, filters)
                       and OP.is_watched(s.region, s.facility_name, s.court_name)]
            logger.info("tier%s: 후보 %d → 필터통과 %d", sorted(tiers), len(candidates), len(matched))
            # 폴링마다 발송은 옵션(기본 off). 기본은 시작 시 1회만 알림.
            if settings.notify_on_poll and matched:
                await notify_slots(session, matched)
    except Exception:  # noqa: BLE001  잡 격리 — 스케줄러 생존 우선
        logger.exception("tier%s 파이프라인 실패 — 이번 주기 스킵", sorted(tiers))
    finally:
        if locked:
            SYNC._LOCK.release()


async def poll_tier1() -> None:
    await _run_pipeline({1})


async def poll_tier23() -> None:
    await _run_pipeline({2, 3})


async def _notify_play_free() -> None:
    """반포에 빈 시간이 새로 생기면 알린다 — 카카오(서버 주인)와, 그 알림을 켠 기기의 앱 알림.

    무음 시간에는 보내지 않고 모아 두었다가, 끝난 뒤에도 비어 있는 것만 알린다.
    """
    if not settings.ttp_notify_free:
        PLAY.take_new_free()
        return
    if in_quiet_hours():
        return
    items = PLAY.take_new_free()
    if not items or not PLAY.free_budget():
        return
    title, body = PLAY.free_message(items)
    with get_session() as session:
        if kakao_ready():
            await send_play_free(session, title, body)
        if WP.ready() and WP.count(session):
            badge = OP.board(session)["badge"]
            n = await asyncio.to_thread(WP.send_play_free, None, title, body, badge, PLAY.open_badge())
            logger.info("반포 빈 시간 알림 %d칸 → 기기 %d대", len(items), n)


async def poll_play() -> None:
    """테니스플레이(반포종합운동장) 빈 시간 — 계정이 설정된 서버에서만. 실패는 안에서 처리한다."""
    await PLAY.refresh()
    try:
        await _notify_play_free()
    except Exception:  # noqa: BLE001  알림 실패가 다음 조회를 막지 않게
        logger.exception("반포 빈 시간 알림 실패 — 이번 것은 건너뜀")


async def self_ping() -> None:
    """Render 무료 플랜은 15분 동안 들어오는 접속이 없으면 잠든다. 깨어 있는 동안 10분마다
    공개 주소로 자기 /health 를 불러 잠들지 않게 한다(GitHub Actions 핑의 보조)."""
    url = os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")
    if not url:
        return
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            await client.get(f"{url}/health")
    except Exception as e:  # noqa: BLE001
        logger.warning("자기 핑 실패: %s", e)


def start_scheduler() -> AsyncIOScheduler:
    # 고정 오프셋 KST — 외부 tz 데이터베이스 없이 Windows/Docker 동일 동작.
    scheduler = AsyncIOScheduler(timezone=KST)
    scheduler.add_job(
        poll_tier1, trigger="interval", minutes=settings.poll_interval_minutes,
        id="poll_tier1", max_instances=1, coalesce=True,
    )
    scheduler.add_job(
        poll_tier23, trigger="interval", minutes=settings.tier2_interval_minutes,
        id="poll_tier23", max_instances=1, coalesce=True,
    )
    if PLAY.ready():
        from datetime import datetime, timedelta
        # 시작 직후 한 번(서버 기동을 막지 않게 예약으로), 그 뒤 주기마다
        scheduler.add_job(poll_play, trigger="interval", minutes=max(settings.ttp_interval_minutes, 5),
                          id="poll_play", max_instances=1, coalesce=True,
                          next_run_time=datetime.now(KST) + timedelta(seconds=5))
        # 매일 09:00 에 7일 뒤 날짜가 새로 열린다 — 그 직후 한 번 더
        scheduler.add_job(poll_play, trigger="cron", hour=PLAY.OPEN_HOUR, minute=0, second=20,
                          id="poll_play_open", max_instances=1, coalesce=True)
    if os.environ.get("RENDER_EXTERNAL_URL"):
        scheduler.add_job(self_ping, trigger="interval", minutes=10, id="self_ping",
                          max_instances=1, coalesce=True)
    scheduler.start()
    logger.info(
        "스케줄러 시작 — tier1 %d분 / tier2~3 %d분",
        settings.poll_interval_minutes, settings.tier2_interval_minutes,
    )
    return scheduler

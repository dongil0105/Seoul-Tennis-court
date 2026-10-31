"""FastAPI 엔트리 — lifespan에서 DB 초기화 + 스케줄러 시작."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.collectors.link_registry import seed_links
from app.db import get_session, init_db
from app.routers import dashboard, filters, health, openings, preview, push
from app.scheduler import start_scheduler, startup_alert

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    with get_session() as session:
        seed_links(session)  # Tier 4~5 바로가기 시드 등록(멱등)
    scheduler = start_scheduler()
    await startup_alert()  # 서버 시작 시 1회 요약 알림(+대시보드 DB 채우기)
    app.state.scheduler = scheduler
    try:
        yield
    finally:
        scheduler.shutdown(wait=False)


app = FastAPI(title="서울 테니스 코트 오픈 알림", version="3.0.0", lifespan=lifespan)
app.include_router(dashboard.router)
app.include_router(health.router)
app.include_router(openings.router)
app.include_router(preview.router)
app.include_router(filters.router)
app.include_router(push.router)
app.mount("/static", StaticFiles(directory=Path(__file__).resolve().parent / "static"), name="static")

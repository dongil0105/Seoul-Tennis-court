"""앱 알림(웹 푸시) 구독 API + PWA 파일(/sw.js, /manifest.webmanifest)."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from app.db import get_session
from app.services import webpush as WP

router = APIRouter()
STATIC = Path(__file__).resolve().parent.parent / "static"


class SubIn(BaseModel):
    subscription: dict
    areas: list[str] | None = None
    d1: bool = True
    h1: bool = True


class EndpointIn(BaseModel):
    endpoint: str


@router.get("/push/key")
def push_key() -> dict:
    key = WP.public_key()
    if not key:
        raise HTTPException(status_code=503, detail="알림 키가 설정되지 않았어요.")
    return {"publicKey": key}


@router.post("/push/subscribe")
def push_subscribe(body: SubIn, request: Request) -> dict:
    with get_session() as session:
        res = WP.subscribe(session, body.subscription, body.areas, body.d1, body.h1,
                           ua=request.headers.get("user-agent", ""))
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error"))
    return res


@router.post("/push/unsubscribe")
def push_unsubscribe(body: EndpointIn) -> dict:
    with get_session() as session:
        return WP.unsubscribe(session, body.endpoint)


@router.post("/push/test")
def push_test(body: EndpointIn) -> dict:
    with get_session() as session:
        res = WP.send_test(session, body.endpoint)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error"))
    return res


@router.get("/sw.js", include_in_schema=False)
def service_worker() -> FileResponse:
    # 루트 경로에서 서빙해야 서비스워커 범위가 '/' 전체가 된다.
    return FileResponse(STATIC / "sw.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


@router.get("/manifest.webmanifest", include_in_schema=False)
def manifest() -> JSONResponse:
    return JSONResponse({
        "name": "코트 오픈 — 서울 테니스장 예약 알림",
        "short_name": "코트 오픈",
        "description": "서초·강남·성동·용산·한남·장충 공공 테니스장 예약 오픈 알림과 날짜별 코트 찾기",
        "lang": "ko",
        "start_url": "/?source=pwa",
        "scope": "/",
        "display": "standalone",
        "background_color": "#0B1F17",
        "theme_color": "#0B1F17",
        "icons": [
            {"src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "/static/icon-maskable-512.png", "sizes": "512x512", "type": "image/png",
             "purpose": "maskable"},
        ],
    }, media_type="application/manifest+json")

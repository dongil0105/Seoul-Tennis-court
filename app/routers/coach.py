"""스윙 코치(/coach) — 테니스 스윙 영상 분석 화면.

분석은 모두 휴대폰 브라우저 안에서 돈다(자세 인식 wasm + 순수 JS). 서버는 화면 파일만 내려 준다.
영상은 서버로 오지 않는다. 화면 파일은 app/static/coach/ 아래에 있다.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse, JSONResponse

router = APIRouter()

_DIR = Path(__file__).resolve().parent.parent / "static" / "coach"

# 콘텐츠 보안 정책: 이 화면이 연결할 수 있는 곳은 우리 서버뿐이고, 밖에서 가져오는 것은 위키미디어의 선수 사진뿐이다.
# (자세 인식 엔진에 들어 있는 사용 통계 전송도 connect-src 에서 막힌다. 영상은 blob: 으로만 다룬다.)
CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https://upload.wikimedia.org https://thumb.wikimedia.org",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])


@router.get("/coach", response_class=HTMLResponse)
@router.get("/coach/", response_class=HTMLResponse, include_in_schema=False)
def coach() -> HTMLResponse:
    try:
        html = (_DIR / "index.html").read_text(encoding="utf-8")
    except OSError:
        return HTMLResponse(
            "<!doctype html><meta charset='utf-8'><p style='font-family:sans-serif;padding:40px'>"
            "스윙 코치 화면 파일(app/static/coach/index.html)이 없습니다. 배포 구성을 확인하세요.</p>",
            status_code=503,
        )
    # 화면 파일은 자주 바뀌니 매번 확인하게 한다(큰 파일은 /static 에서 따로 캐시)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache", "Content-Security-Policy": CSP,
                                       "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"})


@router.get("/coach/manifest.webmanifest", include_in_schema=False)
def coach_manifest() -> JSONResponse:
    return JSONResponse({
        "name": "스윙 코치",
        "short_name": "스윙 코치",
        "description": "테니스 스윙 영상을 넣으면 선수 자세와 나란히 보고 고칠 점을 알려 줍니다.",
        "lang": "ko",
        "id": "/coach",
        "start_url": "/coach",
        "scope": "/",            # 코트 오픈(/)으로 넘어가도 앱 안에서 열리게 범위를 사이트 전체로
        "display": "standalone",
        "orientation": "portrait",
        "background_color": "#0B1210",
        "theme_color": "#0B1210",
        "icons": [
            {"src": "/static/coach/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/static/coach/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
        ],
        "shortcuts": [
            {"name": "코트 오픈", "short_name": "코트 오픈", "description": "테니스장 예약 오픈 일정과 빈 코트", "url": "/",
             "icons": [{"src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png"}]},
        ],
    }, media_type="application/manifest+json")


def cache_header_for(path: str) -> str | None:
    """정적 파일 캐시 정책. 자세 인식 엔진·모델(수십 MB)은 버전이 바뀌지 않는 한 그대로라 오래 보관한다."""
    if path.startswith("/static/coach/vendor/"):
        return "public, max-age=2592000, immutable"
    if path.startswith("/static/coach/data/"):
        return "public, max-age=3600"
    if path.startswith("/static/coach/"):
        return "no-cache"
    return None

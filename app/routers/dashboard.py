"""대시보드(/) — app/static/dashboard.html 서빙.

화면은 Codex와 협업해 만든 단일 HTML(PWA)이며, /openings·/available·/preview API를 호출한다.
파일로 분리해 디자인 수정 시 파이썬 코드를 건드리지 않는다.

스윙 코치가 비공개일 때(settings.coach_private)는 열쇠가 없는 기기에 아래 탭(코트 오픈 | 스윙 코치)을 내보내지 않는다.
"""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from app.routers import coach

router = APIRouter()

_FILE = Path(__file__).resolve().parent.parent / "static" / "dashboard.html"

_TABS = re.compile(r'<nav class="tabs"[^>]*>.*?</nav>\s*', re.S)
# 탭 줄이 없으면 그 자리만큼 띄워 둔 아래 여백도 없앤다
_NO_TABS_STYLE = "<style>.app{padding-bottom:0}</style>\n"


def without_coach(html: str) -> str:
    """스윙 코치로 가는 길(아래 탭)을 뺀 화면. 탭은 두 화면을 오가는 용도뿐이라 통째로 뺀다."""
    html, n = _TABS.subn("", html, count=1)
    return html.replace("</head>", _NO_TABS_STYLE + "</head>", 1) if n else html


@router.get("/", response_class=HTMLResponse)
def dashboard(request: Request) -> HTMLResponse:
    try:
        html = _FILE.read_text(encoding="utf-8")
    except OSError:
        return HTMLResponse(
            "<!doctype html><meta charset='utf-8'>"
            "<p style='font-family:sans-serif;padding:40px'>화면 파일(dashboard.html)이 없습니다. "
            "배포 구성을 확인하세요. 데이터 API는 /openings 에서 동작 중입니다.</p>"
        )
    if not coach.allowed(request):
        html = without_coach(html)
    # 기기마다(열쇠가 있고 없고에 따라) 화면이 달라지므로 중간에서 보관하지 않게 한다
    return HTMLResponse(html, headers={"Cache-Control": "private, no-cache"})

"""대시보드(/) — app/static/dashboard.html 서빙.

화면은 Codex와 협업해 만든 단일 HTML(PWA)이며, /openings·/available·/preview API를 호출한다.
파일로 분리해 디자인 수정 시 파이썬 코드를 건드리지 않는다.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter()

_FILE = Path(__file__).resolve().parent.parent / "static" / "dashboard.html"


@router.get("/", response_class=HTMLResponse)
def dashboard() -> str:
    try:
        return _FILE.read_text(encoding="utf-8")
    except OSError:
        return (
            "<!doctype html><meta charset='utf-8'>"
            "<p style='font-family:sans-serif;padding:40px'>화면 파일(dashboard.html)이 없습니다. "
            "배포 구성을 확인하세요. 데이터 API는 /openings 에서 동작 중입니다.</p>"
        )

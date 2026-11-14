"""스윙 코치(/coach) 화면 경로·파일 구성 테스트. 서버는 화면 파일만 내려 준다(영상은 서버로 오지 않는다)."""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient

from app.routers import coach

STATIC = Path(coach.__file__).resolve().parent.parent / "static"


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(coach.router)
    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return TestClient(app)


def test_coach_page_served():
    r = _client().get("/coach")
    assert r.status_code == 200
    assert "스윙 코치" in r.text
    assert 'type="file"' in r.text and 'accept="video/*"' in r.text      # 휴대폰 갤러리에서 영상 고르기
    assert "capture=" not in r.text                                       # capture 를 붙이면 갤러리 대신 카메라만 뜬다
    assert r.headers["cache-control"] == "no-cache"


def test_manifest_scope():
    m = _client().get("/coach/manifest.webmanifest").json()
    assert m["start_url"] == "/coach" and m["scope"] == "/coach"
    for icon in m["icons"]:
        assert (STATIC / icon["src"].removeprefix("/static/")).is_file()


def test_assets_exist_and_referenced():
    html = (STATIC / "coach" / "index.html").read_text(encoding="utf-8")
    for rel in ("coach/coach.css", "coach/js/app.js", "coach/js/pose.js", "coach/js/swing.js", "coach/js/metrics.js",
                "coach/js/advice.js", "coach/js/physics.js", "coach/js/clean.js", "coach/js/track.js", "coach/js/draw.js", "coach/js/geom.js",
                "coach/vendor/tasks-vision/vision_bundle.mjs", "coach/vendor/tasks-vision/wasm/vision_wasm_internal.wasm",
                "coach/vendor/models/pose_landmarker_full.task", "coach/vendor/models/pose_landmarker_lite.task"):
        assert (STATIC / rel).is_file(), rel
    assert "/static/coach/js/app.js" in html and "/static/coach/coach.css" in html
    c = _client()
    assert c.get("/static/coach/js/geom.js").status_code == 200
    assert c.get("/static/coach/vendor/tasks-vision/VERSION").status_code == 200


def test_reference_data_shape():
    """기준 자세 데이터: 대조군 표본마다 출처(페이지·라이선스)가 있어야 한다."""
    path = STATIC / "coach" / "data" / "reference.json"
    assert path.is_file()
    ref = json.loads(path.read_text(encoding="utf-8"))
    assert set(ref["stats"]) >= {"serve", "forehand", "backhand"}
    assert ref["samples"], "대조군 표본이 비어 있다"
    for s in ref["samples"]:
        assert s["stroke"] in ("serve", "forehand", "backhand") and s["phase"]
        assert s["page"].startswith("https://commons.wikimedia.org/wiki/File")
        assert s["license"], s["title"]
        assert len(s["w"]) == 33 and len(s["lm"]) == 33 and len(s["feat"]) == 36


def test_cache_policy():
    assert "immutable" in coach.cache_header_for("/static/coach/vendor/models/pose_landmarker_full.task")
    assert coach.cache_header_for("/static/coach/js/app.js") == "no-cache"
    assert coach.cache_header_for("/static/dashboard.html") is None


def test_main_app_serves_coach_with_cache_headers():
    """실제 앱(app.main)에서: /coach 가 뜨고, 큰 파일에는 오래 보관 머리말이 붙고, 기존 화면(/)은 그대로다."""
    from app.main import app as main_app

    c = TestClient(main_app)          # lifespan(스케줄러·외부 호출)은 돌리지 않는다
    assert c.get("/coach").status_code == 200
    r = c.get("/static/coach/vendor/tasks-vision/VERSION")
    assert r.status_code == 200 and "immutable" in r.headers["cache-control"]
    assert c.get("/static/coach/js/geom.js").headers["cache-control"] == "no-cache"
    # 큰 파일은 압축해서 보낸다(받는 쪽이 gzip 을 받겠다고 했을 때)
    wasm = c.get("/static/coach/vendor/tasks-vision/wasm/vision_wasm_internal.js", headers={"Accept-Encoding": "gzip"})
    assert wasm.status_code == 200 and wasm.headers.get("content-encoding") == "gzip" and "immutable" in wasm.headers["cache-control"]
    home = c.get("/")
    assert home.status_code == 200 and "코트 오픈" in home.text
    icon = c.get("/static/icon-192.png")                              # 기존 화면의 정적 파일은 그대로
    assert icon.status_code == 200 and "content-encoding" not in icon.headers
    assert "cache-control" not in {k.lower() for k in c.get("/static/sw.js").headers} or "immutable" not in c.get("/static/sw.js").headers["cache-control"]


def test_coach_page_blocks_outside_connections():
    """/coach 는 우리 서버 말고는 연결하지 못하고(자세 인식 엔진의 사용 통계 전송도 막힌다), 밖에서 가져오는 것은 위키미디어 사진뿐이다."""
    r = _client().get("/coach")
    csp = r.headers["content-security-policy"]
    rules = {part.strip().split(" ")[0]: part.strip().split(" ")[1:] for part in csp.split(";")}
    assert rules["connect-src"] == ["'self'"]
    assert rules["default-src"] == ["'self'"]
    assert "'unsafe-inline'" not in rules["script-src"] and "'unsafe-eval'" not in rules["script-src"]
    outside = {src for part in rules.values() for src in part if src.startswith("http")}
    assert outside == {"https://upload.wikimedia.org", "https://thumb.wikimedia.org"}
    # 화면 파일도 바깥 주소(글꼴·스크립트)를 부르지 않는다
    html = r.text
    assert "cdn.jsdelivr.net" not in html and "googleapis" not in html
    assert "onload=" not in html and "onclick=" not in html           # 인라인 스크립트는 정책에서 막힌다

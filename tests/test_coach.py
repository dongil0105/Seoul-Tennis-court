"""스윙 코치(/coach) 화면 경로·파일 구성·공개 범위 테스트. 서버는 화면 파일만 내려 준다(영상은 서버로 오지 않는다)."""
from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings, settings
from app.routers import coach

STATIC = Path(coach.__file__).resolve().parent.parent / "static"

KEY = "TEST2-KEY34-ABCDE-FGH56"          # 테스트용 열쇠(실제 열쇠가 아니다)
KEY_HASH = hashlib.sha256(coach.normalize_key(KEY).encode()).hexdigest()


@pytest.fixture(autouse=True)
def _private_with_test_key(monkeypatch):
    """모든 테스트는 '비공개 + 테스트용 열쇠'에서 시작한다. 공개 상태를 보는 테스트만 따로 바꾼다."""
    monkeypatch.setattr(settings, "coach_private", True)
    monkeypatch.setattr(settings, "coach_key_sha256", KEY_HASH)


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(coach.router)
    app.mount("/static/coach", coach.CoachStatic(directory=STATIC / "coach"), name="coach-static")
    app.mount("/static", coach.SiteStatic(directory=STATIC), name="static")
    return app


def _client(unlocked: bool = True) -> TestClient:
    """unlocked=True 면 열쇠를 넣은 기기(내 기기), False 면 다른 사람의 기기."""
    c = TestClient(_app())
    if unlocked:
        c.cookies.set(coach.COOKIE, coach.normalize_key(KEY))
    return c


def _raw_status(app, path: str, cookie: str | None = None) -> int:
    """주소를 다듬지 않고 그대로 보낸다(테스트 클라이언트가 ./ 나 ../ 를 정리해 버리지 않게)."""
    headers = [(b"host", b"testserver")]
    if cookie:
        headers.append((b"cookie", f"{coach.COOKIE}={cookie}".encode()))
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET", "scheme": "http",
             "path": path, "raw_path": path.encode(), "query_string": b"", "root_path": "", "headers": headers,
             "server": ("testserver", 80), "client": ("testclient", 50000)}
    status: list[int] = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            status.append(message["status"])

    asyncio.run(app(scope, receive, send))
    return status[0]


def test_coach_page_served():
    r = _client().get("/coach")
    assert r.status_code == 200
    assert "스윙 코치" in r.text
    assert 'type="file"' in r.text and 'accept="video/*"' in r.text      # 휴대폰 갤러리에서 영상 고르기
    assert r.text.count('type="file"') == 1 and ' multiple ' in r.text    # 영상 올리기는 하나, 여러 개를 한 번에 고를 수 있다
    assert "capture=" not in r.text                                       # capture 를 붙이면 갤러리 대신 카메라만 뜬다
    assert r.headers["cache-control"] == "private, no-cache"              # 비공개: 중간에서 보관하지 않는다
    assert "noindex" in r.headers["x-robots-tag"]


def test_manifest_scope():
    m = _client().get("/coach/manifest.webmanifest").json()
    # 범위는 사이트 전체: 스윙 코치 아이콘으로 열어도 코트 오픈(/)이 앱 안에서 열린다
    assert m["start_url"] == "/coach" and m["scope"] == "/" and m["id"] == "/coach"
    assert [s["url"] for s in m["shortcuts"]] == ["/"]
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


def test_stroke_model_shape():
    """학습한 분류기 모델: 종류 6가지, 특징 수가 맞고, 원본 자료(영상·사람 이름)는 들어 있지 않다."""
    path = STATIC / "coach" / "data" / "stroke_model.json"
    assert path.is_file()
    m = json.loads(path.read_text(encoding="utf-8"))
    assert sorted(m["classes"]) == ["backhand", "bvolley", "forehand", "fvolley", "serve", "smash"]
    n = m["n_feat"]
    assert n == 107 and len(m["mean"]) == n and len(m["scale"]) == n and len(m["b"]) == 6
    assert all(len(row) == n for row in m["W"]) and all(v > 0 for v in m["scale"])
    assert path.stat().st_size < 40_000
    assert _client().get("/static/coach/data/stroke_model.json").status_code == 200
    assert _client(unlocked=False).get("/static/coach/data/stroke_model.json").status_code == 404


def test_cache_policy(monkeypatch):
    # 비공개: 그 기기의 브라우저만 보관한다(중간의 공유 캐시가 열쇠 없는 사람에게 다시 내주지 못하게 private)
    assert coach.cache_header_for("/static/coach/vendor/models/pose_landmarker_full.task") == "private, max-age=2592000, immutable"
    assert coach.cache_header_for("/static/coach/data/reference.json") == "private, max-age=3600"
    assert coach.cache_header_for("/static/coach/js/app.js") == "private, no-cache"
    assert coach.cache_header_for("/static/dashboard.html") is None
    monkeypatch.setattr(settings, "coach_private", False)          # 공개로 바꾸면 예전 정책
    assert coach.cache_header_for("/static/coach/vendor/models/pose_landmarker_full.task") == "public, max-age=2592000, immutable"
    assert coach.cache_header_for("/static/coach/data/reference.json") == "public, max-age=3600"
    assert coach.cache_header_for("/static/coach/js/app.js") == "no-cache"


def test_main_app_serves_coach_with_cache_headers():
    """실제 앱(app.main)에서: /coach 가 뜨고, 큰 파일에는 오래 보관 머리말이 붙고, 기존 화면(/)은 그대로다."""
    from app.main import app as main_app

    c = TestClient(main_app)          # lifespan(스케줄러·외부 호출)은 돌리지 않는다
    c.cookies.set(coach.COOKIE, coach.normalize_key(KEY))          # 내 기기
    assert c.get("/coach").status_code == 200
    r = c.get("/static/coach/vendor/tasks-vision/VERSION")
    assert r.status_code == 200 and "immutable" in r.headers["cache-control"]
    js = c.get("/static/coach/js/geom.js")
    assert js.headers["cache-control"] == "private, no-cache" and "Cookie" in js.headers["vary"]
    assert "private" in r.headers["cache-control"] and "Cookie" in r.headers["vary"]
    # 다시 확인(304)·일부만 받기(206)에도 같은 정책이 붙는다
    again = c.get("/static/coach/js/geom.js", headers={"If-None-Match": js.headers["etag"]})
    assert again.status_code == 304 and again.headers["cache-control"] == "private, no-cache"
    part = c.get("/static/coach/vendor/tasks-vision/VERSION", headers={"Range": "bytes=0-1"})
    assert part.status_code == 206 and part.headers["cache-control"].startswith("private")
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


def _tab_links(html: str) -> dict[str, bool]:
    """아래 탭의 링크 → 지금 화면 표시(aria-current) 여부"""
    import re
    nav = re.search(r'<nav class="tabs"[^>]*>(.*?)</nav>', html, re.S)
    assert nav, "아래 탭이 없다"
    return {m.group(2): 'aria-current="page"' in m.group(1) for m in re.finditer(r'<a class="tab([^>]*?) href="([^"]+)"', nav.group(1))}


def _site() -> FastAPI:
    """코트 오픈 + 스윙 코치 + 설치 파일(manifest)"""
    from app.routers import dashboard, push

    app = FastAPI()
    app.include_router(dashboard.router)
    app.include_router(coach.router)
    app.include_router(push.router)
    return app


def test_tabs_link_both_screens():
    """내 기기에서는 코트 오픈과 스윙 코치가 아래 탭으로 서로 이어진다(한 앱처럼)."""
    c = TestClient(_site())
    c.cookies.set(coach.COOKIE, coach.normalize_key(KEY))
    court = _tab_links(c.get("/").text)
    swing = _tab_links(c.get("/coach").text)
    assert court == {"/": True, "/coach": False}           # 코트 오픈 화면: 코트 오픈 탭이 켜져 있다
    assert swing == {"/": False, "/coach": True}           # 스윙 코치 화면: 스윙 코치 탭이 켜져 있다
    m = c.get("/manifest.webmanifest").json()
    assert m["scope"] == "/" and m["start_url"] == "/?source=pwa"          # 이미 설치한 앱이 그대로 이어지게 바꾸지 않는다
    assert m["shortcuts"] == []                            # 비공개인 동안에는 스윙 코치 바로가기를 넣지 않는다(이 파일은 모두에게 같다)


def test_served_files_are_committed():
    """앱이 내려 주는 파일이 저장소에 올라가 있어야 한다(.gitignore 의 data/ 규칙에 걸려 기준 데이터가 빠진 적이 있다)."""
    import shutil
    import subprocess

    root = STATIC.parent.parent
    if not shutil.which("git") or not (root / ".git").exists():
        return                                                     # 저장소 밖(배포 이미지 등)에서는 건너뛴다
    files = [p for p in (STATIC / "coach").rglob("*") if p.is_file() and "__pycache__" not in p.parts]
    assert any(p.name == "reference.json" for p in files)
    tracked = set(subprocess.run(["git", "ls-files", "app/static/coach"], cwd=root, capture_output=True, text=True, check=True).stdout.split("\n"))
    missing = [str(p.relative_to(root)) for p in files if str(p.relative_to(root)) not in tracked]
    assert not missing, f"저장소에 없는 파일: {missing}"
    ignored = subprocess.run(["git", "check-ignore", "app/static/coach/data/reference.json"], cwd=root, capture_output=True, text=True)
    assert ignored.returncode != 0, "기준 데이터가 .gitignore 에 걸린다"


# ── 공개 범위: 지금은 열쇠를 넣은 기기(내 컴퓨터·휴대폰)에서만 열린다 ─────────────────
def test_private_is_the_default():
    """완성하기 전까지는 비공개가 기본이다. 열쇠 자체는 저장소에 없고 해시만 있다."""
    assert Settings.model_fields["coach_private"].default is True
    h = Settings.model_fields["coach_key_sha256"].default
    assert len(h) == 64 and all(ch in "0123456789abcdef" for ch in h)


def test_locked_page_shows_nothing_of_the_app():
    r = _client(unlocked=False).get("/coach")
    assert r.status_code == 403
    assert "준비 중" in r.text
    for leak in ('type="file"', "/static/coach/js/app.js", "coach.css", "영상", "분석"):
        assert leak not in r.text, leak
    assert r.headers["cache-control"] == "no-store" and "noindex" in r.headers["x-robots-tag"]
    assert "set-cookie" not in r.headers
    assert _client(unlocked=False).get("/coach/").status_code == 403


def test_locked_static_files_are_not_served():
    """열쇠가 없는 기기에는 스윙 코치 파일을 내주지 않는다. 주소를 비틀어도 마찬가지다."""
    from app.main import app as main_app

    c = TestClient(main_app)
    for path in ("/static/coach/index.html", "/static/coach/js/app.js", "/static/coach/js/speed.js", "/static/coach/coach.css",
                 "/static/coach/data/reference.json", "/static/coach/vendor/tasks-vision/VERSION", "/static/coach/"):
        assert c.get(path).status_code == 404, path
    twisted = ("/static//coach/js/app.js", "/static/./coach/js/app.js", "/static/x/../coach/js/app.js", "/static/coach/../coach/js/app.js",
               "/static/coach/icon-192.png/../js/app.js", "/static/coach//js/app.js", "/static/../static/coach/js/app.js",
               "/static/coach/js/../../coach/index.html", "/static//coach/index.html")
    for path in twisted:
        assert _raw_status(main_app, path) != 200, path
        assert _raw_status(_app(), path) != 200, path
    # 앱 아이콘과 설치 파일은 내준다(스윙 코치의 내용이 아니다)
    assert c.get("/static/coach/icon-192.png").status_code == 200
    assert c.get("/static/coach/icon-512.png").status_code == 200
    assert c.get("/coach/manifest.webmanifest").status_code == 200
    # 기존 화면의 파일은 그대로
    assert c.get("/static/icon-192.png").status_code == 200
    # 코트 오픈 화면 원본은 / 에서만 나간다(원본에는 스윙 코치 탭이 들어 있다)
    assert c.get("/static/dashboard.html").status_code == 404 and c.get("/").status_code == 200
    assert _raw_status(main_app, "/static/./dashboard.html") != 200 and _raw_status(main_app, "/static//dashboard.html") != 200
    locked = c.get("/static/coach/js/app.js")
    assert locked.headers["cache-control"] == "no-store"            # 잠긴 응답은 어디에도 보관하지 않는다
    # 내 기기에서는 같은 주소가 열린다
    mine = coach.normalize_key(KEY)
    assert _raw_status(main_app, "/static/coach/js/app.js", cookie=mine) == 200
    assert _raw_status(main_app, "/static//coach/js/app.js", cookie=mine) != 200      # 비튼 주소는 누구에게도 내주지 않는다


def test_unlock_link_keeps_the_key_out_of_server_logs():
    """여는 주소는 /coach#k=<열쇠> — # 뒤는 서버로 오지 않는다. 잠금 화면의 스크립트가 읽어서 POST 로 보낸다."""
    c = _client(unlocked=False)
    r = c.get(f"/coach?k={KEY}", follow_redirects=False)                # ? 뒤는 접근 기록에 남으므로 받지 않는다
    assert r.status_code == 403 and "set-cookie" not in r.headers
    assert c.get("/coach").status_code == 403
    assert '<script src="/coach/unlock.js" defer></script>' in r.text
    js = c.get("/coach/unlock.js")
    assert js.status_code == 200 and "javascript" in js.headers["content-type"]
    assert "location.hash" in js.text and "form.submit()" in js.text and "history.replaceState" in js.text
    assert coach.normalize_key(KEY) not in js.text and KEY_HASH not in js.text       # 스크립트에 열쇠가 들어 있지 않다


def test_unlock_with_code_form_remembers_this_device():
    c = _client(unlocked=False)
    r = c.post("/coach/unlock", data={"key": "test2-key34-abcde-fgh56"}, follow_redirects=False)      # 소문자·줄표가 있어도 된다
    assert r.status_code == 303 and r.headers["location"] == "/coach"
    cookie = r.headers["set-cookie"]
    assert cookie.startswith(f"{coach.COOKIE}=") and "HttpOnly" in cookie and "samesite=lax" in cookie.lower()
    assert "Max-Age=" in cookie and "Secure" not in cookie                      # 내 컴퓨터의 http 개발 서버만 Secure 를 뺀다
    assert c.get("/coach").status_code == 200                                   # 이 기기에서는 이제 열린다
    assert c.get("/static/coach/js/app.js").status_code == 200


def test_unlock_over_https_behind_proxy():
    """배포 환경: 항상 Secure 쿠키. 요청 머리말(X-Forwarded-Proto)로 낮출 수 없다. 연 뒤 화면·파일까지 열린다."""
    c = TestClient(_app(), base_url="https://court.example")
    r = c.post("/coach/unlock", data={"key": KEY}, headers={"X-Forwarded-Proto": "http"}, follow_redirects=False)
    assert r.status_code == 303 and "Secure" in r.headers["set-cookie"]
    assert c.get("/coach").status_code == 200
    assert c.get("/static/coach/js/app.js").status_code == 200
    # 프록시 뒤에서 서버가 보는 주소가 http 여도(호스트가 실제 사이트면) Secure
    plain = TestClient(_app(), base_url="http://court.example")
    assert "Secure" in plain.post("/coach/unlock", data={"key": KEY}, follow_redirects=False).headers["set-cookie"]


def test_wrong_key_stays_locked():
    c = _client(unlocked=False)
    for r in (c.post("/coach/unlock", data={"key": "nope"}, follow_redirects=False), c.post("/coach/unlock", data={"key": ""}, follow_redirects=False),
              c.post("/coach/unlock", content=b"", follow_redirects=False)):
        assert r.status_code == 403 and "코드가 맞지 않아요" in r.text
        assert "set-cookie" not in r.headers
    assert c.get("/coach").status_code == 403
    bad = _client(unlocked=False)
    bad.cookies.set(coach.COOKIE, "WRONGWRONGWRONG")
    assert bad.get("/coach").status_code == 403 and bad.get("/static/coach/js/app.js").status_code == 404
    # 터무니없이 큰 본문은 읽다가 그만둔다
    big = c.post("/coach/unlock", content=b"key=" + b"A" * 100_000, follow_redirects=False)
    assert big.status_code == 413 and "set-cookie" not in big.headers


def test_broken_key_setting_locks_everyone_out(monkeypatch):
    """해시 설정이 비었거나 잘못됐으면 아무도 못 연다(열리는 쪽으로 틀리지 않는다)."""
    for broken in ("", "abc", None):
        monkeypatch.setattr(settings, "coach_key_sha256", broken)
        assert _client().get("/coach").status_code == 403
        assert _client(unlocked=False).post("/coach/unlock", data={"key": KEY}, follow_redirects=False).status_code == 403


def test_court_page_hides_coach_from_others():
    """코트 오픈 화면: 다른 사람에게는 스윙 코치로 가는 탭이 없다. 화면의 나머지는 그대로다."""
    others = TestClient(_site()).get("/")
    assert others.status_code == 200 and "코트 오픈" in others.text
    assert '<nav class="tabs"' not in others.text and 'href="/coach"' not in others.text
    assert ".app{padding-bottom:0}" in others.text                  # 탭 줄 자리의 여백도 없앤다
    assert others.headers["cache-control"] == "private, no-cache"
    mine = TestClient(_site())
    mine.cookies.set(coach.COOKIE, coach.normalize_key(KEY))
    page = mine.get("/").text
    assert _tab_links(page) == {"/": True, "/coach": False}
    assert len(page) > len(others.text)
    # 탭을 뺀 것 말고는 같은 화면이다
    from app.routers import dashboard
    assert dashboard.without_coach(page) == others.text


def test_public_mode_opens_for_everyone(monkeypatch):
    """완성해서 공개로 바꾸면(coach_private=false) 열쇠 없이 예전처럼 열린다."""
    monkeypatch.setattr(settings, "coach_private", False)
    c = _client(unlocked=False)
    r = c.get("/coach")
    assert r.status_code == 200 and 'type="file"' in r.text
    assert r.headers["cache-control"] == "no-cache" and "set-cookie" not in r.headers
    assert c.get("/static/coach/js/app.js").status_code == 200
    assert c.get("/coach?k=anything", follow_redirects=False).status_code == 200
    assert c.post("/coach/unlock", data={"key": "x"}, follow_redirects=False).status_code == 303
    site = TestClient(_site())
    assert _tab_links(site.get("/").text) == {"/": True, "/coach": False}
    m = site.get("/manifest.webmanifest").json()
    assert [s["url"] for s in m["shortcuts"]] == ["/coach"]
    for s in m["shortcuts"]:
        for icon in s["icons"]:
            assert (STATIC / icon["src"].removeprefix("/static/")).is_file()

"""스윙 코치(/coach) — 테니스 스윙 영상 분석 화면.

분석은 모두 휴대폰 브라우저 안에서 돈다(자세 인식 wasm + 순수 JS). 서버는 화면 파일만 내려 준다.
영상은 서버로 오지 않는다. 화면 파일은 app/static/coach/ 아래에 있다.

공개 범위: settings.coach_private 가 true 면 열쇠를 넣은 기기에서만 열린다.
  · 열쇠를 넣는 법: /coach#k=<열쇠> 주소를 한 번 열거나, 잠금 화면에서 열쇠 코드를 넣는다 → 그 기기에 쿠키로 기억한다.
    (# 뒤는 서버로 오지 않는다. 잠금 화면의 작은 스크립트가 읽어서 POST 로 보낸다 → 열쇠가 서버 접근 기록에 남지 않는다.)
  · 열쇠가 없는 기기: /coach 는 '준비 중' 화면, /static/coach 의 파일은 404, 코트 오픈 화면의 스윙 코치 탭은 보이지 않는다.
  · 열쇠 자체는 저장소에 없다(SHA-256 만 설정에 있다).
"""
from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from app.config import settings

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

# ── 공개 범위(열쇠) ─────────────────────────────────────────────
COOKIE = "coach_key"
COOKIE_AGE = 400 * 24 * 3600                       # 브라우저가 허용하는 가장 긴 기간(약 13개월). 스윙 코치를 열 때마다 다시 늘린다.
OPEN_STATIC = {"icon-192.png", "icon-512.png"}     # 잠겨 있어도 내주는 파일(앱 아이콘뿐)


def normalize_key(key: object) -> str:
    """열쇠를 견주기 좋게 다듬는다: 영문·숫자만, 대문자로(줄표·빈칸은 있어도 없어도 된다)."""
    return "".join(ch for ch in str(key or "").upper() if ch.isascii() and ch.isalnum())[:64]


def key_ok(key: object) -> bool:
    k = normalize_key(key)
    want = (settings.coach_key_sha256 or "").strip().lower()
    if not k or len(want) != 64:                   # 해시가 잘못 설정돼 있으면 아무도 못 연다(열리는 쪽으로 틀리지 않는다)
        return False
    return hmac.compare_digest(hashlib.sha256(k.encode()).hexdigest(), want)


def allowed(request: Request) -> bool:
    """이 요청을 보낸 기기가 스윙 코치를 볼 수 있는가."""
    if not settings.coach_private:
        return True
    return key_ok(request.cookies.get(COOKIE))


def _remember(response: Response, request: Request, key: object) -> None:
    """이 기기에 열쇠를 기억시킨다(자바스크립트가 읽지 못하는 쿠키, https 에서만 보낸다)."""
    # 내 컴퓨터에서 http 로 띄운 개발 서버만 예외로 두고 항상 Secure 를 붙인다.
    # (배포 환경은 프록시 뒤라 서버가 보는 주소가 http 일 수 있다. 요청 머리말은 누구나 지어낼 수 있어서 믿지 않는다.)
    local = request.url.scheme == "http" and request.url.hostname in ("127.0.0.1", "localhost", "testserver")
    response.set_cookie(COOKIE, normalize_key(key), max_age=COOKIE_AGE, path="/", httponly=True,
                        secure=not local, samesite="lax")


_LOCK_HEADERS = {"Cache-Control": "no-store", "Content-Security-Policy": CSP, "Referrer-Policy": "no-referrer",
                 "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow"}


def _lock_page(wrong: bool = False) -> HTMLResponse:
    """열쇠가 없는 기기에 보여 주는 화면. 스윙 코치의 내용은 아무것도 담지 않는다."""
    note = '<p class="err" role="alert">코드가 맞지 않아요. 다시 확인해 주세요.</p>' if wrong else ""
    html = f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#0B1210">
<title>스윙 코치 — 준비 중</title>
<style>
*{{box-sizing:border-box}}
body{{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;
  background:#0B1210;color:#F3F6F4;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Noto Sans KR",sans-serif}}
main{{width:100%;max-width:360px}}
h1{{margin:0 0 8px;font-size:24px;line-height:1.3;letter-spacing:-.02em}}
p{{margin:0;color:#B6C2BC}}
a.back{{display:flex;align-items:center;justify-content:center;height:52px;margin-top:28px;border-radius:14px;
  background:#D4F250;color:#0B1210;font-weight:700;text-decoration:none}}
details{{margin-top:20px;border-top:1px solid rgba(255,255,255,.09);padding-top:16px}}
summary{{color:#84918B;font-size:14px;cursor:pointer}}
form{{display:flex;gap:8px;margin-top:12px}}
input{{flex:1;min-width:0;height:48px;padding:0 14px;border-radius:12px;border:1px solid rgba(255,255,255,.16);
  background:#121B18;color:#F3F6F4;font:inherit;letter-spacing:.04em}}
button{{height:48px;padding:0 18px;border:0;border-radius:12px;background:#18231F;color:#F3F6F4;font:inherit;font-weight:600}}
.err{{margin-top:12px;color:#FF9A8A;font-size:14px}}
</style></head>
<body><main>
<h1>스윙 코치는 준비 중이에요</h1>
<p>아직 다듬는 중이라 공개하지 않았어요. 완성되면 여기에서 열립니다.</p>
<a class="back" href="/">코트 오픈으로 가기</a>
<details{' open' if wrong else ''}><summary>열쇠 코드가 있어요</summary>
<form method="post" action="/coach/unlock">
<input name="key" type="password" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="열쇠 코드" placeholder="열쇠 코드" required>
<button type="submit">열기</button></form>{note}</details>
</main><script src="/coach/unlock.js" defer></script></body></html>"""
    return HTMLResponse(html, status_code=403, headers=_LOCK_HEADERS)


def _unlocked(request: Request, key: object) -> RedirectResponse:
    """열쇠가 맞았다: 이 기기에 기억시키고 /coach 로 보낸다(주소 줄에 열쇠가 남지 않게)."""
    res = RedirectResponse("/coach", status_code=303, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})
    _remember(res, request, key)
    return res


@router.get("/coach", response_class=HTMLResponse)
@router.get("/coach/", response_class=HTMLResponse, include_in_schema=False)
def coach(request: Request) -> Response:
    if settings.coach_private and not allowed(request):
        return _lock_page()
    try:
        html = (_DIR / "index.html").read_text(encoding="utf-8")
    except OSError:
        return HTMLResponse(
            "<!doctype html><meta charset='utf-8'><p style='font-family:sans-serif;padding:40px'>"
            "스윙 코치 화면 파일(app/static/coach/index.html)이 없습니다. 배포 구성을 확인하세요.</p>",
            status_code=503,
        )
    # 화면 파일은 자주 바뀌니 매번 확인하게 한다(큰 파일은 /static 에서 따로 캐시)
    res = HTMLResponse(html, headers={"Cache-Control": "no-cache", "Content-Security-Policy": CSP,
                                      "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"})
    if settings.coach_private:
        res.headers["Cache-Control"] = "private, no-cache"
        res.headers["X-Robots-Tag"] = "noindex, nofollow"
        _remember(res, request, request.cookies.get(COOKIE))   # 열 때마다 기억하는 기간을 다시 늘린다
    return res


_MAX_FORM = 2048


@router.post("/coach/unlock", include_in_schema=False)
async def coach_unlock(request: Request) -> Response:
    """잠금 화면에서 열쇠 코드를 넣었을 때(본문으로 받는다 — 주소에 넣지 않으므로 접근 기록에 남지 않는다)."""
    if not settings.coach_private:
        return RedirectResponse("/coach", status_code=303)
    body = b""
    async for chunk in request.stream():                    # 큰 본문을 다 읽지 않는다
        body += chunk
        if len(body) > _MAX_FORM:
            return Response(status_code=413, headers={"Cache-Control": "no-store", "Connection": "close"})
    key = (parse_qs(body.decode("utf-8", "replace")).get("key") or [""])[0]
    return _unlocked(request, key) if key_ok(key) else _lock_page(wrong=True)


# 잠금 화면이 부르는 스크립트: 주소의 #k=<열쇠> 를 읽어 위 폼으로 보낸다. 열쇠나 스윙 코치의 내용은 들어 있지 않다.
_UNLOCK_JS = """(function () {
  var m = /[#&]k=([^&]+)/.exec(location.hash || '');
  if (!m) return;
  var form = document.querySelector('form[action="/coach/unlock"]');
  var input = form && form.querySelector('input[name=key]');
  if (!input) return;
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* 주소를 못 고쳐도 계속 */ }
  try { input.value = decodeURIComponent(m[1]); } catch (e) { input.value = m[1]; }
  form.submit();
})();
"""


@router.get("/coach/unlock.js", include_in_schema=False)
def coach_unlock_js() -> Response:
    return Response(_UNLOCK_JS, media_type="application/javascript",
                    headers={"Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"})


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


# ── 정적 파일 ───────────────────────────────────────────────────
class CoachStatic(StaticFiles):
    """스윙 코치 파일(/static/coach). 비공개일 때는 열쇠가 있는 기기에만 내준다(앱 아이콘은 빼고)."""

    async def get_response(self, path: str, scope) -> Response:
        if settings.coach_private and not allowed(Request(scope)):
            full, _ = self.lookup_path(path)               # 주소를 어떻게 썼든 '실제로 내줄 파일'을 보고 판단한다
            rel = os.path.relpath(full, os.path.realpath(_DIR)).replace(os.sep, "/") if full else ""
            if rel not in OPEN_STATIC:
                raise HTTPException(status_code=404, headers={"Cache-Control": "no-store"})
        return await super().get_response(path, scope)


class SiteStatic(StaticFiles):
    """기존 /static. 스윙 코치 폴더는 여기로 내주지 않는다(/static//coach/… 처럼 주소를 비틀어 잠금을 돌아가지 못하게).
    코트 오픈 화면 원본(dashboard.html)도 내주지 않는다 — 그 화면은 / 에서만 나가고, 거기서 기기에 따라 탭을 뺀다."""

    def lookup_path(self, path: str):
        full, st = super().lookup_path(path)
        if full:
            real = os.path.realpath(full)
            coach_dir = os.path.realpath(_DIR)
            if os.path.commonpath([real, coach_dir]) == coach_dir or real == os.path.realpath(_DIR.parent / "dashboard.html"):
                return "", None
        return full, st


def cache_header_for(path: str) -> str | None:
    """정적 파일 캐시 정책. 자세 인식 엔진·모델(수십 MB)은 버전이 바뀌지 않는 한 그대로라 오래 보관한다.
    비공개일 때는 public 대신 private: 그 기기의 브라우저만 보관하고, 중간의 공유 캐시는 보관하지 못한다
    (공유 캐시가 내 기기에 내준 파일을 열쇠 없는 사람에게 다시 내주면 안 된다)."""
    if not path.startswith("/static/coach/"):
        return None
    scope = "private" if settings.coach_private else "public"
    if path.startswith("/static/coach/vendor/"):
        return f"{scope}, max-age=2592000, immutable"
    if path.startswith("/static/coach/data/"):
        return f"{scope}, max-age=3600"
    return "private, no-cache" if settings.coach_private else "no-cache"

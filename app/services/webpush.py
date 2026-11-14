"""앱 알림(웹 푸시) — 친구들이 카톡 없이 폰 알림·앱 아이콘 숫자로 받는다.

VAPID 키: 환경변수 VAPID_PRIVATE_KEY(base64url 32바이트)가 있으면 그것, 없으면 이미 서버에 있는
비밀값(SEOUL_API_KEY)에서 결정적으로 만든다 → 재배포해도 키가 같아 기존 구독이 유지된다.
구독 목록은 DB(push_sub)에 있다. 무료 클라우드는 재배포 때 DB가 비므로, 화면이 열릴 때마다
구독을 다시 보내 복구한다(dashboard.html).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
from functools import lru_cache

from sqlmodel import Session, select

from app.clock import now as _now
from app.config import settings
from app.models import PushSent, PushSub

logger = logging.getLogger("tennis.webpush")

CLAIM_SUB = "mailto:dongil0105@gmail.com"
_P256_N = int("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _b64u_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


@lru_cache(maxsize=1)
def _keys():
    """(Vapid 객체, 공개키 base64url). 비밀값이 없으면 (None, '')."""
    from cryptography.hazmat.primitives import serialization as S
    from cryptography.hazmat.primitives.asymmetric import ec
    from py_vapid import Vapid

    raw = (settings.vapid_private_key or "").strip()
    scalar = 0
    if raw:
        try:
            b = _b64u_dec(raw)
            scalar = int.from_bytes(b, "big") if len(b) == 32 else 0
        except ValueError:
            scalar = 0
        if not (0 < scalar < _P256_N):
            logger.error("VAPID_PRIVATE_KEY 형식이 잘못됐어요(base64url 32바이트) — 서버 비밀값에서 만든 키를 씁니다.")
            scalar = 0
    if not scalar:
        seed = (settings.seoul_api_key or settings.kakao_rest_key or "").strip()
        if not seed:
            return None, ""
        d = hmac.new(seed.encode(), b"seoul-tennis-court/vapid/v1", hashlib.sha256).digest()
        scalar = int.from_bytes(d, "big") % (_P256_N - 1) + 1
    key = ec.derive_private_key(scalar, ec.SECP256R1())
    pub = key.public_key().public_bytes(S.Encoding.X962, S.PublicFormat.UncompressedPoint)
    return Vapid(private_key=key), _b64u(pub)


def public_key() -> str:
    return _keys()[1]


def ready() -> bool:
    return bool(public_key())


# ── 구독 저장 ──────────────────────────────────────────────────────

# 브라우저 푸시 서비스 주소만 받는다(서버가 엉뚱한 곳으로 요청을 보내게 만들 수 없게).
_PUSH_HOSTS = ("fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com",
               "web.push.apple.com")
_PUSH_SUFFIXES = (".push.apple.com", ".notify.windows.com", ".push.services.mozilla.com")


def endpoint_allowed(ep: str) -> bool:
    from urllib.parse import urlparse
    try:
        u = urlparse(ep)
    except ValueError:
        return False
    try:
        port = u.port
    except ValueError:
        return False
    host = (u.hostname or "").lower()
    if u.scheme != "https" or not host or u.username or u.password or port not in (None, 443):
        return False
    return host in _PUSH_HOSTS or host.endswith(_PUSH_SUFFIXES)


def _clean_areas(areas) -> list[str]:
    """기기가 고른 알림 이름. 반포 알림 두 가지는 고른 기기에만 넣고, 아무 것도 없으면 5곳 전체."""
    from app.services import tennisplay as PLAY
    from app.services.openings import all_areas
    base = all_areas()
    if not isinstance(areas, list):
        return base
    valid = base + ([PLAY.AREA, PLAY.AREA_FREE] if PLAY.ready() else [])
    out = [a for a in areas if isinstance(a, str) and a in valid]
    return out or base


def subscribe(session: Session, sub: dict, areas=None, d1: bool | None = True,
              h1: bool | None = True, ua: str = "", old_endpoint: str = "") -> dict:
    """구독 저장. 브라우저가 구독을 바꿀 때(old_endpoint) 설정이 안 오면 옛 구독 설정을 옮긴다."""
    ep = str((sub or {}).get("endpoint") or "")
    keys = (sub or {}).get("keys") or {}
    if not endpoint_allowed(ep) or not keys.get("p256dh") or not keys.get("auth"):
        return {"ok": False, "error": "구독 정보가 올바르지 않아요."}
    old = None
    if old_endpoint and old_endpoint != ep:
        old = session.exec(select(PushSub).where(PushSub.endpoint == old_endpoint)).first()
    row = session.exec(select(PushSub).where(PushSub.endpoint == ep)).first()
    if row is None:
        row = PushSub(endpoint=ep)
        if old is not None:
            row.areas, row.d1, row.h1 = old.areas, old.d1, old.h1
    row.p256dh = str(keys["p256dh"])
    row.auth = str(keys["auth"])
    if areas is not None or old is None:
        row.areas = json.dumps(_clean_areas(areas), ensure_ascii=False)
    if d1 is not None:
        row.d1 = bool(d1)
    if h1 is not None:
        row.h1 = bool(h1)
    if old is not None:
        session.delete(old)
    row.ua = (ua or "")[:200]
    row.updated_at = _now()
    session.add(row)
    session.commit()
    return {"ok": True}


def unsubscribe(session: Session, endpoint: str) -> dict:
    row = session.exec(select(PushSub).where(PushSub.endpoint == (endpoint or ""))).first()
    if row:
        session.delete(row)
        session.commit()
    return {"ok": True}


def count(session: Session) -> int:
    return len(session.exec(select(PushSub)).all())


# ── 발송 ──────────────────────────────────────────────────────────

def _send(session: Session, row: PushSub, payload: dict, ttl: int = 3600) -> bool:
    from pywebpush import WebPushException, webpush
    vapid, _ = _keys()
    if vapid is None:
        return False
    if not endpoint_allowed(row.endpoint):      # 예전에 저장된 이상한 주소로는 절대 보내지 않음
        session.delete(row)
        session.commit()
        return False
    info = {"endpoint": row.endpoint, "keys": {"p256dh": row.p256dh, "auth": row.auth}}
    try:
        webpush(subscription_info=info, data=json.dumps(payload, ensure_ascii=False),
                ttl=ttl, vapid_private_key=vapid, vapid_claims={"sub": CLAIM_SUB},
                timeout=10)
        return True
    except WebPushException as e:
        code = getattr(getattr(e, "response", None), "status_code", None)
        if code in (404, 410):            # 사용자가 알림을 끄거나 앱을 지움 → 정리
            session.delete(row)
            session.commit()
        else:
            logger.warning("push 실패 %s: %s", code, e)
        return False
    except Exception as e:  # noqa: BLE001  네트워크 등
        logger.warning("push 오류: %s", e)
        return False


_TEST_AT: dict[str, float] = {}
TEST_COOLDOWN = 60   # 초 — 같은 기기 테스트 알림 남용 방지


def send_test(session: Session, endpoint: str) -> dict:
    import time
    row = session.exec(select(PushSub).where(PushSub.endpoint == (endpoint or ""))).first()
    if row is not None:
        last = _TEST_AT.get(row.endpoint, 0.0)
        if time.monotonic() - last < TEST_COOLDOWN:
            return {"ok": False, "error": "테스트 알림은 1분에 한 번만 보낼 수 있어요."}
        _TEST_AT[row.endpoint] = time.monotonic()
    if row is None:
        return {"ok": False, "error": "이 기기의 알림 구독을 찾지 못했어요. 알림 받기를 다시 눌러 주세요."}
    ok = _send(session, row, {
        "title": "코트 오픈 알림이 켜졌어요",
        "body": "고른 테니스장의 예약이 열리기 전에 알려 드릴게요.",
        "url": "/", "tag": "test", "badge": 0,
    }, ttl=600)
    return {"ok": ok} if ok else {"ok": False, "error": "보내지 못했어요. 잠시 뒤 다시 시도해 주세요."}


def _fmt(open_at: str) -> str:
    from datetime import datetime
    try:
        dt = datetime.strptime(open_at[:16], "%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        return open_at
    wd = ["월", "화", "수", "목", "금", "토", "일"][dt.weekday()]
    return f"{dt.month}.{dt.day}({wd}) {dt:%H:%M}"


def _event_key(g: dict) -> str:
    return f"{g['kind']}|{g['place']}|{g['open_at']}"


def _wants(areas: set, g: dict) -> bool:
    mine = set(g.get("areas") or [])
    if g.get("opt_in"):                      # 반포처럼 그 알림을 고른 기기에만 보내는 것
        return bool(areas & mine)
    return not areas or bool(areas & mine)


def _areas_of(row: PushSub) -> set:
    try:
        return set(json.loads(row.areas or "[]"))
    except ValueError:
        return set()


# ── 앱 안의 '새 알림' 표시 ─────────────────────────────────────────
# 알림마다 '어느 곳의 무슨 알림인지'(items)를 같이 보낸다. 서비스워커가 받아 적어 두었다가, 앱을 열면
# 화면이 그 곳 옆에 '새 알림'으로 보여 준다. 앱 아이콘 숫자도 이 목록(아직 안 본 알림 수)으로 센다.

MAX_PAYLOAD = 2800      # 푸시 한 건은 4KB 를 넘지 못한다 — 넉넉히 남긴다
MAX_ITEMS = 8


def _open_item(g: dict, areas: set) -> dict:
    """오픈 알림 한 곳. 며칠 뒤에 봐도 맞도록 '내일'이 아니라 날짜로 적는다."""
    mine = list(g.get("areas") or [])
    area = next((a for a in mine if a in areas), mine[0] if mine else "")
    text = (f"{_fmt(g['open_at'])} 예약 오픈" + (" · 공지 일정" if g.get("expected") else "")
            + (f" · {g['note']}" if g.get("note") else ""))
    # key: 같은 오픈의 '전날 알림'과 '1시간 전 알림'은 앱에서 한 줄로 합쳐진다
    return {"area": area, "place": g["place"], "kind": g["kind"],
            "key": f"open|{str(g['open_at'])[:16]}", "text": text}


def free_item(body: str) -> dict:
    """반포 '빈 시간이 생겼어요' 알림 한 건(앱 알림의 items 와 보낸 알림 기록이 같이 쓴다)."""
    from app.services import tennisplay as PLAY
    return {"area": PLAY.AREA, "place": settings.ttp_place, "kind": "free",
            "key": f"free|{body[:80]}", "text": body[:300]}


def _fit(payload: dict) -> dict:
    """items 때문에 알림이 너무 길어지면 뒤에서부터 덜어 낸다(알림 문구는 그대로)."""
    items = list(payload.get("items") or [])[:MAX_ITEMS]
    out = {k: v for k, v in payload.items() if k != "items"}

    def size(xs: list) -> int:
        return len(json.dumps({**out, "items": xs}, ensure_ascii=False).encode("utf-8"))

    while items and size(items) > MAX_PAYLOAD:
        items.pop()
    if items:
        out["items"] = items
    return out


def send_play_free(session: Session | None, title: str, body: str, badge: int = 0,
                   play_badge: int = 0) -> int:
    """반포 '빈 시간이 생겼어요' — 그 알림을 켠 기기에만. 급한 알림이라 실패해도 다시 보내지 않는다."""
    from app.services import tennisplay as PLAY
    if not body or not ready():
        return 0
    if session is None:
        from app.db import get_session
        with get_session() as own:
            return send_play_free(own, title, body, badge, play_badge)
    sent = 0
    for row in list(session.exec(select(PushSub))):
        areas = _areas_of(row)
        if PLAY.AREA_FREE not in areas:
            continue
        payload = {"title": title, "body": body, "url": "/#play", "tag": "play-free",
                   "badge": badge + (play_badge if PLAY.AREA in areas else 0),
                   "items": [free_item(body)]}
        if _send(session, row, _fit(payload), ttl=1800):
            sent += 1
    return sent


def send_opening_alerts(session: Session | None, groups: list[dict], badge: int = 0,
                        play_badge: int = 0, delivered: list | None = None) -> int:
    """오픈 알람을 기기별(고른 지역·시점)로 보낸다. 보낸 기기 수 반환.

    기기마다 받은 알림을 PushSent 에 남겨, 같은 알림은 한 번만 가고 실패한 기기는 다음
    수집(7분 뒤) 때 다시 시도한다. 새로 구독한 기기도 아직 유효한 알림은 받는다.
    delivered: 목록을 주면 한 대에라도 실제로 보낸 묶음을 거기에 담는다(보낸 알림 기록용).
    """
    if not groups or not ready():
        return 0
    if session is None:                      # 스레드에서 부를 때: 자기 세션을 열고 닫는다
        from app.db import get_session
        with get_session() as own:
            return send_opening_alerts(own, groups, badge, play_badge, delivered)
    from app.services import tennisplay as PLAY
    sent = 0
    for row in list(session.exec(select(PushSub))):
        areas = _areas_of(row)
        done = set(session.exec(select(PushSent.event).where(PushSent.endpoint == row.endpoint)).all())
        mine = [g for g in groups
                if ((g["kind"] == "d1" and row.d1) or (g["kind"] == "h1" and row.h1))
                and _wants(areas, g)
                and _event_key(g) not in done]
        if not mine:
            continue
        h1 = [g for g in mine if g["kind"] == "h1"]
        top = (h1 or mine)[0]
        hhmm = (top.get("open_at") or "")[11:16]
        is_today = (top.get("open_at") or "")[:10] == _now().strftime("%Y-%m-%d")
        when = f"{'오늘' if is_today else '내일'} {hhmm}"
        title = f"{top['place']} 예약 {when} 오픈"
        lines = [f"{g['place']} · {_fmt(g['open_at'])}" + (" · 공지 일정" if g.get("expected") else "")
                 + (f" · {g['note']}" if g.get("note") else "")
                 for g in mine[:4]]
        if len(mine) > 4:
            lines.append(f"외 {len(mine) - 4}곳")
        payload = {"title": title, "body": "\n".join(lines),
                   "url": "/",
                   "tag": f"open-{top['kind']}-{top['open_at']}",
                   # 옛 서비스워커용 숫자(5곳 기준 + 반포 오픈 알림을 고른 기기만 반포 몫).
                   # 새 서비스워커는 이 값 대신 아직 안 본 알림 수(items)를 아이콘 숫자로 쓴다.
                   "badge": badge + (play_badge if PLAY.AREA in areas else 0),
                   "items": [_open_item(g, areas) for g in mine]}
        endpoint = row.endpoint
        if _send(session, row, _fit(payload), ttl=3600 if h1 else 6 * 3600):
            for g in mine:
                session.add(PushSent(endpoint=endpoint, event=_event_key(g)))
                if delivered is not None and g not in delivered:
                    delivered.append(g)
            session.commit()
            sent += 1
    return sent

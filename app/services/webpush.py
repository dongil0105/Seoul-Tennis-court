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
from app.models import PushSub

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
    if raw:
        scalar = int.from_bytes(_b64u_dec(raw), "big")
    else:
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

def _clean_areas(areas) -> list[str]:
    from app.services.openings import all_areas
    valid = all_areas()
    if not isinstance(areas, list):
        return valid
    out = [a for a in areas if isinstance(a, str) and a in valid]
    return out or valid


def subscribe(session: Session, sub: dict, areas=None, d1: bool = True, h1: bool = True,
              ua: str = "") -> dict:
    ep = str((sub or {}).get("endpoint") or "")
    keys = (sub or {}).get("keys") or {}
    if not ep.startswith("https://") or not keys.get("p256dh") or not keys.get("auth"):
        return {"ok": False, "error": "구독 정보가 올바르지 않아요."}
    row = session.exec(select(PushSub).where(PushSub.endpoint == ep)).first()
    if row is None:
        row = PushSub(endpoint=ep)
    row.p256dh = str(keys["p256dh"])
    row.auth = str(keys["auth"])
    row.areas = json.dumps(_clean_areas(areas), ensure_ascii=False)
    row.d1 = bool(d1)
    row.h1 = bool(h1)
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


def send_test(session: Session, endpoint: str) -> dict:
    row = session.exec(select(PushSub).where(PushSub.endpoint == (endpoint or ""))).first()
    if row is None:
        return {"ok": False, "error": "이 기기의 알림 구독을 찾지 못했어요. 알림 받기를 다시 눌러 주세요."}
    ok = _send(session, row, {
        "title": "코트 오픈 알림이 켜졌어요",
        "body": "고른 지역의 테니스장 예약이 열리기 전날·1시간 전에 알려 드릴게요.",
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
    return f"{dt.month}/{dt.day}({wd}) {dt:%H:%M}"


def send_opening_alerts(session: Session, groups: list[dict], badge: int = 0) -> int:
    """오픈 알람 묶음을 구독자별(고른 지역·시점)로 걸러 보낸다. 보낸 알림 수 반환."""
    if not groups or not ready():
        return 0
    sent = 0
    for row in list(session.exec(select(PushSub))):
        try:
            areas = set(json.loads(row.areas or "[]"))
        except ValueError:
            areas = set()
        mine = [g for g in groups
                if ((g["kind"] == "d1" and row.d1) or (g["kind"] == "h1" and row.h1))
                and (not areas or areas & set(g.get("areas") or []))]
        if not mine:
            continue
        h1 = [g for g in mine if g["kind"] == "h1"]
        top = (h1 or mine)[0]
        when = "1시간 뒤" if top["kind"] == "h1" else "내일"
        title = f"{top['place']} 예약이 {when} 열려요"
        lines = [f"{g['place']} {g['count']}면 · {_fmt(g['open_at'])}" for g in mine[:4]]
        if len(mine) > 4:
            lines.append(f"외 {len(mine) - 4}곳")
        payload = {"title": title, "body": "\n".join(lines),
                   "url": (top.get("reserve_url") or "/") if top["kind"] == "h1" else "/", "tag": f"open-{top['kind']}-{top['open_at']}",
                   "badge": badge}
        if _send(session, row, payload, ttl=3 * 3600):
            sent += 1
    return sent

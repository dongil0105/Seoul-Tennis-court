"""보낸 알림 기록 — 카카오톡으로만 받은 알림도 앱을 열면 '새 알림'으로 보이게 한다.

알림을 보낼 때마다(카카오톡이든 앱 알림이든) '어느 곳의 무슨 알림인지'를 한 줄씩 적어 두고,
화면 자료(/board 의 feed)에 최근 24시간 것을 싣는다. 화면은 기기마다 이미 보여 준 것을 기억해 두고
처음 보는 것만 '새 알림'으로 보여 준다(app/static/dashboard.html 의 takeFeed).

한 줄의 모양(area · place · kind · key · text)은 앱 알림에 실어 보내는 items 와 같다 — 같은 알림이
앱 알림과 이 기록 두 길로 와도 화면에서 한 줄로 합쳐진다.
무료 클라우드는 서버가 다시 켜질 때 DB 가 비므로, 그 전에 보낸 기록은 사라진다.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta

from sqlmodel import Session, select

from app.clock import KST
from app.clock import now as _now
from app.models import AlertFeed
from app.services import webpush as WP

logger = logging.getLogger("tennis.feed")

KEEP = timedelta(hours=24)     # 화면에 싣는 기간(화면의 FRESH_AGE 와 같다)
MAX_ROWS = 40                  # 화면에 싣는 최대 줄 수(최근 것부터)


def _ms(dt: datetime) -> int:
    """KST 시각 → UTC 밀리초(화면의 Date.now() 와 같은 기준)."""
    return int(dt.replace(tzinfo=KST).timestamp() * 1000)


def open_items(groups: list[dict]) -> list[dict]:
    """오픈 알림 묶음(openings.group_for_message) → 기록할 줄. areas = 그 묶음이 해당하는 이름 전부."""
    out = []
    for g in groups or []:
        item = WP._open_item(g, set())
        item["areas"] = [a for a in (g.get("areas") or []) if isinstance(a, str)]
        out.append(item)
    return out


def free_items(body: str) -> list[dict]:
    """반포 '빈 시간이 생겼어요' 알림 → 기록할 줄."""
    return [WP.free_item(body)] if body else []


def record(session: Session, items: list[dict]) -> int:
    """알림을 보낸 뒤에 부른다. 적은 줄 수를 돌려준다.

    같은 알림(이름 · key · 종류)이 이미 적혀 있으면 넘어간다 — 카카오톡과 앱 알림이 따로 보내도,
    앱 알림이 기기마다 여러 번에 나뉘어 가도 한 줄만 남는다. 기록에 실패해도 알림 발송을 막지 않는다.
    """
    if not items:
        return 0
    try:
        now = _now()
        for old in session.exec(select(AlertFeed).where(AlertFeed.at < now - KEEP)):
            session.delete(old)
        have = {(r.area, r.key, r.kind) for r in session.exec(select(AlertFeed))}
        added = 0
        for it in items:
            area, key, kind = str(it.get("area") or ""), str(it.get("key") or ""), str(it.get("kind") or "")
            text = str(it.get("text") or "").strip()
            if not text or not key or (area, key, kind) in have:
                continue
            have.add((area, key, kind))
            areas = it.get("areas") or ([area] if area else [])
            session.add(AlertFeed(area=area, areas=json.dumps(areas, ensure_ascii=False),
                                  place=str(it.get("place") or ""), kind=kind, key=key, text=text[:300], at=now))
            added += 1
        session.commit()
        return added
    except Exception:  # noqa: BLE001  기록은 부가 기능 — 실패해도 알림은 이미 나갔다
        logger.exception("보낸 알림 기록 실패 — 건너뜀")
        try:
            session.rollback()
        except Exception:  # noqa: BLE001
            pass
        return 0


def recent(session: Session) -> list[dict]:
    """화면에 실을 최근 24시간의 보낸 알림(오래된 것부터). at = 보낸 때(UTC 밀리초)."""
    rows = session.exec(select(AlertFeed).where(AlertFeed.at >= _now() - KEEP)
                        .order_by(AlertFeed.at.desc(), AlertFeed.id.desc()).limit(MAX_ROWS)).all()
    out = []
    for r in reversed(rows):
        try:
            areas = [a for a in json.loads(r.areas or "[]") if isinstance(a, str)]
        except ValueError:
            areas = []
        out.append({"area": r.area, "areas": areas or ([r.area] if r.area else []), "place": r.place,
                    "kind": r.kind, "key": r.key, "text": r.text, "at": _ms(r.at)})
    return out

"""카카오 '나에게 보내기' 발송 + access_token 자동 갱신.

흐름:
- 토큰은 kakao_token(id=1) 단일 행에 저장. 없으면 .env 값으로 부트스트랩.
- 발송 시 401/-401 또는 만료 임박이면 refresh_token으로 재발급 후 1회 재시도.
- 갱신 응답에 새 refresh_token이 오면 회전된 것이므로 저장.
- 시크릿(토큰)은 로그/예외에 노출하지 않는다.
"""
from __future__ import annotations

import json
import logging
from datetime import timedelta

import httpx
from sqlmodel import Session, select

from app.clock import now as _now
from app.config import settings
from app.http_util import request_with_retry
from app.models import KakaoToken, SendLog, Slot
from app.services.diff import mark_notified

logger = logging.getLogger("tennis.notifier")

KAKAO_SEND_URL = "https://kapi.kakao.com/v2/api/talk/memo/default/send"
KAKAO_TOKEN_URL = "https://kauth.kakao.com/oauth/token"
EXPIRY_SKEW = timedelta(minutes=5)  # 만료 5분 전이면 선제 갱신


def _load_token(session: Session) -> KakaoToken:
    token = session.get(KakaoToken, 1)
    if token is None:
        token = KakaoToken(
            id=1,
            access_token=settings.kakao_access_token or "",
            refresh_token=settings.kakao_refresh_token or "",
            access_expires_at=None,
        )
        session.add(token)
        session.commit()
        session.refresh(token)
    return token


async def _refresh_access_token(session: Session, token: KakaoToken) -> str:
    """refresh_token으로 access_token 재발급. 회전된 refresh_token도 저장."""
    if not token.refresh_token:
        raise RuntimeError("refresh_token 없음 — README의 카카오 재인증 절차 필요")
    if not settings.kakao_rest_key:
        raise RuntimeError("KAKAO_REST_KEY 미설정")

    data = {
        "grant_type": "refresh_token",
        "client_id": settings.kakao_rest_key,
        "refresh_token": token.refresh_token,
    }
    resp = await request_with_retry("POST", KAKAO_TOKEN_URL, data=data)
    body = resp.json()

    new_access = body.get("access_token")
    if not new_access:
        # 토큰값은 로깅하지 않고 키 존재 여부만 남긴다.
        logger.error("토큰 갱신 응답에 access_token 없음(keys=%s)", list(body.keys()))
        raise RuntimeError("카카오 토큰 갱신 실패")

    token.access_token = new_access
    expires_in = int(body.get("expires_in", 21600))
    token.access_expires_at = _now() + timedelta(seconds=expires_in)
    # refresh_token은 회전될 때만 응답에 포함된다.
    if body.get("refresh_token"):
        token.refresh_token = body["refresh_token"]
        logger.info("refresh_token 회전 감지 — 새 값 저장")
    token.updated_at = _now()
    session.add(token)
    session.commit()
    session.refresh(token)
    logger.info("access_token 갱신 완료")
    return token.access_token


async def get_valid_access_token(session: Session) -> str:
    """유효한 access_token 반환. 없거나 만료 임박이면 갱신."""
    token = _load_token(session)
    needs_refresh = (
        not token.access_token
        or token.access_expires_at is None
        or token.access_expires_at - EXPIRY_SKEW <= _now()
    )
    if needs_refresh:
        return await _refresh_access_token(session, token)
    return token.access_token


def _btns(buttons: list[dict] | None) -> list[dict]:
    """[{title,url}] → 카카오 buttons(최대 2개, 제목 14자)."""
    return [
        {"title": b["title"][:14], "link": {"web_url": b["url"], "mobile_web_url": b["url"]}}
        for b in (buttons or [])[:2]
    ]


async def _send_template(session: Session, template: dict) -> bool:
    """완성된 template_object를 나에게 보내기. 401이면 1회 갱신 후 재시도."""
    payload = {"template_object": json.dumps(template, ensure_ascii=False)}
    # 토큰 객체를 한 번만 로드해 갱신 책임을 한 곳으로 모은다(M-1).
    token = _load_token(session)
    access = await get_valid_access_token(session)
    for attempt in range(2):  # 0: 일반, 1: 갱신 후 재시도
        headers = {"Authorization": f"Bearer {access}"}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(KAKAO_SEND_URL, headers=headers, data=payload)
        except httpx.HTTPError as exc:
            logger.warning("카카오 발송 전송오류: %s", type(exc).__name__)
            return False

        if resp.status_code == 200 and resp.json().get("result_code") == 0:
            return True

        body = _safe_body(resp)
        code = body.get("code")
        if attempt == 0 and (resp.status_code == 401 or code == -401):
            logger.info("access_token 만료 추정 → 갱신 후 재시도")
            access = await _refresh_access_token(session, token)
            continue

        logger.error("카카오 발송 실패 status=%s code=%s", resp.status_code, code)
        return False
    return False


async def send_to_me(
    session: Session, text: str, link_url: str, buttons: list[dict] | None = None
) -> bool:
    """텍스트 메시지(기본 템플릿). 버튼은 button_title 1개만 지원."""
    template: dict = {
        "object_type": "text",
        "text": text[:200],
        "link": {"web_url": link_url, "mobile_web_url": link_url},
        "button_title": "예약하러 가기",
    }
    return await _send_template(session, template)


async def send_feed(
    session: Session, title: str, description: str, link_url: str,
    buttons: list[dict] | None = None,
) -> bool:
    """피드(feed) 템플릿 — 제목/내용 + 버튼 최대 2개를 카카오 버튼으로 렌더링.

    카카오 text 템플릿은 buttons 배열을 무시하므로, 진짜 버튼이 필요하면 feed를 쓴다.
    """
    template: dict = {
        "object_type": "feed",
        "content": {
            "title": title[:200],
            "description": description[:200],
            "link": {"web_url": link_url, "mobile_web_url": link_url},
        },
    }
    btns = _btns(buttons)
    if btns:
        template["buttons"] = btns
    return await _send_template(session, template)


def _safe_body(resp: httpx.Response) -> dict:
    try:
        return resp.json()
    except Exception:
        return {}


def _format_slot_line(s: Slot) -> str:
    night = " (야간)" if s.is_night else ""
    region = f"[{s.region}] " if s.region else ""
    tags = []
    if s.is_paid:
        tags.append("유료")
    if s.eligibility:
        tags.append(f"자격:{s.eligibility}")
    tag_str = f"\n  ⚠️ {' / '.join(tags)}" if tags else ""
    return f"• {region}{s.facility_name} {s.court_name}\n  {s.date} {s.time}{night}{tag_str}"


def _sent_today(session: Session) -> int:
    since = _now().replace(hour=0, minute=0, second=0, microsecond=0)
    logs = session.exec(select(SendLog).where(SendLog.sent_at >= since)).all()
    return sum(log.slot_count for log in logs)


def in_quiet_hours(now=None) -> bool:
    """무음 시간대 여부(KST 기준). QUIET_HOURS 미설정/형식오류면 False(항상 발송)."""
    rng = settings.quiet_range()
    if rng is None:
        return False
    start, end = rng
    hour = (now or _now()).hour
    if start <= end:
        return start <= hour < end
    # 자정을 넘는 구간(예: 23-06)
    return hour >= start or hour < end


async def notify_slots(session: Session, slots: list[Slot], batch_max: int | None = None) -> int:
    """후보 슬롯을 묶어 1개 메시지로 발송. 발송 성공분만 notified 기록.

    반환: 실제 알림된 슬롯 수.
    """
    if not slots:
        return 0
    if in_quiet_hours():
        logger.info("무음 시간대 — 발송 보류(%d건)", len(slots))
        return 0

    # 하루 총량 상한(슬롯 단위 — DAILY_SEND_LIMIT은 '하루 알림 슬롯 수' 상한)
    if settings.daily_send_limit > 0:
        remaining = settings.daily_send_limit - _sent_today(session)
        if remaining <= 0:
            logger.info("하루 발송 상한(%d슬롯) 도달 — 보류", settings.daily_send_limit)
            return 0
    else:
        remaining = None

    cap = batch_max if batch_max is not None else settings.batch_max
    to_send = slots[:cap]
    if remaining is not None:
        to_send = to_send[:remaining]
    if not to_send:
        return 0
    # 이번 배치에서 잘린 후보는 다음 주기에 재추출되어 발송된다(미발송분 누락 방지).
    dropped = len(slots) - len(to_send)
    if dropped > 0:
        logger.info("배치/상한으로 %d건 이월 — 다음 주기에 재처리", dropped)

    text, link = _build_court_text(to_send)
    ok = await send_to_me(session, text, link)
    if not ok:
        return 0

    mark_notified(session, to_send)
    session.add(SendLog(slot_count=len(to_send)))
    session.commit()
    logger.info("알림 발송 완료 %d건", len(to_send))
    return len(to_send)


YEYAK_MAIN = "https://yeyak.seoul.go.kr"


def _build_court_text(slots: list[Slot]) -> tuple[str, str]:
    """코트 목록 → (text, 링크). 특정 '대표' 코트를 고정으로 밀지 않고,

    예시 장소 몇 곳 + 전체 목록(대시보드) 링크만 안내한다. 대시보드에서 코트별로 골라 예약.
    카카오톡은 본문 속 URL을 자동으로 클릭 링크로 만든다(200자 제한 안에서 URL 보존).
    """
    n = len(slots)
    dash = settings.dashboard_url
    # 예시 장소명(court_name=PLACENM, 예: 응봉공원). 중복 제거 후 최대 3곳.
    seen: list[str] = []
    for s in slots:
        place = (s.court_name or "").split(">")[0].strip()  # 'A>B' 계층표기 정리
        if place and place not in seen:
            seen.append(place[:16])
        if len(seen) >= 3:
            break
    head = f"🎾 예약 접수중인 테니스 코트 {n}곳"
    label = "\n\n전체 목록·예약 ▶\n"
    ex = ("\n예: " + ", ".join(seen) + " 등") if seen else ""
    budget = 195 - len(head) - len(label) - len(dash)
    if len(ex) > budget:
        ex = ex[: max(0, budget)]
    return head + ex + label + dash, dash


async def send_startup_digest(session: Session, slots: list[Slot]) -> int:
    """서버 시작 시 1회 — 현재 예약 가능한 코트 요약 + 예약 주소(링크) 발송.

    사용자가 PC를 켠 시점의 단발 알림이므로 무음시간/하루상한과 무관하게 보낸다.
    """
    if not slots:
        logger.info("시작 알림: 예약 가능한 코트 없음 — 발송 생략")
        return 0
    text, link = _build_court_text(slots)
    ok = await send_to_me(session, text, link)
    if not ok:
        return 0
    session.add(SendLog(slot_count=len(slots)))
    session.commit()
    logger.info("시작 알림 발송 완료 (예약가능 %d곳)", len(slots))
    return len(slots)


def alert_url(fragment: str = "") -> str:
    """알림 메시지에 넣는 앱 주소 — 끝에 k=1 표시가 붙는다.

    이 링크로 연 화면은 '카카오톡 알림을 받는 사람'으로 보고, 서버가 보낸 알림을 모두 앱 안의
    '새 알림'으로 보여 준다(친구에게 공유하는 주소에는 붙지 않는다). fragment: 열자마자 갈 자리(#play)."""
    url = settings.dashboard_url
    return f"{url}{'&' if '?' in url else '?'}k=1" + (f"#{fragment}" if fragment else "")


async def send_play_free(session: Session, title: str, body: str) -> bool:
    """반포종합운동장에 빈 시간이 새로 생겼을 때 — 한 메시지(200자 안)."""
    dash = alert_url("play")
    label = "\n\n확인하러 가기 ▶\n"
    head = f"🎾 {title}"
    budget = 195 - len(head) - len(label) - len(dash) - 1
    text = f"{head}\n{body[: max(0, budget)]}{label}{dash}"
    return await send_to_me(session, text, dash)


def kakao_ready() -> bool:
    """카카오 발송 가능 환경인지(키가 설정된 서버에서만 알람 발송)."""
    return bool(settings.kakao_rest_key and
                (settings.kakao_refresh_token or settings.kakao_access_token))


def _fmt_open_dt(open_at: str) -> str:
    """'2026-11-01 09:00' → '11/1(일) 09:00'."""
    from datetime import datetime
    try:
        dt = datetime.strptime(open_at[:16], "%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        return open_at
    wd = ["월", "화", "수", "목", "금", "토", "일"][dt.weekday()]
    return f"{dt.month}/{dt.day}({wd}) {dt:%H:%M}"


async def send_opening_alerts(session: Session, groups: list[dict]) -> bool:
    """예약 오픈 알람 — d1(내일 오픈)·h1(1시간 안에 오픈) 묶음을 한 메시지로.

    groups: openings.group_for_message() 결과. 200자 제한 안에서 묶음 나열 + 대시보드 링크.
    """
    if not groups:
        return False
    dash = alert_url()
    h1 = [g for g in groups if g["kind"] == "h1"]
    d1 = [g for g in groups if g["kind"] == "d1"]
    head = "⏰ 곧 예약 시작!" if h1 else "🎾 내일 예약 오픈!"
    lines: list[str] = []
    for g in (h1 + d1)[:4]:
        tag = "1시간 내" if g["kind"] == "h1" else "내일"
        region = f"[{g['region']}] " if g.get("region") else ""
        cnt = f" {g['count']}개 코트" if g["count"] > 1 else ""
        src = " (공지 일정)" if g.get("expected") else (f" ({g['note']})" if g.get("note") else "")
        lines.append(f"· {region}{g['place']}{cnt} — {tag} {_fmt_open_dt(g['open_at'])} 오픈{src}")
    more = len(groups) - len((h1 + d1)[:4])
    if more > 0:
        lines.append(f"· 외 {more}건")
    label = "\n\n예약하러 가기 ▶\n"
    body = "\n".join(lines)
    budget = 195 - len(head) - len(label) - len(dash) - 1
    if len(body) > budget:
        body = body[: max(0, budget)]
    text = f"{head}\n{body}{label}{dash}"
    return await send_to_me(session, text, dash)

"""예약 '오픈 일정' 엔진 — 관심 코트 스크리닝 + D-day 버킷 + 날짜로 코트 찾기 + 알람 판정.

데이터 전제(실측): OA-2266의 RCPTBGNDT = 예약 접수 시작 일시(미래값이 '안내중'으로 예고됨),
SVCOPN*DT = 이용(운영) 기간. 날짜별 실제 잔여는 yeyak 상세에만 있어 수집하지 않는다(차단·경고)
— 그래서 '날짜로 찾기'는 접수중 + 요일/기간/시간대 매칭까지 하고, 잔여는 예약 페이지에서 확인.
"""
from __future__ import annotations

import re
from datetime import date as date_cls
from datetime import datetime, timedelta

from sqlmodel import Session, select

from app.clock import now as _now
from app.config import settings
from app.models import OpeningAlert, Slot

WEEKEND_KW = ("주말", "토/일", "토,일", "토·일", "공휴일", "토요일", "일요일")
WEEKDAY_KW = ("평일",)
UPCOMING_DAYS = 90       # '오픈 예정'으로 보여줄 최대 D-n
FRESH_HOURS = 26         # 이 시간 안에 관측된 슬롯만(죽은 행 제외)


# ── 관심 코트 스크리닝 ──────────────────────────────────────────────

def is_watched(region: str | None, facility: str, court: str) -> bool:
    """지역(구) 또는 이름 키워드(한남·장충 등)로 '내 코트' 여부 판정."""
    if (region or "") in settings.watch_region_set():
        return True
    name = f"{facility} {court}"
    return any(kw in name for kw in settings.watch_keyword_list())


def _fresh(session: Session, watched_only: bool = True) -> list[Slot]:
    cutoff = _now() - timedelta(hours=FRESH_HOURS)
    rows = list(session.exec(select(Slot).where(Slot.last_seen >= cutoff)))
    if watched_only:
        rows = [s for s in rows if is_watched(s.region, s.facility_name, s.court_name)]
    return rows


# ── 이름 파싱(요일·시간대·기간) ─────────────────────────────────────

def day_type(name: str) -> str:
    """'wd'(평일) | 'we'(주말·공휴일) | 'both' | 'any'(표기 없음)."""
    wd = any(k in name for k in WEEKDAY_KW)
    we = any(k in name for k in WEEKEND_KW)
    if wd and we:
        return "both"
    if wd:
        return "wd"
    if we:
        return "we"
    return "any"


def time_parts(name: str, time_start: str, time_end: str) -> set[str]:
    """이름 키워드(새벽/주간/야간) 우선, 없으면 운영시간(HH:MM)으로 추정."""
    parts: set[str] = set()
    if "새벽" in name or "심야" in name:
        parts.add("새벽")
    if "주간" in name or "오전" in name or "낮" in name:
        parts.add("주간")
    if "야간" in name or "저녁" in name:
        parts.add("야간")
    if parts:
        return parts

    def _h(s: str) -> int | None:
        d = "".join(ch for ch in (s or "") if ch.isdigit())
        try:
            return int(d[:2]) if len(d) >= 2 else None
        except ValueError:
            return None

    sh, eh = _h(time_start), _h(time_end)
    if sh is None or eh is None:
        return {"새벽", "주간", "야간"}  # 정보 없음 → 모든 시간대 후보
    if sh < 7:
        parts.add("새벽")
    if sh <= 17 and eh > 8:
        parts.add("주간")
    if eh >= 19:
        parts.add("야간")
    return parts or {"주간"}


_RANGE_RE = re.compile(r"(\d{1,2})\s*/\s*(\d{1,2})\s*~\s*(\d{1,2})\s*/\s*(\d{1,2})")
_MONTH_RE = re.compile(r"(?<![\d/])(\d{1,2})월")


def period_from_name(name: str, ref_year: int) -> tuple[date_cls, date_cls] | None:
    """'10/16~10/31장충…' '11월 망원…' 같은 이름 속 이용 기간을 날짜 범위로."""
    m = _RANGE_RE.search(name)
    if m:
        m1, d1, m2, d2 = (int(x) for x in m.groups())
        try:
            start = date_cls(ref_year, m1, d1)
            end_year = ref_year + 1 if (m2, d2) < (m1, d1) else ref_year
            end = date_cls(end_year, m2, d2)
            return start, end
        except ValueError:
            return None
    m = _MONTH_RE.search(name)
    if m:
        mm = int(m.group(1))
        try:
            start = date_cls(ref_year, mm, 1)
            nxt = date_cls(ref_year + (1 if mm == 12 else 0), 1 if mm == 12 else mm + 1, 1)
            return start, nxt - timedelta(days=1)
        except ValueError:
            return None
    return None


# ── 직렬화 ─────────────────────────────────────────────────────────

def _parse_open(open_at: str) -> datetime | None:
    try:
        return datetime.strptime(open_at[:16], "%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        return None


def _item(s: Slot, today: date_cls) -> dict:
    dt = _parse_open(s.open_at or "")
    d_day = (dt.date() - today).days if dt else None
    return {
        "facility": s.facility_name,
        "place": s.court_name,
        "region": s.region,
        "status": s.status,
        "open_at": s.open_at or "",
        "d_day": d_day,
        "time": s.time,
        "is_paid": s.is_paid,
        "is_night": s.is_night,
        "eligibility": s.eligibility,
        "reserve_url": s.reserve_url,
    }


# ── 오픈 일정 개요(/openings) ──────────────────────────────────────

def overview(session: Session) -> dict:
    now = _now()
    today = now.date()
    rows = _fresh(session, watched_only=True)

    buckets: dict[str, list] = {"today": [], "tomorrow": [], "upcoming": [],
                                "open_now": [], "closed": []}
    for s in rows:
        dt = _parse_open(s.open_at or "")
        d = (dt.date() - today).days if dt else None
        it = _item(s, today)
        if d == 0:
            buckets["today"].append(it)
        elif d == 1:
            buckets["tomorrow"].append(it)
        elif d is not None and 1 < d <= UPCOMING_DAYS:
            buckets["upcoming"].append(it)
        elif s.status == "접수중":
            buckets["open_now"].append(it)
        elif s.status in ("예약마감", "접수종료", "예약일시중지", "안내중"):
            buckets["closed"].append(it)

    for key in ("today", "tomorrow", "upcoming"):
        buckets[key].sort(key=lambda x: (x["open_at"], x["place"], x["facility"]))
    buckets["open_now"].sort(key=lambda x: ((x["region"] or ""), x["place"], x["facility"]))
    buckets["closed"].sort(key=lambda x: ((x["region"] or ""), x["facility"]))

    return {
        "now": now.strftime("%Y-%m-%d %H:%M"),
        "badge": len(buckets["today"]) + len(buckets["tomorrow"]),
        "today": buckets["today"],
        "tomorrow": buckets["tomorrow"],
        "upcoming": buckets["upcoming"],
        "open_now": buckets["open_now"],
        "closed": buckets["closed"],
        "closed_count": len(buckets["closed"]),
        "watched_total": len(rows),
        "watch_regions": sorted(settings.watch_region_set()),
        "watch_keywords": settings.watch_keyword_list(),
    }


# ── 날짜로 코트 찾기(/available) ────────────────────────────────────

def available(session: Session, target: date_cls, part: str | None = None,
              watched_only: bool = True) -> dict:
    """그 날짜(와 시간대)에 '예약 접수가 열려 있는' 코트 후보.

    잔여 자리 확정은 불가(공식 API 한계) — 후보 + 예약 페이지 바로가기까지 제공.
    """
    rows = _fresh(session, watched_only=watched_only)
    is_weekend = target.weekday() >= 5
    today = _now().date()
    out = []
    for s in rows:
        if s.status != "접수중":
            continue
        name = f"{s.facility_name} {s.court_name}"
        # ① 이용 기간: 이름 속 기간(반월/월 표기) 우선, 없으면 SVCOPN 기간
        ref_year = target.year
        period = period_from_name(s.facility_name, ref_year)
        if period:
            if not (period[0] <= target <= period[1]):
                continue
        else:
            try:
                if s.use_from and target < date_cls.fromisoformat(s.use_from[:10]):
                    continue
                if s.use_to and target > date_cls.fromisoformat(s.use_to[:10]):
                    continue
            except ValueError:
                pass
        # ② 요일(평일/주말)
        dt_type = day_type(name)
        if is_weekend and dt_type == "wd":
            continue
        if not is_weekend and dt_type == "we":
            continue
        # ③ 시간대
        if part and part in ("새벽", "주간", "야간"):
            if part not in time_parts(name, s.time_start, s.time_end):
                continue
        out.append(_item(s, today))

    out.sort(key=lambda x: ((x["region"] or ""), x["place"], x["facility"]))
    labels = ["월", "화", "수", "목", "금", "토", "일"]
    return {
        "date": target.isoformat(),
        "weekday": labels[target.weekday()],
        "is_weekend": is_weekend,
        "part": part or "",
        "count": len(out),
        "items": out,
        "note": "잔여 자리는 각 코트의 예약 페이지 달력에서 확인돼요(공식 데이터 제공 범위).",
    }


# ── 알람 판정(전날 d1 · 1시간 전 h1) ───────────────────────────────

def pending_alerts(session: Session) -> list[tuple[str, Slot]]:
    """아직 안 보낸 (kind, slot) 목록. kind: 'd1'(내일 오픈) | 'h1'(1시간 안에 오픈)."""
    now = _now()
    today = now.date()
    sent = {(a.slot_hash, a.open_date, a.kind)
            for a in session.exec(select(OpeningAlert))}
    due: list[tuple[str, Slot]] = []
    for s in _fresh(session, watched_only=True):
        dt = _parse_open(s.open_at or "")
        if not dt:
            continue
        od = dt.date().isoformat()
        d = (dt.date() - today).days
        if d == 1 and (s.slot_hash, od, "d1") not in sent:
            due.append(("d1", s))
        delta = (dt - now).total_seconds()
        if 0 < delta <= 3600 and (s.slot_hash, od, "h1") not in sent:
            due.append(("h1", s))
    return due


def mark_alerted(session: Session, pairs: list[tuple[str, Slot]]) -> None:
    for kind, s in pairs:
        dt = _parse_open(s.open_at or "")
        session.add(OpeningAlert(
            slot_hash=s.slot_hash,
            open_date=dt.date().isoformat() if dt else "",
            kind=kind,
        ))
    session.commit()


def group_for_message(pairs: list[tuple[str, Slot]]) -> list[dict]:
    """메시지용 묶음: (장소, 오픈일시)별 코트 수 — '한남테니스장 21개 코트 내일 09:00'."""
    g: dict[tuple, dict] = {}
    for kind, s in pairs:
        place = (s.court_name or s.facility_name).split(">")[0].strip()
        key = (kind, place, s.open_at)
        if key not in g:
            g[key] = {"kind": kind, "place": place, "region": s.region,
                      "open_at": s.open_at, "count": 0,
                      "reserve_url": s.reserve_url}
        g[key]["count"] += 1
    return sorted(g.values(), key=lambda x: (x["kind"], x["open_at"], x["place"]))

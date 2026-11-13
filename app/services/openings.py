"""예약 '오픈 일정' 엔진 — 관심 코트 스크리닝 + D-5 안내 + 날짜로 코트 찾기 + 알람 판정.

데이터 전제(실측 2026-10-31):
- OA-2266 의 RCPTBGNDT/RCPTENDDT = 예약 접수 시작/끝, SVCOPN*DT = 이용 기간.
- 상태(SVCSTATNM)는 늦게 갱신된다 — 접수 시작 시각이 지났는데 '안내중'으로 남아 있는 일이 흔함
  (한남테니스장 10/31 09:00 오픈분이 16시에도 '안내중'). 그래서 시각으로 실제 상태를 보정한다.
- '예약마감' = 그 회차 자리가 다 참. 반월·월 단위 회차 코트는 이 값으로 날짜별 마감을 알 수 있다.
- 1년 내내 하나로 열린 '상시' 코트(마루공원 등)는 날짜별 남은 자리를 공식 데이터가 주지 않는다.
  예약 사이트 상세 화면은 자동 조회를 막고 경고하므로 수집하지 않는다 → '자리 확인 필요'로 분리.
"""
from __future__ import annotations

import re
from datetime import date as date_cls
from datetime import datetime, timedelta

from sqlmodel import Session, select

from app.clock import now as _now
from app.config import settings
from app.models import OpeningAlert, Slot
from app.services import notice as NOTICE
from app.services import tennisplay as PLAY
from app.services.holidays import holiday_name, is_holiday

UPCOMING_DAYS = 90       # '오픈 예정'으로 보여줄 최대 D-n
SOON_DAYS = 5            # D-5 안내
FRESH_HOURS = 26         # 이 시간 안에 관측된 슬롯만(죽은 행 제외)
EXACT_MAX_DAYS = 62      # 이용 기간이 이보다 짧으면 '날짜용 회차', 길면 '상시'
PARTS = ("새벽", "주간", "야간")
WD_LABEL = ["월", "화", "수", "목", "금", "토", "일"]

NOTICE_SOURCE = "notice"                 # 공지 일정으로 만든 알림(서울시 자료에 그 회차가 아직 없음)
NOTICE_HOT = timedelta(hours=2)          # 공지된 오픈 시각이 지난 뒤 이 시간 동안은 맨 위에서 안내
NOTICE_SLACK = timedelta(days=3)         # 실제 회차가 공지 날짜에서 이만큼 안에 올라와 있으면 그쪽이 정본

REGION_AREA = {"서초구": "서초", "강남구": "강남", "성동구": "성동", "용산구": "용산"}


# ── 관심 코트 스크리닝 ──────────────────────────────────────────────

def is_watched(region: str | None, facility: str, court: str) -> bool:
    """지역(구) 또는 이름 키워드(한남·장충 등)로 '내 코트' 여부 판정."""
    if (region or "") in settings.watch_region_set():
        return True
    name = f"{facility} {court}"
    return any(kw in name for kw in settings.watch_keyword_list())


def _kw_label(kw: str) -> str:
    return kw.removesuffix("테니스장") or kw


def all_areas() -> list[str]:
    """알림 설정에서 고르는 이름(구 이름 앞 두 글자 + 테니스장 키워드의 짧은 이름)."""
    out = [REGION_AREA.get(r, r.removesuffix("구")) for r in sorted(settings.watch_region_set())]
    order = ["서초", "강남", "성동", "용산"]
    out.sort(key=lambda a: order.index(a) if a in order else 99)
    return out + [_kw_label(k) for k in settings.watch_keyword_list() if _kw_label(k) not in out]


def areas_of(region: str | None, facility: str, court: str) -> list[str]:
    areas = []
    if (region or "") in settings.watch_region_set():
        areas.append(REGION_AREA.get(region or "", (region or "").removesuffix("구")))
    name = f"{facility} {court}"
    areas += [_kw_label(kw) for kw in settings.watch_keyword_list()
              if kw in name and _kw_label(kw) not in areas]
    return areas


def _fresh(session: Session, watched_only: bool = True) -> list[Slot]:
    """최근 수집에 실제로 들어 있던 행만. 소스별 마지막 수집 회차(같은 last_seen)보다 오래된 행은
    공식 목록에서 사라진 서비스라 제외한다(26시간 안이라도 옛 상태를 보여주지 않게)."""
    cutoff = _now() - timedelta(hours=FRESH_HOURS)
    rows = list(session.exec(select(Slot).where(Slot.last_seen >= cutoff)))
    from app.services import sync as SYNC
    latest: dict[str, datetime] = {}
    for s in rows:
        if s.source_id not in latest or s.last_seen > latest[s.source_id]:
            latest[s.source_id] = s.last_seen
    for src, at in latest.items():           # 기록된 회차가 있으면 그 회차(같은 last_seen)
        b = SYNC.BATCH.get(src)
        if b is not None and b < at:
            latest[src] = b
    gone = {src for src, at in latest.items()
            if SYNC.EMPTY_OK.get(src) is not None and SYNC.EMPTY_OK[src] > at}
    rows = [s for s in rows if s.source_id not in gone
            and s.last_seen >= latest[s.source_id] - timedelta(seconds=1)]
    if watched_only:
        rows = [s for s in rows if is_watched(s.region, s.facility_name, s.court_name)]
    return rows


# ── 시각 · 상태 보정 ───────────────────────────────────────────────

def _parse_dt(v: str) -> datetime | None:
    try:
        return datetime.strptime((v or "")[:16], "%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        return None


_parse_open = _parse_dt  # 하위호환


UNCONFIRMED = "오픈됨(상태 미갱신)"
OPENING_STATES = ("안내중", UNCONFIRMED, "접수중")   # D-5 안내에 넣는 상태(중지·마감·종료 제외)
# 지금 접수하지 않는 상태 → 화면 구분(마감 / 접수 끝남 / 일시중지 / 열렸지만 상태 미확인)
CLOSED_STATE = {"예약마감": "full", "접수종료": "ended", "예약일시중지": "paused", UNCONFIRMED: "unknown"}


def effective_status(s: Slot, now: datetime) -> str:
    """API 상태를 접수 시작·끝 시각으로 보정한 '지금 상태'.

    접수 시작이 지났는데 공식 상태가 아직 '안내중'이면 '접수중'으로 단정하지 않는다
    (2026-10-31 한남: 09:00 오픈 후 7시간 넘게 '안내중' — 실제로는 오픈 직후 마감).
    """
    st = (s.status or "").strip()
    open_dt, close_dt = _parse_dt(s.open_at), _parse_dt(s.close_at)
    if close_dt and now > close_dt and st in ("접수중", "안내중"):
        return "접수종료"
    if st == "안내중" and open_dt and now >= open_dt:
        return UNCONFIRMED
    if st == "접수중" and open_dt and now < open_dt:
        return "안내중"
    return st


# ── 이름 파싱(요일·시간대·기간) ─────────────────────────────────────

_DAY_WORDS = [("월요일", {0}), ("화요일", {1}), ("수요일", {2}), ("목요일", {3}),
              ("금요일", {4}), ("토요일", {5}), ("일요일", {6})]


def _clause_days(text: str) -> tuple[set[int], bool]:
    """한 구절의 요일 집합과 공휴일 포함 여부. 요일 표기가 없으면 빈 집합."""
    days: set[int] = set()
    hol = False
    if "평일" in text:
        days |= {0, 1, 2, 3, 4}
    if "주말" in text or re.search(r"토\s*[/,.·]\s*일", text):
        days |= {5, 6}
        hol = True
    if "공휴일" in text:
        hol = True
    for w, d in _DAY_WORDS:
        if w in text:
            days |= d
    return days, hol


def _clause_parts(text: str) -> set[str]:
    parts: set[str] = set()
    if "새벽" in text or "심야" in text:
        parts.add("새벽")
    if "주간" in text or "오전" in text or "낮" in text:
        parts.add("주간")
    if "야간" in text or "저녁" in text:
        parts.add("야간")
    return parts


def _hour_parts(time_start: str, time_end: str) -> set[str]:
    def _h(s: str) -> int | None:
        d = "".join(ch for ch in (s or "") if ch.isdigit())
        try:
            return int(d[:2]) if len(d) >= 2 else None
        except ValueError:
            return None

    sh, eh = _h(time_start), _h(time_end)
    if sh is None or eh is None:
        return set(PARTS)
    # 자정을 넘는 운영(22:00-02:00)은 [22,24)·[0,2) 두 구간으로 나눠 본다.
    segs = [(sh, eh)] if eh > sh else [(sh, 24), (0, eh)]
    parts: set[str] = set()
    for a, b in segs:
        if b <= a:
            continue
        if a < 7:
            parts.add("새벽")
        if a <= 17 and b > 8:
            parts.add("주간")
        if b >= 19:
            parts.add("야간")
    return parts or {"주간"}


def day_rules(name: str, time_start: str = "", time_end: str = "") -> list[tuple[set[int], bool, set[str]]]:
    """'월요일 야간 및 주말' → [({0},F,{야간}), ({5,6},T,전체)].

    구절은 '및'으로 나눈다. 요일 없는 구절은 앞 구절 요일을 잇거나(없으면 매일), 시간대 없는
    구절은 운영시간으로 추정한 시간대를 쓴다.
    """
    hour_parts = _hour_parts(time_start, time_end)
    rules: list[tuple[set[int], bool, set[str]]] = []
    for chunk in re.split(r"\s*및\s*", name):
        days, hol = _clause_days(chunk)
        parts = _clause_parts(chunk)
        if not days and not hol:
            if not parts:
                continue
            days = rules[-1][0] if rules else set(range(7))
            hol = rules[-1][1] if rules else True
        rules.append((days, hol, parts or hour_parts))
    if not rules:
        rules.append((set(range(7)), True, hour_parts))
    return rules


def matches_day(name: str, target: date_cls, part: str | None,
                time_start: str = "", time_end: str = "") -> bool:
    holiday = is_holiday(target)
    wd = target.weekday()
    for days, hol, parts in day_rules(name, time_start, time_end):
        if holiday:
            # 공휴일: '공휴일/주말' 구절만. 요일 표기가 아예 없던 코트(매일)도 허용.
            ok = hol or days == set(range(7))
        else:
            ok = wd in days
        if ok and (not part or part in parts):
            return True
    return False


def day_type(name: str) -> str:
    """하위호환: 'wd'(평일) | 'we'(주말·공휴일) | 'both' | 'any'."""
    rules = day_rules(name)
    wd = any(d & {0, 1, 2, 3, 4} for d, _, _ in rules)
    we = any(d & {5, 6} or h for d, h, _ in rules)
    if all(d == set(range(7)) for d, _, _ in rules):
        return "any"
    if wd and we:
        return "both"
    return "wd" if wd else ("we" if we else "any")


def time_parts(name: str, time_start: str, time_end: str) -> set[str]:
    """하위호환: 이름 키워드 우선, 없으면 운영시간으로 추정."""
    return _clause_parts(name) or _hour_parts(time_start, time_end)


# 기간: '10/16~10/31' '11월1일~15일' '11월 1일 ~ 11월 15일' '11.1~11.15'
_RANGE_RE = re.compile(
    r"(\d{1,2})\s*[월/.]\s*(\d{1,2})\s*일?\s*[~∼～]\s*(?:(\d{1,2})\s*[월/.]\s*)?(\d{1,2})\s*일?")
_MONTH_RE = re.compile(r"(?<![\d/.])(\d{1,2})월(?!\s*\d)")


def period_from_name(name: str, ref_year: int) -> tuple[date_cls, date_cls] | None:
    """이름 속 이용 기간을 날짜 범위로. 없으면 None."""
    m = _RANGE_RE.search(name)
    if m:
        m1, d1 = int(m.group(1)), int(m.group(2))
        m2 = int(m.group(3)) if m.group(3) else m1
        d2 = int(m.group(4))
        try:
            start = date_cls(ref_year, m1, d1)
            end_year = ref_year + 1 if (m2, d2) < (m1, d1) else ref_year
            return start, date_cls(end_year, m2, d2)
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


def _iso(v: str) -> date_cls | None:
    try:
        return date_cls.fromisoformat((v or "")[:10])
    except ValueError:
        return None


def use_period(s: Slot) -> tuple[date_cls | None, date_cls | None, bool]:
    """(시작, 끝, 날짜용 회차인가). 이름 기간 → 이용 기간 순으로 본다."""
    uf, ut = _iso(s.use_from), _iso(s.use_to)
    ref = (uf or _now().date()).year
    p = None
    # 이름에는 연도가 없다 → 공식 이용기간과 겹치는 해(전년·같은 해·다음 해)를 고른다.
    # 겹치는 해가 없으면(이름과 공식 기간이 모순) 공식 시작 연도 그대로 둔다.
    for y in (ref, ref - 1, ref + 1):
        cand = period_from_name(s.facility_name, y)
        if cand is None:
            break
        if uf is None or ut is None or (cand[0] <= ut and cand[1] >= uf):
            p = cand
            break
    if p is None:
        p = period_from_name(s.facility_name, ref)
    if p:
        return p[0], p[1], True
    exact = bool(uf and ut and (ut - uf).days <= EXACT_MAX_DAYS)
    return uf, ut, exact


def period_conflict(s: Slot) -> bool:
    """공식 이용기간이 거꾸로이거나(시작>끝), 이름 속 기간이 공식 이용기간과 어느 해로도 겹치지 않으면
    모순 데이터 — 화면 '예약 가능'·오픈 알림에서 뺀다(틀린 날짜를 안내하지 않게)."""
    uf, ut = _iso(s.use_from), _iso(s.use_to)
    if uf and ut and uf > ut:
        return True
    if not (uf and ut):
        return False
    for y in (uf.year, uf.year - 1, uf.year + 1):
        cand = period_from_name(s.facility_name, y)
        if cand is None:
            return False
        if cand[0] <= ut and cand[1] >= uf:
            return False
    return True


# ── 묶음(장소 단위) ────────────────────────────────────────────────

def place_label(s: Slot) -> str:
    segs = [x.strip() for x in (s.court_name or s.facility_name).split(">") if x.strip()]
    if not segs:
        return s.facility_name
    last = re.sub(r"\s*테스트\s*$", "", segs[-1]).strip()
    if last in ("테니스장", "테니스") and len(segs) > 1:
        last = segs[0]
    return last


def _court(s: Slot) -> dict:
    return {"name": s.facility_name, "time": s.time, "is_paid": s.is_paid,
            "status": s.status, "reserve_url": s.reserve_url}


def _md(d: date_cls | None) -> str:
    return f"{d.month}/{d.day}" if d else ""


def _group(slots: list[Slot], exact: bool) -> list[dict]:
    g: dict[str, dict] = {}
    for s in slots:
        key = place_label(s)
        if key not in g:
            uf, ut, _ = use_period(s)
            g[key] = {
                "place": key, "region": s.region,
                "areas": areas_of(s.region, s.facility_name, s.court_name),
                "court_count": 0,
                "period": f"{_md(uf)}~{_md(ut)}" if exact and uf and ut else "상시 예약",
                "time": s.time, "is_paid": s.is_paid, "eligibility": s.eligibility,
                "reserve_url": s.reserve_url, "courts": [],
            }
        e = g[key]
        e["court_count"] += 1
        e["is_paid"] = e["is_paid"] or s.is_paid
        e["courts"].append(_court(s))
    out = list(g.values())
    for e in out:
        e["courts"].sort(key=lambda c: c["name"])
    out.sort(key=lambda e: (e["region"] or "", e["place"]))
    return out


# ── 직렬화 ─────────────────────────────────────────────────────────

def _item(s: Slot, today: date_cls) -> dict:
    dt = _parse_dt(s.open_at)
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

def _ends_before(s: Slot, open_dt: datetime) -> bool:
    """이용기간이 오픈 전에 끝나거나 기간 자체가 모순인 데이터."""
    ut = _iso(s.use_to)
    return bool(ut and ut < open_dt.date()) or period_conflict(s)


def soon_groups(rows: list[Slot], now: datetime, days: int = SOON_DAYS) -> list[dict]:
    """예약 접수가 오늘~D-days 에 열리는 것 — (장소, 오픈 시각)별 묶음."""
    today = now.date()
    g: dict[tuple, dict] = {}
    for s in rows:
        dt = _parse_dt(s.open_at)
        if not dt:
            continue
        d = (dt.date() - today).days
        if not (0 <= d <= days):
            continue
        if effective_status(s, now) not in OPENING_STATES or _ends_before(s, dt):
            continue
        place = place_label(s)
        key = (dt.date(), place)     # 같은 날 같은 장소는 몇 분 차이 오픈도 한 묶음(09:00·09:03)
        if key not in g:
            g[key] = {"open_at": s.open_at, "d_day": d, "opened": dt <= now,
                      "place": place, "region": s.region,
                      "areas": areas_of(s.region, s.facility_name, s.court_name),
                      "court_count": 0, "reserve_url": s.reserve_url, "courts": []}
        e = g[key]
        if s.open_at < e["open_at"]:
            e["open_at"], e["opened"] = s.open_at, dt <= now
        e["court_count"] += 1
        e["courts"].append(_court(s))
    out = sorted(g.values(), key=lambda x: (x["open_at"], x["place"]))
    for e in out:
        e["courts"].sort(key=lambda c: c["name"])
    return out


def overview(session: Session) -> dict:
    now = _now()
    today = now.date()
    rows = _fresh(session, watched_only=True)

    buckets: dict[str, list] = {"today": [], "tomorrow": [], "upcoming": [],
                                "open_now": [], "closed": []}
    for s in rows:
        dt = _parse_dt(s.open_at)
        d = (dt.date() - today).days if dt else None
        st = effective_status(s, now)
        it = _item(s, today)
        it["status"] = st
        if d == 0:
            buckets["today"].append(it)
        elif d == 1:
            buckets["tomorrow"].append(it)
        elif d is not None and 1 < d <= UPCOMING_DAYS:
            buckets["upcoming"].append(it)
        elif st == "접수중":
            buckets["open_now"].append(it)
        elif st in ("예약마감", "접수종료", "예약일시중지", "안내중"):
            buckets["closed"].append(it)

    for key in ("today", "tomorrow", "upcoming"):
        buckets[key].sort(key=lambda x: (x["open_at"], x["place"], x["facility"]))
    buckets["open_now"].sort(key=lambda x: ((x["region"] or ""), x["place"], x["facility"]))
    buckets["closed"].sort(key=lambda x: ((x["region"] or ""), x["facility"]))

    soon = soon_groups(rows, now)
    badge = sum(1 for e in soon if (e["d_day"] == 0 and not e["opened"]) or e["d_day"] == 1)
    from app.services import sync as SYNC
    return {
        "now": now.strftime("%Y-%m-%d %H:%M"),
        "updated_at": SYNC.last_sync(),
        "badge": badge,
        "soon": soon,
        "areas": all_areas(),
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


# ── 코트 단위 이름 ─────────────────────────────────────────────────

# 우선순위 순서대로 찾는다('한남테니스장 10번코트'에서 '테니스장 10'을 먼저 잡지 않게).
_COURT_PATTERNS = [
    (re.compile(r"(\d+)\s*번\s*코트"), "{}번 코트"),
    (re.compile(r"([A-Z])\s*코트"), "{}코트"),
    (re.compile(r"코트\s*(\d+)"), "{}번 코트"),
    (re.compile(r"(\d+)\s*면"), "{}면"),
    (re.compile(r"([A-Z])\s*면"), "{}면"),
    (re.compile(r"테니스장\s*(\d+)"), "{}번 코트"),
    (re.compile(r"\s([A-Z])\s*$"), "{}코트"),
]
_DAY_NAME = {0: "월", 1: "화", 2: "수", 3: "목", 4: "금", 5: "토", 6: "일"}


def court_label(name: str) -> str:
    """'한남테니스장 1번코트 일요일' → '1번 코트', '중랑… 테니스장 B' → 'B코트', '마루… 1면 (조명)' → '1면 조명'."""
    label = "코트"
    for rx, fmt in _COURT_PATTERNS:
        m = rx.search(name)
        if m:
            label = fmt.format(m.group(1))
            break
    if re.search(r"조명(?!쪽)", name):   # '1면 조명쪽'은 코트 위치 이름, 끝의 '조명'이 야간 조명 이용
        label += " 조명"
    return label


def slot_label(name: str) -> str:
    """요일·시간대 조건을 짧은 말로: '월요일 야간 및 주말' → '월 야간 · 주말·공휴일'."""
    out = []
    for chunk in re.split(r"\s*및\s*", name):
        days, hol = _clause_days(chunk)
        parts = _clause_parts(chunk)
        if not days and not hol and not parts:
            continue
        if not days and hol and not parts and "공휴일" in " ".join(out):
            continue   # '주말 및 공휴일' → 이미 '주말·공휴일'
        if days == {0, 1, 2, 3, 4}:
            d = "평일"
        elif days == {5, 6}:
            d = "주말·공휴일" if hol else "주말"
        elif days:
            d = "·".join(_DAY_NAME[x] for x in sorted(days))
        else:
            d = "공휴일" if hol else ""
        p = "·".join(x for x in PARTS if x in parts) if parts and parts != set(PARTS) else ""
        out.append(" ".join(x for x in (d, p) if x))
    return " · ".join(x for x in out if x) or "매일"


# ── 날짜로 코트 찾기(/available, /calendar) ─────────────────────────

# 화면 순서 = 확실한 것부터. key 는 API·화면 공통.
SECTIONS = [
    ("open", "접수중", "공식 상태가 '접수중'인 이 날짜 회차예요. 시간별 남은 자리는 코트를 눌러 예약 화면에서 확인하세요."),
    ("unconfirmed", "오픈됨 · 마감 여부 확인 필요",
     "접수는 시작됐지만 서울시 공식 상태가 아직 바뀌지 않았어요. 인기 코트는 오픈 직후 다 차는 일이 많아요."),
    ("later", "아직 오픈 전", "이 날짜 회차의 예약이 아직 열리지 않았어요. 오픈 시각에 맞춰 들어가세요."),
    ("rolling", "상시 예약 코트 · 자리 확인 필요",
     "1년 내내 열려 있는 코트라 이 날짜 자리가 찼는지는 공식 데이터에 없어요. 코트를 눌러 달력에서 확인하세요."),
    ("full", "예약 마감", "공식 상태가 '예약마감'이에요. 이 회차는 자리가 다 찼어요."),
]
STATE_LABEL = {"open": "접수중", "unconfirmed": "확인 필요", "later": "오픈 전",
               "rolling": "자리 확인", "full": "마감"}


_NAME_YEAR = re.compile(r"(20\d\d)\s*년")


def _classify(rows: list[Slot], target: date_cls, part: str | None, now: datetime) -> dict:
    """그 날짜(·시간대)에 해당하는 코트(=예약 서비스 1건)를 SECTIONS 키별로 나눈다."""
    res: dict[str, list[Slot]] = {k: [] for k, _, _ in SECTIONS}
    if target < now.date():
        return res
    for s in rows:
        if period_conflict(s):
            continue
        uf, ut, exact = use_period(s)
        if uf and target < uf:
            continue
        if ut and target > ut:
            continue
        yr = _NAME_YEAR.search(s.facility_name)
        if yr and int(yr.group(1)) != target.year:   # '서울숲 테니스장 주말 2027년'
            continue
        if not matches_day(s.facility_name, target, part, s.time_start, s.time_end):
            continue
        st = effective_status(s, now)
        if st == "예약마감":
            res["full"].append(s)
        elif st == "접수중":
            res["open" if exact else "rolling"].append(s)
        elif st == UNCONFIRMED:
            res["unconfirmed"].append(s)
        elif st == "안내중":
            res["later"].append(s)
    return res


def _court_item(s: Slot, state: str) -> dict:
    uf, ut, exact = use_period(s)
    return {
        "court": court_label(s.facility_name),
        "slot": slot_label(s.facility_name),
        "name": s.facility_name,
        "time": s.time,
        "is_paid": s.is_paid,
        "eligibility": s.eligibility,
        "period": f"{_md(uf)}~{_md(ut)}" if exact and uf and ut else "상시 예약",
        "state": state,
        "state_label": STATE_LABEL[state],
        "open_at": s.open_at or "",
        "reserve_url": s.reserve_url,
    }


def _court_sort_key(c: dict):
    m = re.match(r"(\d+)", c["court"])
    return (int(m.group(1)) if m else 999, c["court"], c["slot"])


def _places(slots: list[Slot], state: str) -> list[dict]:
    g: dict[str, dict] = {}
    for s in slots:
        key = place_label(s)
        e = g.setdefault(key, {"place": key, "region": s.region,
                               "areas": areas_of(s.region, s.facility_name, s.court_name),
                               "courts": []})
        e["courts"].append(_court_item(s, state))
    out = list(g.values())
    for e in out:
        e["courts"].sort(key=_court_sort_key)
        e["court_count"] = len(e["courts"])
    out.sort(key=lambda e: (e["region"] or "", e["place"]))
    return out


def available(session: Session, target: date_cls, part: str | None = None,
              watched_only: bool = True) -> dict:
    """그 날짜(와 시간대)의 코트를 코트 단위로, 확실한 것부터 섹션별로.

    날짜별 남은 자리는 서울시가 공개하지 않는다(예약 화면 자동 조회는 차단·경고) —
    그래서 '접수중/마감'은 공식 상태, 나머지는 확인 필요로 정직하게 구분한다.
    """
    now = _now()
    rows = _fresh(session, watched_only=watched_only)
    c = _classify(rows, target, part, now)
    sections = []
    for key, title, note in SECTIONS:
        places = _places(c[key], key)
        sections.append({"key": key, "title": title, "note": note, "places": places,
                         "court_count": sum(p["court_count"] for p in places)})
    counts = {sec["key"]: sec["court_count"] for sec in sections}
    from app.services import sync as SYNC
    return {
        "date": target.isoformat(),
        "weekday": WD_LABEL[target.weekday()],
        "is_weekend": target.weekday() >= 5,
        "is_holiday": is_holiday(target),
        "holiday": holiday_name(target),
        "part": part or "",
        "updated_at": SYNC.last_sync(),
        "sections": sections,
        "counts": counts,
        # 하위호환(이전 화면·외부 호출): 장소 묶음
        "exact": _group(c["open"], exact=True),
        "rolling": _group(c["rolling"], exact=False),
        "full": _group(c["full"], exact=True),
        "later": _group(c["later"], exact=True),
        "unconfirmed": _group(c["unconfirmed"], exact=True),
        "count_exact": len({place_label(s) for s in c["open"]}),
        "count_rolling": len({place_label(s) for s in c["rolling"]}),
        "count": counts["open"] + counts["rolling"],
        "items": [_item(s, now.date()) for s in c["open"] + c["rolling"]],
        "note": "날짜별 남은 자리는 서울시가 공개하지 않아요 — 코트를 눌러 예약 화면에서 확인하세요.",
    }


def calendar(session: Session, days: int = 30, watched_only: bool = True) -> dict:
    """날짜별 코트 수(코트 = 예약 서비스 1건) — 섹션 키별."""
    now = _now()
    rows = _fresh(session, watched_only=watched_only)
    start = now.date()
    out = []
    for i in range(max(1, min(days, 62))):
        d = start + timedelta(days=i)
        c = _classify(rows, d, None, now)
        item = {"date": d.isoformat(), "weekday": WD_LABEL[d.weekday()],
                "is_weekend": d.weekday() >= 5, "is_holiday": is_holiday(d),
                "holiday": holiday_name(d)}
        item.update({k: len(v) for k, v in c.items()})
        item["exact"] = item["open"]   # 하위호환
        out.append(item)
    from app.services import sync as SYNC
    return {"start": start.isoformat(), "updated_at": SYNC.last_sync(), "days": out}


# ── 보드(/board): 다음 예약 오픈 → 지금 예약 가능한 코트 번호 ─────────

def short_court(label: str) -> str:
    """'1번 코트' → '1번', 'A코트' → 'A', '1면 조명' 그대로."""
    return label.replace("번 코트", "번").removesuffix("코트").strip() or label


def _chip(s: Slot) -> dict:
    return {"court": short_court(court_label(s.facility_name)), "slot": slot_label(s.facility_name),
            "time": s.time, "is_paid": s.is_paid, "reserve_url": s.reserve_url}


def _chip_key(c: dict):
    m = re.match(r"(\d+)", c["court"])
    return (int(m.group(1)) if m else 999, c["court"], c["slot"])


def _until_label(e: dict) -> str:
    md = f"{int(e['until'][5:7])}/{int(e['until'][8:10])}" if e["until"] else ""
    return (f"{md}까지 이용" if e["until_kind"] == "use"
            else f"{md}까지 접수" if e["until_kind"] == "rcpt" else "상시 예약")


def board(session: Session) -> dict:
    """화면 한 장: ① 곳별 다음 예약 오픈(오늘 열린 것 포함) ② 지금 공식 '접수중'인 코트 번호
    ③ 지금 접수하지 않는 코트(마감·접수 끝남) — 5곳이 빠짐없이 보이고, 마감이어도 들어가 볼 수 있게.

    '지금 예약 가능'은 공식 상태가 접수중이고 이용기간이 끝나지 않은 것만 — 날짜별 남은 자리는
    공식 데이터에 없어서, 번호를 누르면 그 코트 예약 화면에서 날짜를 고른다.
    """
    now = _now()
    today = now.date()
    rows = _fresh(session, watched_only=True)
    order = all_areas()

    def area(s: Slot) -> str:
        a = areas_of(s.region, s.facility_name, s.court_name)
        return a[0] if a else place_label(s)

    def batch_of(uf, ut, exact, dt, cd) -> tuple[str, str, str]:
        """지금 접수 중인 코트를 묶는 회차: (종류, 끝나는 날, 이용 기간 표시).

        날짜용 회차는 이용 끝날까지('use'), 월 단위 접수(선우공원: 이용기간은 1년, 접수는 한 달)는
        접수 마감일까지('rcpt'), 둘 다 아니면 상시('')."""
        if exact and ut:
            return "use", ut.isoformat(), (f"{_md(uf)}~{_md(ut)}" if uf else "")
        if cd and dt and (cd - dt).days <= 45:
            return "rcpt", cd.date().isoformat(), ""
        return "", "", ""

    opens: dict[tuple, dict] = {}
    avail: dict[tuple, dict] = {}     # (곳, 회차) → 지금 접수중인 코트 묶음
    past: dict[str, dict] = {}        # 곳 → {오픈 날짜: 가장 이른 오픈 일시} (회차형만)
    fulls: dict[tuple, int] = {}      # (곳, 회차) → 예약마감 서비스 수(상시 예약은 세지 않음)
    closed: dict[tuple, dict] = {}    # (곳, 회차) → 지금 접수하지 않는 코트 묶음(이번 회차)
    stale: dict[tuple, dict] = {}     # (곳, 회차) → 지난 회차(그 곳에 다른 정보가 없을 때만 가장 최근 것 하나)
    meta: dict[str, dict] = {}        # 곳 → 이름·지역
    for s in rows:
        if period_conflict(s):
            continue
        st = effective_status(s, now)
        uf, ut, exact = use_period(s)
        dt = _parse_dt(s.open_at)
        cd = _parse_dt(s.close_at)
        a = area(s)
        meta.setdefault(a, {"place": place_label(s), "region": s.region})
        # 회차형 = 날짜용 회차이거나 접수 기간이 45일 이하(선우공원처럼 달마다 여는 곳)
        batch = bool(exact or (cd and dt and (cd - dt).days <= 45))
        if dt and dt <= now and batch:
            day = past.setdefault(a, {})
            if dt.date() not in day or s.open_at < day[dt.date()]:
                day[dt.date()] = s.open_at
        bk = batch_of(uf, ut, exact, dt, cd)
        if st == "예약마감" and bk[0] and not (ut and ut < today):
            fulls[(a, bk)] = fulls.get((a, bk), 0) + 1
        ck = CLOSED_STATE.get(st)
        if ck:
            # 지난 회차 = 이용 기간이 끝났거나, (월 단위·상시 예약은) 접수 기간이 끝난 것
            over = bool(ut and ut < today) or (not exact and (ck == "ended" or bool(cd and cd < now)))
            g = (stale if over else closed).setdefault((a, bk), {
                "area": a, "place": place_label(s), "region": s.region, "until": bk[1],
                "until_kind": bk[0], "period": bk[2], "courts": [], "past": over, "_at": ""})
            chip = _chip(s)
            chip["state"] = "ended" if over else ck
            g["courts"].append(chip)
            g["_at"] = max(g["_at"], s.open_at or "")
        if dt and not _ends_before(s, dt) and (
                (st == "안내중" and dt > now) or (st in (UNCONFIRMED, "접수중") and dt.date() == today)):
            yr = _NAME_YEAR.search(s.facility_name)
            period = (f"{_md(uf)}~{_md(ut)}" if exact and uf and ut
                      else f"{yr.group(1)}년 이용분" if yr and int(yr.group(1)) != dt.year else "")
            # 같은 곳·같은 날이어도 열림 여부·이용기간·오픈 시각(15분 단위)이 다르면 다른 회차.
            # (09:00 / 09:03 처럼 몇 분 차이로 등록된 같은 회차는 한 묶음)
            key = (area(s), dt.date(), dt <= now, period, (dt.hour * 60 + dt.minute) // 15)
            e = opens.setdefault(key, {"area": key[0], "place": place_label(s), "region": s.region,
                                       "open_at": s.open_at,
                                       "d_day": (dt.date() - today).days, "opened": dt <= now,
                                       "period": period, "reserve_url": s.reserve_url, "courts": []})
            if s.open_at < e["open_at"]:
                e["open_at"], e["opened"] = s.open_at, dt <= now
            chip = _chip(s)
            # 공식 상태가 '접수중'으로 바뀐 것만 확인된 접수 — 오픈 시각만 지난 것은 미확인
            chip["confirmed"] = st == "접수중"
            e["courts"].append(chip)
        if st == "접수중" and not (ut and ut < today):
            # 같은 곳이어도 회차(이용 기간·접수 마감)가 다르면 따로 묶는다 — 앞 회차 코트가
            # 뒤 회차 기간으로 보이지 않게.
            kind, end, period = bk
            e = avail.setdefault((a, bk), {"area": a, "place": place_label(s), "region": s.region,
                                           "until": end, "until_kind": kind, "period": period,
                                           "courts": []})
            e["courts"].append(_chip(s))

    openings = sorted(opens.values(), key=lambda x: (x["open_at"], order.index(x["area"])
                                                       if x["area"] in order else 99))
    for e in openings:
        e["courts"].sort(key=_chip_key)
        e["court_count"] = len(e["courts"])
    for key, e in avail.items():
        # 같은 회차 가운데 이미 마감된 예약 수 — '나머지 16개 마감'
        e["full_count"] = fulls.get(key, 0)
    available = sorted(avail.values(), key=lambda x: (order.index(x["area"]) if x["area"] in order else 99,
                                                      x["until"] or "9999"))
    for e in available:
        e["courts"].sort(key=_chip_key)
        e["court_count"] = len(e["courts"])
        e["until_label"] = _until_label(e)
    # 접수 중인 코트도 이번 회차 마감 코트도 없는 곳은 가장 최근에 열렸던 지난 회차 하나를 대신 보여 준다
    have = {k[0] for k in avail} | {k[0] for k in closed}
    last: dict[str, dict] = {}
    for (a, _bk), g in stale.items():
        if a not in have and (a not in last or g["_at"] > last[a]["_at"]):
            last[a] = g
    closed_list = sorted([*closed.values(), *last.values()],
                         key=lambda x: (order.index(x["area"]) if x["area"] in order else 99,
                                        x["until"] or "9999"))
    for g in closed_list:
        g.pop("_at")
        g["courts"].sort(key=_chip_key)
        g["court_count"] = len(g["courts"])
        states = {c["state"] for c in g["courts"]}
        g["state"] = states.pop() if len(states) == 1 else "mixed"
        g["until_label"] = _until_label(g)
    # 시설 공지의 정기 오픈 일정 — 서울시 자료에 다음 회차가 아직 안 올라온 곳만 채운다
    rules = NOTICE.rules(session)
    extra = []
    for a in order:
        rule = rules.get(a)
        if not rule:
            continue
        real = [(e["opened"], _parse_dt(e["open_at"]).date()) for e in openings if e["area"] == a]

        def covered(day: date_cls) -> bool:
            # 그날 이미 열렸거나, 그 무렵(사흘 안) 오픈이 서울시 자료에 올라와 있으면 공지 일정은 내지 않는다
            return any(d == day if opened else d <= day + NOTICE_SLACK for opened, d in real)

        base = {"area": a, "place": meta.get(a, {}).get("place", a),
                "region": meta.get(a, {}).get("region") or "", "period": "", "reserve_url": "",
                "courts": [], "court_count": 0, "expected": True, "rule": NOTICE.label(rule)}
        prev = NOTICE.prev_at(rule, now)
        if prev and now - prev < NOTICE_HOT and not covered(prev.date()):
            # 공지된 시각은 지났는데 서울시 자료에 새 회차가 아직 없음 — '열렸다'고 단정하지 않고 알려만 준다
            extra.append({**base, "open_at": prev.strftime("%Y-%m-%d %H:%M"), "d_day": 0, "opened": True})
        t = NOTICE.next_at(rule, now)
        if t and not covered(t.date()):
            extra.append({**base, "open_at": t.strftime("%Y-%m-%d %H:%M"),
                          "d_day": (t.date() - today).days, "opened": False})
    if extra:
        openings = sorted(openings + extra, key=lambda x: (x["open_at"], order.index(x["area"])
                                                           if x["area"] in order else 99))
    nxt = {}
    for e in openings:
        if not e["opened"]:
            nxt.setdefault(e["area"], e)
    places = [{"area": a, "place": meta.get(a, {}).get("place", a),
               "region": meta.get(a, {}).get("region") or "",
               "next_open": nxt[a]["open_at"] if a in nxt else "",
               # 다음 오픈이 서울시 자료의 접수 시작 일시가 아니라 시설 공지의 정기 일정에서 나온 것
               "next_expected": bool(a in nxt and nxt[a].get("expected")),
               "open_rule": NOTICE.label(rules[a]) if a in rules else "",
               "available": sum(x["court_count"] for x in available if x["area"] == a),
               "closed": sum(x["court_count"] for x in closed_list if x["area"] == a),
               # 지난 오픈 일시(최근 것부터 3개) — 다음 회차가 아직 등록 안 됐을 때 참고용
               "past_opens": sorted(past.get(a, {}).values(), reverse=True)[:3]}
              for a in order]
    import time

    from app.services import sync as SYNC
    return {
        "now": now.strftime("%Y-%m-%d %H:%M"),
        # 서버 시계(UTC 기준 밀리초) — 화면이 기기 시계가 틀려도 남은 시간·열림 여부를 맞게 계산하도록
        "now_ms": int(time.time() * 1000),
        "updated_at": SYNC.last_sync(),
        "badge": sum(1 for e in openings if not e["opened"] and e["d_day"] <= 1),
        "areas": order,
        "places": places,
        "openings": openings,
        "available": available,
        "closed": closed_list,
        "note": "날짜·시간별 남은 자리는 서울시가 공개하지 않아요. 번호를 누르면 그 코트 예약 화면에서 날짜를 고르세요.",
    }


# ── 알람 판정(전날 d1 · 1시간 전 h1) ───────────────────────────────

def pending_alerts(session: Session, prefix: str = "") -> list[tuple[str, Slot]]:
    """아직 안 보낸 (kind, slot) 목록. kind: 'd1'(내일 오픈) | 'h1'(1시간 안에 오픈).

    prefix: 채널 구분('' = 카카오, 'p' = 앱 푸시) — 채널마다 따로 1회씩 보낸다.
    """
    now = _now()
    today = now.date()
    sent = {(a.slot_hash, a.open_date, a.kind)
            for a in session.exec(select(OpeningAlert))}
    due: list[tuple[str, Slot]] = []
    real_days: dict[str, set[date_cls]] = {}   # 곳 → 서울시 자료에 올라와 있는 오픈 예정 날짜
    sample: dict[str, Slot] = {}               # 곳 → 이름·지역을 빌려 올 행
    for s in _fresh(session, watched_only=True):
        a = (areas_of(s.region, s.facility_name, s.court_name) or [place_label(s)])[0]
        sample.setdefault(a, s)
        dt = _parse_dt(s.open_at)
        if not dt or effective_status(s, now) != "안내중" or _ends_before(s, dt):
            continue   # 중지·마감·종료, 이용기간이 오픈 전에 끝나는 모순 데이터는 '열린다'고 알리지 않음
        real_days.setdefault(a, set()).add(dt.date())
        od = dt.date().isoformat()
        d = (dt.date() - today).days
        ghost = f"rule:{a}"                    # 같은 오픈을 공지 일정으로 이미 알렸으면 다시 알리지 않는다
        if d == 1 and (s.slot_hash, od, prefix + "d1") not in sent and (ghost, od, prefix + "d1") not in sent:
            due.append(("d1", s))
        delta = (dt - now).total_seconds()
        if (0 < delta <= 3600 and (s.slot_hash, od, prefix + "h1") not in sent
                and (ghost, od, prefix + "h1") not in sent):
            due.append(("h1", s))
    # 시설 공지의 정기 오픈 일정 — 서울시 자료에 그 회차가 아직 안 올라온 곳(한남은 오픈 직전에야 올라온다)
    for a, rule in NOTICE.rules(session).items():
        t = NOTICE.next_at(rule, now)
        base = sample.get(a)
        if not t or base is None:
            continue
        if any(d <= t.date() + NOTICE_SLACK for d in real_days.get(a, ())):
            continue   # 실제 회차가 올라와 있으면 그쪽으로 알린다
        od = t.date().isoformat()
        g = Slot(slot_hash=f"rule:{a}", source_id=NOTICE_SOURCE, tier=1,
                 facility_name=base.facility_name, court_name=base.court_name, region=base.region,
                 date=od, time_start="", time_end="", is_open=False, status="안내중",
                 open_at=t.strftime("%Y-%m-%d %H:%M"), reserve_url=None)
        if (t.date() - today).days == 1 and (g.slot_hash, od, prefix + "d1") not in sent:
            due.append(("d1", g))
        delta = (t - now).total_seconds()
        if 0 < delta <= 3600 and (g.slot_hash, od, prefix + "h1") not in sent:
            due.append(("h1", g))
    # 반포종합운동장(테니스플레이) — 매일 09시에 7일 뒤 날짜가 열린다. 전날 20시 · 1시간 전.
    for kind, at in PLAY.open_alert_times(now):
        od = at.date().isoformat()
        g = Slot(slot_hash=f"play:{PLAY.AREA}", source_id=PLAY.SOURCE, tier=1,
                 facility_name=settings.ttp_place, court_name=settings.ttp_place, region="서초구",
                 date=od, time_start="", time_end="", is_open=False, status="안내중",
                 open_at=at.strftime("%Y-%m-%d %H:%M"), reserve_url=None)
        if (g.slot_hash, od, prefix + kind) not in sent:
            due.append((kind, g))
    return due


def mark_alerted(session: Session, pairs: list[tuple[str, Slot]], prefix: str = "") -> None:
    for kind, s in pairs:
        dt = _parse_dt(s.open_at)
        session.add(OpeningAlert(
            slot_hash=s.slot_hash,
            open_date=dt.date().isoformat() if dt else "",
            kind=prefix + kind,
        ))
    session.commit()


def group_for_message(pairs: list[tuple[str, Slot]]) -> list[dict]:
    """메시지용 묶음: (장소, 오픈일시)별 코트 수 — '한남테니스장 21개 코트 내일 09:00'."""
    g: dict[tuple, dict] = {}
    for kind, s in pairs:
        place = place_label(s)
        dt = _parse_dt(s.open_at)
        # 09:00 / 09:03 처럼 몇 분 차이로 등록된 같은 회차는 한 묶음(화면과 같은 15분 기준)
        key = (kind, place, dt.date(), (dt.hour * 60 + dt.minute) // 15) if dt else (kind, place, s.open_at)
        if key not in g:
            play = s.source_id == PLAY.SOURCE
            g[key] = {"kind": kind, "place": place, "region": s.region,
                      "areas": [PLAY.AREA] if play else areas_of(s.region, s.facility_name, s.court_name),
                      "open_at": s.open_at, "count": 0,
                      "reserve_url": s.reserve_url,
                      # 서울시 자료가 아니라 시설 공지의 정기 일정으로 알리는 것
                      "expected": s.source_id == NOTICE_SOURCE,
                      # 반포: 그 알림을 고른 기기에만 보내고, 어느 날짜 이용분이 열리는지 덧붙인다
                      "opt_in": play, "note": PLAY.open_note(dt) if play and dt else ""}
        e = g[key]
        e["count"] += 1
        if s.open_at < e["open_at"]:
            e["open_at"] = s.open_at
        if s.source_id != NOTICE_SOURCE:
            e["expected"] = False
            e["reserve_url"] = e["reserve_url"] or s.reserve_url
    return sorted(g.values(), key=lambda x: (x["kind"], x["open_at"], x["place"]))

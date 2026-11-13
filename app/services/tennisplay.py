"""테니스플레이(thetennisplay.com) — 반포종합운동장 빈 시간 조회(읽기 전용).

테니스플레이는 회원 로그인 뒤에만 예약 현황을 보여 준다. 그래서 설정해 둔 계정(TTP_EMAIL / TTP_PASSWORD)으로
로그인해 '이미 예약된 시간'만 읽고, 코트 운영 시간에서 그 시간을 뺀 나머지를 빈 시간으로 계산한다
(테니스플레이 화면이 하는 계산과 같다).

지키는 것
  · 조회만 한다 — 예약·결제·취소 요청은 보내지 않는다.
  · 이름·연락처는 저장도 표시도 하지 않는다(코트 번호와 시간만 쓴다).
  · 드물게 읽는다 — 정해진 주기(기본 10분), 밤(01~06시)에는 쉬고, 실패하면 간격을 늘린다.
  · 응답 모양이 예상과 다르면 '빈 시간'을 지어내지 않고 실패로 처리한다.
계정이 설정되지 않은 서버에서는 아무 것도 하지 않는다.
"""
from __future__ import annotations

import asyncio
import logging
import re
from collections import Counter
from datetime import date as date_cls
from datetime import datetime, timedelta

import httpx

from app.clock import now as _now
from app.config import settings

logger = logging.getLogger("tennis.play")

OPEN_HOUR = 9                         # 7일 뒤 날짜는 매일 이 시각에 열린다(테니스플레이 화면의 날짜 선택 규칙)
AHEAD_DAYS = 7
QUIET = (1, 6)                        # 01:00~05:59 에는 읽지 않는다
PAUSE = 1.0                           # 날짜별로 따로 물을 때 요청 사이 간격(초)
VERIFY_EVERY = timedelta(hours=24)    # '여러 날짜를 한 번에' 방식이 맞는지 다시 확인하는 주기
STALE = timedelta(minutes=45)         # 이보다 오래된 결과는 화면에서 '오래됨'으로 표시
MAX_BACKOFF = timedelta(hours=2)
UA = "CourtOpen/1.0 (read-only availability viewer)"
TRANSPORT: httpx.AsyncBaseTransport | None = None   # 테스트에서 가짜 서버를 끼운다

# 알림 — 반포 알림은 그것을 고른 기기에만 보낸다(다른 곳과 달리 매일 열려서 알림이 잦다).
AREA = "반포"                         # 알림 설정 이름: 예약 오픈 예고(전날 저녁 · 1시간 전)
AREA_FREE = "반포 빈 시간"            # 알림 설정 이름: 빈 시간이 새로 생기면
SOURCE = "tennisplay"
EVE_HOUR = 20                         # 오픈 예고는 전날 이 시각부터(매일 09시에 열리므로 아침이 아니라 저녁에)
FREE_COOLDOWN = timedelta(hours=3)    # 같은 칸이 비었다 찼다 해도 이 시간 안에는 다시 알리지 않는다
WD = ["월", "화", "수", "목", "금", "토", "일"]

Busy = dict[tuple[str, str], list[tuple[float, float]]]   # (코트 id, 날짜) → [(시작, 끝), …]


class PlayError(Exception):
    """조회 실패. code: login | auth | facility | shape | http"""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code} {detail}".strip())
        self.code = code


class _State:
    def __init__(self) -> None:
        self.token = ""
        self.facility: dict | None = None        # {"id": 3, "name": "반포종합운동장 테니스장"}
        self.snapshot: dict | None = None        # {"at", "courts", "busy", "dates"}
        self.error = ""                          # 마지막 실패 종류(성공하면 빈 문자열)
        self.fails = 0
        self.retry_at: datetime | None = None    # 실패 뒤 이 시각 전에는 다시 시도하지 않는다
        self.combined: bool | None = None        # 여러 날짜를 한 번에 물어도 되는지(None = 아직 확인 못 함)
        self.combined_checked: datetime | None = None
        self.diag: dict = {}                     # 항목 이름·건수만(값·개인정보 없음)
        self.pending: dict = {}                  # 새로 생긴 빈 칸(아직 안 알린 것): (날짜, 시작, 코트 id) → 내용
        self.alerted: dict = {}                  # 알린 칸 → 알린 시각(같은 칸 되풀이 방지)
        self.free_day = ("", 0)                  # (날짜, 그날 보낸 빈 시간 알림 수)


S = _State()
_LOCK = asyncio.Lock()


def reset() -> None:
    """상태 초기화(테스트용)."""
    global S
    S = _State()


def ready() -> bool:
    return bool(settings.ttp_email.strip() and settings.ttp_password)


# ── 응답 읽기 ──────────────────────────────────────────────────────

def _g(d: dict, key: str):
    """snake_case 로 오든 camelCase 로 오든 읽는다."""
    if key in d:
        return d[key]
    head, *rest = key.split("_")
    return d.get(head + "".join(p.title() for p in rest))


def _hour(v) -> float | None:
    """'18' · '18.5' · '18:30' → 18.0 · 18.5 · 18.5"""
    try:
        s = str(v).strip()
        if ":" in s:
            h, m = s.split(":")[:2]
            return int(h) + int(m) / 60
        return float(s)
    except (TypeError, ValueError):
        return None


def court_label(name) -> str:
    """'1번 코트' · '코트 1' · '1' → '1번'. 숫자만으로 정리되지 않는 이름은 그대로 둔다."""
    raw = re.sub(r"\s+", " ", str(name or "")).strip()
    core = re.sub(r"(?i)코트|court|번|면", "", raw).strip()
    if core.isdigit():
        return f"{int(core)}번"
    return raw or "?"


def parse_courts(raw) -> list[dict]:
    out = []
    for c in raw if isinstance(raw, list) else []:
        if not isinstance(c, dict):
            raise PlayError("shape", "court")
        cid, start, end = _g(c, "id"), _hour(_g(c, "use_start_time")), _hour(_g(c, "use_end_time"))
        if cid is None or start is None or end is None or end <= start:
            raise PlayError("shape", "court")
        try:
            div = int(_g(c, "num_of_hour_divided") or 1)
        except (TypeError, ValueError):
            div = 1
        out.append({"id": str(cid), "label": court_label(_g(c, "court_name")),
                    "start": int(start), "end": int(end), "step": 1 / max(div, 1)})
    if not out:
        raise PlayError("shape", "no courts")
    out.sort(key=lambda c: (int(c["id"]) if c["id"].isdigit() else 10**9, c["id"]))
    return out


def parse_busy(raw, days: set[str]) -> Busy:
    """예약된(예약할 수 없는) 시간. 읽을 수 없는 항목이 하나라도 있으면 실패 — 빈 시간으로 잘못 보이지 않게."""
    out: Busy = {}
    kinds: Counter = Counter()
    for b in raw if isinstance(raw, list) else []:
        if not isinstance(b, dict):
            raise PlayError("shape", "booking")
        kind = str(_g(b, "booking_type") or "")
        kinds[kind or "?"] += 1
        if kind == "open":
            continue
        cid, day = _g(b, "court_id"), str(_g(b, "booking_date") or "")[:10]
        s, e = _hour(_g(b, "start_time")), _hour(_g(b, "end_time"))
        if cid is None or len(day) != 10 or s is None or e is None or e <= s:
            raise PlayError("shape", "booking")
        if day in days:
            out.setdefault((str(cid), day), []).append((s, e))
    S.diag["booking_types"] = dict(kinds)
    return out


# ── 날짜 · 빈 시간 계산 ────────────────────────────────────────────

def selectable_dates(now: datetime) -> list[date_cls]:
    """회원이 고를 수 있는 날짜: 오늘부터 6일 뒤까지, 09시가 지나면 7일 뒤까지."""
    last = AHEAD_DAYS if now.hour >= OPEN_HOUR else AHEAD_DAYS - 1
    return [now.date() + timedelta(days=i) for i in range(last + 1)]


def next_open(now: datetime) -> tuple[date_cls, datetime]:
    """다음에 새로 열리는 날짜와 그 시각."""
    at = now.replace(hour=OPEN_HOUR, minute=0, second=0, microsecond=0)
    if now.hour < OPEN_HOUR:
        return now.date() + timedelta(days=AHEAD_DAYS), at
    return now.date() + timedelta(days=AHEAD_DAYS + 1), at + timedelta(days=1)


def build_days(courts: list[dict], busy: Busy, dates: list[date_cls], now: datetime) -> list[dict]:
    """날짜별 빈 시간: [{date, slots: [{s, e, courts: ['3번', …]}]}]. 오늘은 지금 시각의 칸부터."""
    eps = 1e-9
    now_h = now.hour + now.minute / 60
    days = []
    for d in dates:
        key = d.isoformat()
        cells: dict[tuple[float, float], list[str]] = {}
        for c in courts:
            taken = busy.get((c["id"], key), [])
            t = float(c["start"])
            while t < c["end"] - eps:
                e = t + c["step"]
                past = d == now.date() and (t < now.hour or e <= now_h + eps)
                if not past and not any(s < e - eps and x > t + eps for s, x in taken):
                    cells.setdefault((round(t, 3), round(e, 3)), []).append(c["label"])
                t = e
        days.append({"date": key,
                     "slots": [{"s": s, "e": e, "courts": names} for (s, e), names in sorted(cells.items())]})
    return days


# ── 알림: 새로 생긴 빈 시간 · 예약 오픈 예고 ───────────────────────

def free_cells(courts: list[dict], busy: Busy, dates: list[date_cls]) -> dict[tuple, dict]:
    """비어 있는 칸 전부: (날짜, 시작, 코트 id) → {date, s, e, court, n}. 지난 시간도 거르지 않는다."""
    eps = 1e-9
    out: dict[tuple, dict] = {}
    for d in dates:
        key = d.isoformat()
        for n, c in enumerate(courts):
            taken = busy.get((c["id"], key), [])
            t = float(c["start"])
            while t < c["end"] - eps:
                e = t + c["step"]
                if not any(s < e - eps and x > t + eps for s, x in taken):
                    out[(key, round(t, 3), c["id"])] = {"date": key, "s": round(t, 3), "e": round(e, 3),
                                                       "court": c["label"], "n": n}
                t = e
    return out


def _note_new_free(prev: dict | None, courts: list[dict], busy: Busy, dates: list[date_cls],
                   now: datetime) -> None:
    """지난번에는 예약돼 있던 칸이 지금 비어 있으면 '새로 생긴 빈 시간'으로 적어 둔다.

    처음 읽은 것(견줄 지난번이 없음), 오늘 09시에 새로 열린 날짜, 코트 구성이 바뀐 경우는 넣지 않는다.
    """
    if not prev or [c["id"] for c in prev["courts"]] != [c["id"] for c in courts]:
        return
    seen = set(prev["dates"])
    old = free_cells(prev["courts"], prev["busy"], prev["dates"])
    for key, item in free_cells(courts, busy, [d for d in dates if d in seen]).items():
        if key in old or key in S.pending:
            continue
        last = S.alerted.get(key)
        if last and now - last < FREE_COOLDOWN:
            continue
        S.pending[key] = item


def take_new_free(now: datetime | None = None) -> list[dict]:
    """알릴 '새로 생긴 빈 시간'을 꺼낸다 — 지금도 비어 있고 아직 시작 전인 칸만. 꺼내면 비운다."""
    now = now or _now()
    snap = S.snapshot
    items: list[dict] = []
    if snap and S.pending:
        cur = free_cells(snap["courts"], snap["busy"], snap["dates"])
        today, now_h = now.date().isoformat(), now.hour + now.minute / 60
        for key, item in S.pending.items():
            if key not in cur:
                continue                                   # 그사이 다시 예약됨
            if item["date"] < today or (item["date"] == today and item["s"] <= now_h):
                continue                                   # 이미 시작했거나 지난 시간
            items.append(item)
            S.alerted[key] = now
    S.pending = {}
    for key in [k for k, t in S.alerted.items() if now - t >= FREE_COOLDOWN]:
        del S.alerted[key]
    return sorted(items, key=lambda x: (x["date"], x["s"], x["n"]))


def free_budget(now: datetime | None = None) -> bool:
    """하루에 보내는 빈 시간 알림 수를 제한한다. 보낼 수 있으면 한 번 센 뒤 True."""
    day = (now or _now()).date().isoformat()
    used = S.free_day[1] if S.free_day[0] == day else 0
    if used >= max(settings.ttp_free_daily_max, 0):
        return False
    S.free_day = (day, used + 1)
    return True


def _span(s: float, e: float) -> str:
    def hm(v: float) -> tuple[int, int]:
        m = round(v * 60)
        return m // 60, m % 60
    (h1, m1), (h2, m2) = hm(s), hm(e)
    return f"{h1}:{m1:02d}~{h2}:{m2:02d}" if m1 or m2 else f"{h1}~{h2}시"


def _day_label(iso: str) -> str:
    d = date_cls.fromisoformat(iso)
    return f"{d.month}.{d.day}({WD[d.weekday()]})"


def _court_names(names: list[str]) -> str:
    if all(n.endswith("번") for n in names):
        return "·".join(n[:-1] for n in names) + "번 코트"
    return ", ".join(names)


def free_message(items: list[dict], limit: int = 4) -> tuple[str, str]:
    """알림 제목과 내용: '반포 빈 시간이 생겼어요' / '11.16(월) 14~15시 · 3번 코트' …"""
    groups: dict[tuple, list[str]] = {}
    for it in items:
        groups.setdefault((it["date"], it["s"], it["e"]), []).append(it["court"])
    lines = [f"{_day_label(d)} {_span(s, e)} · {_court_names(names)}"
             for (d, s, e), names in sorted(groups.items())]
    more = len(lines) - limit
    body = "\n".join(lines[:limit] + ([f"외 {more}건"] if more > 0 else []))
    return "반포 빈 시간이 생겼어요", body


def open_alert_times(now: datetime) -> list[tuple[str, datetime]]:
    """지금 보낼 반포 예약 오픈 예고: [('d1' | 'h1', 오픈 일시)].

    매일 09시에 7일 뒤 날짜가 열린다. d1 = 전날 20시부터 그날이 끝나기 전까지, h1 = 오픈 1시간 전부터.
    """
    if not (ready() and settings.ttp_notify_open):
        return []
    _, at = next_open(now)
    out: list[tuple[str, datetime]] = []
    if 0 < (at - now).total_seconds() <= 3600:
        out.append(("h1", at))
    if now.date() == at.date() - timedelta(days=1) and now.hour >= EVE_HOUR:
        out.append(("d1", at))
    return out


def open_note(at: datetime) -> str:
    """그 오픈으로 열리는 이용 날짜 — '11.21(토) 이용분'."""
    return f"{_day_label((at.date() + timedelta(days=AHEAD_DAYS)).isoformat())} 이용분"


def open_badge(now: datetime | None = None) -> int:
    """앱 아이콘 숫자에 더할 값: 오픈 전날 20시부터 열릴 때(09시)까지 1, 그 밖에는 0."""
    if not (ready() and settings.ttp_notify_open):
        return 0
    now = now or _now()
    _, at = next_open(now)
    return 1 if at - timedelta(hours=24 - EVE_HOUR + OPEN_HOUR) <= now < at else 0


# ── 테니스플레이 호출 ──────────────────────────────────────────────

def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=settings.ttp_api_base.rstrip("/"), transport=TRANSPORT,
                             timeout=httpx.Timeout(15.0, connect=8.0),
                             headers={"User-Agent": UA, "Accept": "application/json"})


async def _login(client: httpx.AsyncClient) -> None:
    body = {"provider": "email",
            "user_params": {"email": settings.ttp_email.strip(), "password": settings.ttp_password}}
    try:
        r = await client.post("/users/sso_sessions", json=body)
    except httpx.HTTPError as e:
        raise PlayError("http", type(e).__name__) from None
    if r.status_code >= 500:
        raise PlayError("http", f"login {r.status_code}")
    if r.status_code >= 400:
        raise PlayError("login", str(r.status_code))
    try:
        token = (r.json() or {}).get("access_token")
    except ValueError:
        token = None
    if not token:
        raise PlayError("login", "no token")
    S.token = str(token)


async def _get(client: httpx.AsyncClient, path: str, params=None):
    for attempt in (0, 1):
        if not S.token:
            await _login(client)
        try:
            r = await client.get(path, params=params, headers={"Authorization": f"Bearer {S.token}"})
        except httpx.HTTPError as e:
            raise PlayError("http", type(e).__name__) from None
        if r.status_code in (401, 403):
            S.token = ""
            if attempt == 0:
                continue            # 토큰이 만료됐을 수 있다 — 한 번만 다시 로그인
            raise PlayError("auth", str(r.status_code))
        if r.status_code >= 400:
            raise PlayError("http", f"{path} {r.status_code}")
        try:
            return r.json()
        except ValueError:
            raise PlayError("shape", "not json") from None
    raise PlayError("auth")


async def _facility(client: httpx.AsyncClient) -> dict:
    if S.facility:
        return S.facility
    data = await _get(client, "/facilities/")
    items = data.get("facilities") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise PlayError("shape", "facilities")
    names = [str(_g(f, "facility_name") or "") for f in items if isinstance(f, dict)]
    S.diag["facilities"] = names[:60]             # 시설 이름(공개 정보)만 — 이름이 달라 못 찾을 때 확인용
    kw = settings.ttp_facility_keyword.strip()
    for f in items:
        if isinstance(f, dict) and kw and kw in str(_g(f, "facility_name") or "") and _g(f, "id") is not None:
            S.facility = {"id": _g(f, "id"), "name": str(_g(f, "facility_name")).strip()}
            return S.facility
    raise PlayError("facility", kw)


async def _range(client: httpx.AsyncClient, fid, dates: list[date_cls]) -> tuple[list[dict], Busy]:
    params = [("facility_id", str(fid))] + [("date_array[]", d.isoformat()) for d in dates]
    data = await _get(client, "/bookings/player_bookings_in_range", params)
    if not isinstance(data, dict) or not isinstance(data.get("bookings"), list) \
            or not isinstance(data.get("courts"), list):
        S.diag["keys"] = sorted(map(str, data))[:20] if isinstance(data, dict) else type(data).__name__
        raise PlayError("shape", "range")
    return parse_courts(data["courts"]), parse_busy(data["bookings"], {d.isoformat() for d in dates})


def _norm(busy: Busy) -> dict:
    return {k: sorted(v) for k, v in busy.items() if v}


async def _collect(client: httpx.AsyncClient, fid, dates: list[date_cls], now: datetime) -> tuple[list[dict], Busy]:
    """예약된 시간 읽기. 테니스플레이 화면처럼 날짜별로 묻는 것이 기준이고,
    '여러 날짜를 한 번에' 물은 결과가 그것과 똑같다고 확인되면 그 뒤로는 한 번만 묻는다(요청 수 1/8)."""
    checked = S.combined_checked and now - S.combined_checked < VERIFY_EVERY
    if S.combined and checked:
        return await _range(client, fid, dates)
    courts: list[dict] = []
    busy: Busy = {}
    for i, d in enumerate(dates):
        if i:
            await asyncio.sleep(PAUSE)
        c, b = await _range(client, fid, [d])
        courts = courts or c
        busy.update(b)
    if not checked and len(dates) > 1:
        S.combined_checked = now
        try:
            await asyncio.sleep(PAUSE)
            c2, b2 = await _range(client, fid, dates)
            same = _norm(b2) == _norm(busy) and [c["id"] for c in c2] == [c["id"] for c in courts]
            # 예약이 있는 날이 둘 이상이어야 '둘째 날짜부터 무시됐는지'를 가려낼 수 있다
            S.combined = bool(same and len({k[1] for k, v in busy.items() if v}) >= 2)
        except PlayError:
            S.combined = False
    return courts, busy


async def refresh(force: bool = False) -> bool:
    """한 번 읽어 와 기억해 둔다. 성공하면 True. 어떤 예외도 밖으로 던지지 않는다."""
    if not ready():
        return False
    async with _LOCK:
        now = _now()
        if not force:
            if QUIET[0] <= now.hour < QUIET[1]:
                return False
            if S.retry_at and now < S.retry_at:
                return False
        try:
            async with _client() as client:
                fac = await _facility(client)
                dates = selectable_dates(now)
                courts, busy = await _collect(client, fac["id"], dates, now)
        except PlayError as e:
            _failed(e.code, str(e), now)
            return False
        except Exception as e:  # noqa: BLE001  수집 한 번의 실패가 서버를 멈추지 않게
            _failed("http", type(e).__name__, now)
            return False
        _note_new_free(S.snapshot, courts, busy, dates, now)
        S.snapshot = {"at": now, "courts": courts, "busy": busy, "dates": dates}
        S.error, S.fails, S.retry_at = "", 0, None
        logger.info("테니스플레이 %s: 코트 %d면 · %d일치 (%s)", fac["name"], len(courts), len(dates),
                    "한 번에" if S.combined else "날짜별")
        return True


def _failed(code: str, detail: str, now: datetime) -> None:
    S.error = code
    S.fails += 1
    step = timedelta(minutes=max(settings.ttp_interval_minutes, 5)) * (2 ** min(S.fails - 1, 5))
    if code in ("login", "auth", "facility"):      # 다시 해도 같을 실패 — 계정이 잠기지 않게 넉넉히 쉰다
        step = max(step, timedelta(minutes=30))
    S.retry_at = now + min(step, MAX_BACKOFF)
    logger.warning("테니스플레이 조회 실패(%s) — %s 이후 다시 시도", detail, S.retry_at.strftime("%H:%M"))


# ── 화면용 ─────────────────────────────────────────────────────────

def public() -> dict | None:
    """화면(/board)에 실을 내용. 계정이 설정되지 않았으면 None(화면에 아무 것도 안 나옴)."""
    if not ready():
        return None
    now = _now()
    odate, oat = next_open(now)
    base = {"place": (S.facility or {}).get("name") or settings.ttp_place,
            "url": settings.ttp_booking_url,
            "next_open": {"date": odate.isoformat(), "at": oat.strftime("%Y-%m-%d %H:%M")},
            # 알림: 이 서버가 보내는 반포 알림 종류와, 그 알림을 켠 기기의 앱 아이콘에 더할 숫자
            "alerts": {"open": settings.ttp_notify_open, "free": settings.ttp_notify_free},
            "badge": open_badge(now)}
    snap = S.snapshot
    if not snap:
        return {**base, "ok": False, "state": "error" if S.error else "loading", "days": []}
    allowed = set(selectable_dates(now))
    dates = [d for d in snap["dates"] if d in allowed]
    return {**base, "ok": True,
            "updated_at": snap["at"].strftime("%Y-%m-%d %H:%M:%S"),
            "stale": now - snap["at"] > STALE,
            "courts": [c["label"] for c in snap["courts"]],
            "days": build_days(snap["courts"], snap["busy"], dates, now)}


def status() -> dict:
    """점검용(비밀·개인정보 없음): 설정 여부, 마지막 성공 시각, 실패 종류, 읽은 항목 이름·건수."""
    snap = S.snapshot
    return {"configured": ready(),
            "ok": bool(snap) and not S.error,
            "updated_at": snap["at"].strftime("%Y-%m-%d %H:%M:%S") if snap else "",
            "error": S.error,
            "retry_at": S.retry_at.strftime("%Y-%m-%d %H:%M") if S.retry_at else "",
            "mode": "combined" if S.combined else "per-date",
            "facility": (S.facility or {}).get("name", ""),
            "courts": [c["label"] for c in snap["courts"]] if snap else [],
            "hours": sorted({(c["start"], c["end"], c["step"]) for c in snap["courts"]}) if snap else [],
            "busy_cells": sum(len(v) for v in snap["busy"].values()) if snap else 0,
            "free_alerts_today": S.free_day[1] if S.free_day[0] == _now().date().isoformat() else 0,
            "free_pending": len(S.pending),
            "diag": S.diag}

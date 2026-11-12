"""시설 공지에 적힌 '정기 예약 오픈 일정'(매월 며칠 몇 시)을 읽어 다음 오픈 일시를 계산한다.

출처는 서울시 공개 API(OA-2266)가 주는 상세 안내문(DTLCONT)뿐이다 — 예약 사이트에는 접속하지 않는다.
  한남: '오픈 일시: 매월 말일 09:00 / 매월 15일 09:00'
  장충: '(매달 10일, 25일 오전 10시 예약 오픈)'
'매월/매달'과 '오픈'이 같은 줄에 있고 날짜·시각이 모두 읽힐 때만 일정으로 본다(추측하지 않는다).
서울시 자료에 그 회차가 실제로 올라오면(접수 시작 일시) 그쪽이 정본이고, 이 일정은 그 전까지의 안내다.
"""
from __future__ import annotations

import html
import json
import logging
import re
from calendar import monthrange
from collections import Counter
from datetime import datetime, timedelta
from functools import lru_cache

from sqlmodel import Session, select

from app.clock import now as _now
from app.models import OpenRule

logger = logging.getLogger("tennis.notice")

LAST = 99                      # '말일'
Rule = tuple[tuple[int, str], ...]   # ((날, 'HH:MM'), …) — 날 99 = 말일

_BREAK = re.compile(r"(?i)<br\s*/?>|</(p|div|li|tr|td|h\d)>")
_TAG = re.compile(r"<[^>]+>")
_MONTHLY = re.compile(r"매월|매달")
_TOKEN = re.compile(
    r"(?P<last>말일|마지막\s*날)"
    r"|(?P<day>\d{1,2})\s*일(?!\s*(?:전|후|이내|간|최대|마다|까지))"
    r"|(?P<hm>\d{1,2}):(?P<hm_m>\d{2})"
    r"|(?:(?P<ampm>오전|오후)\s*)?(?P<h>\d{1,2})\s*시(?!간)(?:\s*(?P<m>\d{1,2})\s*분)?")


def _lines(raw: str) -> list[str]:
    text = html.unescape(_TAG.sub(" ", _BREAK.sub("\n", raw or "")))
    return [re.sub(r"[ \t\xa0]+", " ", ln).strip() for ln in text.split("\n") if ln.strip()]


@lru_cache(maxsize=256)
def parse(raw: str) -> Rule:
    """안내문에서 정기 오픈 일정을 읽는다. 못 읽으면 빈 튜플."""
    for line in _lines(raw):
        m = _MONTHLY.search(line)
        if not m or "오픈" not in line:
            continue
        days: list[int] = []          # 아직 시각이 안 붙은 날
        out: dict[int, str] = {}
        last_time = ""
        for t in _TOKEN.finditer(line, m.start()):
            if t.group("last"):
                days.append(LAST)
            elif t.group("day"):
                d = int(t.group("day"))
                if 1 <= d <= 31:
                    days.append(d)
            else:
                if t.group("hm"):
                    hh, mm = int(t.group("hm")), int(t.group("hm_m"))
                else:
                    hh, mm = int(t.group("h")), int(t.group("m") or 0)
                    if t.group("ampm") == "오후" and hh < 12:
                        hh += 12
                if not (0 <= hh <= 23 and 0 <= mm <= 59):
                    continue
                last_time = f"{hh:02d}:{mm:02d}"
                for d in days:
                    out.setdefault(d, last_time)
                days = []
        for d in days:                # '10일, 25일 … 10시' 처럼 시각이 앞에만 있던 경우
            if last_time:
                out.setdefault(d, last_time)
        if out:
            return tuple(sorted(out.items()))
    return ()


def label(rule: Rule) -> str:
    """'매월 15일·말일 09:00' — 시각이 날마다 다르면 '매월 10일 10:00 · 25일 14:00'."""
    if not rule:
        return ""
    name = lambda d: "말일" if d == LAST else f"{d}일"   # noqa: E731
    times = {t for _d, t in rule}
    if len(times) == 1:
        return f"매월 {'·'.join(name(d) for d, _t in rule)} {times.pop()}"
    return "매월 " + " · ".join(f"{name(d)} {t}" for d, t in rule)


def _occurrences(rule: Rule, year: int, month: int) -> list[datetime]:
    end = monthrange(year, month)[1]
    out = []
    for d, t in rule:
        day = end if d == LAST else d
        if day > end:                 # 2월 30일 같은 없는 날은 건너뛴다
            continue
        out.append(datetime(year, month, day, int(t[:2]), int(t[3:5])))
    return out


def _around(rule: Rule, now: datetime) -> list[datetime]:
    first = now.replace(day=1)
    months = [(first - timedelta(days=1)), first, (first + timedelta(days=32)), (first + timedelta(days=63))]
    return sorted({o for m in months for o in _occurrences(rule, m.year, m.month)})


def next_at(rule: Rule, now: datetime) -> datetime | None:
    """지금보다 뒤에 오는 가장 가까운 오픈 일시."""
    return next((o for o in _around(rule, now) if o > now), None)


def prev_at(rule: Rule, now: datetime) -> datetime | None:
    """지금까지 지난 가장 최근 오픈 일시."""
    past = [o for o in _around(rule, now) if o <= now]
    return past[-1] if past else None


# ── 저장(곳마다 한 줄) ─────────────────────────────────────────────

def rules(session: Session) -> dict[str, Rule]:
    out: dict[str, Rule] = {}
    for r in session.exec(select(OpenRule)):
        try:
            rule = tuple((int(d), str(t)) for d, t in json.loads(r.rule or "[]"))
        except (ValueError, TypeError):
            continue
        if rule:
            out[r.area] = rule
    return out


def update(session: Session, slots: list) -> None:
    """이번 수집분의 안내문에서 곳별 일정을 다시 읽어 저장한다(커밋은 호출한 쪽).

    같은 곳의 예약 서비스가 서로 다른 일정을 적어 두었으면 가장 많이 적힌 것을 쓴다.
    이번 수집에 그 곳이 있는데 일정이 하나도 안 읽히면(공지에서 빠짐) 저장된 일정을 지운다.
    """
    from app.services import openings as OP
    found: dict[str, Counter] = {}
    seen: set[str] = set()
    for ns in slots:
        raw = getattr(ns, "raw", None) or {}
        if "DTLCONT" not in raw:
            continue
        areas = OP.areas_of(ns.region, ns.facility_name, ns.court_name)
        if not areas:
            continue
        seen.add(areas[0])
        rule = parse(str(raw.get("DTLCONT") or ""))
        if rule:
            found.setdefault(areas[0], Counter())[rule] += 1
    if not seen:
        return
    have = {r.area: r for r in session.exec(select(OpenRule))}
    for a in seen:
        row = have.get(a)
        if a not in found:
            if row is not None:
                session.delete(row)
                logger.info("공지 일정 없어짐: %s", a)
            continue
        rule = found[a].most_common(1)[0][0]
        text = json.dumps([list(x) for x in rule])
        if row is None:
            session.add(OpenRule(area=a, rule=text))
            logger.info("공지 일정 읽음: %s — %s", a, label(rule))
        elif row.rule != text:
            row.rule, row.updated_at = text, _now()
            session.add(row)
            logger.info("공지 일정 바뀜: %s — %s", a, label(rule))

"""오픈 일정 엔진 실데이터 스모크 테스트 — collect → upsert → overview/available/alerts.

실행: python -m scripts.smoke_openings
"""
from __future__ import annotations

import asyncio
from datetime import timedelta

from app.clock import now as _now
from app.collectors.registry import collect
from app.db import get_session, init_db
from app.services import openings as OP
from app.services.diff import upsert_and_extract_new


async def main() -> int:
    init_db()
    raw = await collect(tiers={1})
    print(f"수집 {len(raw)}건")
    with get_session() as s:
        upsert_and_extract_new(s, raw)
        s.commit()

        ov = OP.overview(s)
        print(f"\n=== overview === badge={ov['badge']} watched={ov['watched_total']}")
        for k in ("today", "tomorrow", "upcoming", "open_now"):
            print(f"  {k}: {len(ov[k])}건")
            for it in ov[k][:4]:
                print(f"    - [{it['region']}] {it['facility'][:38]} | {it['status']} | 오픈 {it['open_at']} (D{it['d_day']})")
        print(f"  closed: {ov['closed_count']}건")

        tomorrow = (_now() + timedelta(days=1)).date()
        av = OP.available(s, tomorrow)
        print(f"\n=== available {av['date']}({av['weekday']}) === {av['count']}곳")
        for it in av["items"][:8]:
            print(f"    - [{it['region']}] {it['facility'][:44]} | {it['time']}")
        av2 = OP.available(s, tomorrow, part="야간")
        print(f"  야간만: {av2['count']}곳")

        due = OP.pending_alerts(s)
        groups = OP.group_for_message(due)
        print(f"\n=== alerts === due={len(due)}건 → 묶음 {len(groups)}개")
        for g in groups[:6]:
            print(f"    - {g['kind']} | {g['place']} {g['count']}개 코트 | {g['open_at']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

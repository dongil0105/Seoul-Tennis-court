"""DB 엔진·세션·테이블 생성. SQLite 파일 경로의 상위 디렉터리를 보장한다."""
from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import event
from sqlmodel import Session, SQLModel, create_engine

from app.config import settings
from app import models  # noqa: F401  테이블 메타데이터 등록을 위해 import 유지

_is_sqlite = settings.db_url.startswith("sqlite")
# busy_timeout 5초: 스케줄러 commit과 API 쓰기가 겹쳐도 'database is locked'를 완충.
_connect_args = {"check_same_thread": False, "timeout": 5.0} if _is_sqlite else {}

# sqlite 파일 경로면 상위 폴더 생성
if settings.db_url.startswith("sqlite:///"):
    _path = settings.db_url.replace("sqlite:///", "", 1)
    _dir = os.path.dirname(_path)
    if _dir:
        os.makedirs(_dir, exist_ok=True)

engine = create_engine(settings.db_url, echo=False, connect_args=_connect_args)

if _is_sqlite:
    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, _):  # WAL 모드로 동시 읽기/쓰기 충돌 완화
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()


def init_db() -> None:
    SQLModel.metadata.create_all(engine)


@contextmanager
def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session

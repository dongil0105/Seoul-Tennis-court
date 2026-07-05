# 서울권 테니스 빈코트 알림 시스템 — 설계서 (planner 산출물)

> 범위: 빈 슬롯 **감지 + 알림**까지만. 자동 예약은 구현하지 않는다(약관·계정 안전).
> 데이터 1차 소스: 서울 열린데이터광장 **OA-2266 체육시설 공공서비스예약 정보** 오픈API.
> 알림: 카카오 **memo/default/send**(나에게 보내기).

---

## 1. 요구사항 정의

### 기능요구 (FR)

| ID | 요구사항 | 우선순위 |
|----|----------|----------|
| FR-1 | OA-2266 API를 주기 호출해 서울권 테니스장 예약정보를 수집 | MVP |
| FR-2 | 직전 스냅샷과 비교해 '새로 빈 슬롯'만 추출(중복 알림 방지) | MVP |
| FR-3 | 조건(구/요일/시간대/야간) 매칭 슬롯을 카카오 나에게 보내기로 발송 | MVP |
| FR-4 | access_token 만료 시 refresh_token으로 자동 재발급 후 1회 재시도 | MVP |
| FR-5 | 알림 이력 저장으로 같은 슬롯 재알림 차단 | MVP |
| FR-6 | GET /health, GET /preview, /filters(CRUD) 엔드포인트 | MVP |
| FR-7 | 1회 실행당 최대 N건을 1개 메시지로 묶어 요약 발송 | MVP |
| FR-8 | '사라졌다 다시 나타난 슬롯'(취소표) 감지 → 재알림 옵션 | v2 |
| FR-9 | 텔레그램 백업 알림 채널 | v2 |
| FR-10 | 빈 슬롯 지도/표 대시보드(HTML) | v2 |
| FR-11 | 야간 무음 시간대(23~06시 미발송), 하루 알림 총량 상한 | v2 |
| FR-12 | OA-2266 미수록 코트의 yeyak 읽기전용 보조 조회 | 보류 |
| FR-13 | 배드민턴/풋살 등 타 종목 확장 | 보류 |

### 비기능요구 (NFR)

| ID | 요구사항 | 우선순위 |
|----|----------|----------|
| NFR-1 | 모든 외부호출에 타임아웃·재시도(지수백오프)·예외격리 | MVP |
| NFR-2 | 잡 1회 실패가 스케줄러 전체를 죽이지 않음, 중복실행 방지(max_instances=1) | MVP |
| NFR-3 | 시크릿(토큰/키)을 코드·로그·예외메시지에 노출 금지, .env는 gitignore | MVP |
| NFR-4 | 핵심 로직(diff/필터/해시)·외부연동 mock 단위테스트 | MVP |
| NFR-5 | docker compose up 으로 단일 명령 기동 | MVP |
| NFR-6 | 폴링 주기 설정화(기본 7분), 인기 코트 차등 주기 | v2 |

---

## 2. 데이터 모델

SQLite(우선) → 추후 Postgres. SQLModel 기준.

### facility (시설)
| 필드 | 타입 | 제약 | 설명 |
|------|------|------|------|
| id | int | PK | 내부 ID |
| svc_id | str | unique, index | OA-2266 서비스ID (SVCID 등 — TODO: 실제 응답으로 확인) |
| name | str | not null | 시설/서비스명 |
| gu | str | index, nullable | 자치구(지역) |
| reserve_url | str | nullable | yeyak 예약 상세 링크 |
| updated_at | datetime | | 마지막 갱신 |

### slot (슬롯 스냅샷 — 매 폴링의 현재 상태)
| 필드 | 타입 | 제약 | 설명 |
|------|------|------|------|
| id | int | PK | |
| slot_hash | str | unique, index | sha256(svc_id|court|date|time) |
| svc_id | str | index | 시설 서비스ID |
| facility_name | str | | 시설명(비정규화) |
| court | str | | 코트명/구분 |
| date | str | index | YYYY-MM-DD |
| time | str | | HH:MM-HH:MM 또는 시간대 라벨 |
| gu | str | index, nullable | 자치구 |
| is_open | bool | index | 예약가능 여부 |
| is_night | bool | | 야간(라이트) 여부 |
| first_seen | datetime | | 처음 관측 |
| last_seen | datetime | | 마지막 관측 |
| seen_open | bool | | 이번 사이클에서 open 관측됐는지(취소표 감지용) |

### notified_slot (알림 이력 — 중복 방지)
| 필드 | 타입 | 제약 | 설명 |
|------|------|------|------|
| id | int | PK | |
| slot_hash | str | index | 알린 슬롯 해시 |
| notified_at | datetime | | 발송 시각 |
| reopen_count | int | default 0 | 취소→재오픈 재알림 횟수 |

> 중복판정 키는 `slot_hash`. unique 제약 대신 "존재여부 조회 후 insert"로 운영(취소표 재알림 카운트 갱신 위해).

### user_filter (내 알림 조건)
| 필드 | 타입 | 제약 | 설명 |
|------|------|------|------|
| id | int | PK | |
| name | str | | 필터 이름 |
| gus | str(JSON) | | ["강남구","서초구",...] (빈 배열=전체) |
| weekdays | str(JSON) | | [5,6] (월=0…일=6, 빈 배열=전체) |
| time_from | str | nullable | "06:00" |
| time_to | str | nullable | "10:00" |
| include_night | bool | default true | 야간 포함 |
| enabled | bool | default true | 활성화 |

### kakao_token (토큰 저장/갱신)
| 필드 | 타입 | 제약 | 설명 |
|------|------|------|------|
| id | int | PK (단일 행, id=1) | |
| access_token | str | | |
| refresh_token | str | | 회전 시 갱신 저장 |
| access_expires_at | datetime | | 만료 임박 판정용 |
| updated_at | datetime | | |

---

## 3. 외부 인터페이스 명세

### 3.1 서울 열린데이터광장 OA-2266

- 호출 URL 패턴(공통 규약):
  `http://openapi.seoul.go.kr:8088/{KEY}/{TYPE}/{SERVICE}/{START_INDEX}/{END_INDEX}/`
  - SERVICE = `ListPublicReservationSport` (TODO: 실제 서비스명 확인 — OA-2266 상세에서)
  - TYPE = `json`
  - 페이징: START_INDEX/END_INDEX, 1회 최대 1000행
- 주요 응답 필드(가정 — **TODO: probe로 실제 확인**):
  - `SVCID` 서비스ID, `SVCNM` 서비스명, `AREANM`/`GUBUN`/`MINCLASSNM` 분류,
    `PLACENM` 장소, `X`/`Y` 좌표, `SVCURL` 예약URL,
    `SVCSTATNM`/`SVCSTAT` 접수상태(예약가능 여부), `RCPTBGNDT`/`RCPTENDDT` 접수기간,
    `V_MIN`/`V_MAX` 이용시간 등
- 테니스 필터: `MINCLASSNM` 또는 `SVCNM`에 '테니스' 포함 + 서울권.
- 호출한도 가정: 일 1,000회(키별). 7분 주기 → 일 ~205회로 여유. (TODO: 실제 한도 확인)
- **지시문(coder)**: `scripts/probe_seoul.py`로 1건 호출해 실제 필드명을 확정한 뒤 파서를 고정하라.

### 3.2 카카오 memo/default/send (나에게 보내기)

- 발송:
  ```
  POST https://kapi.kakao.com/v2/api/talk/memo/default/send
  Headers: Authorization: Bearer {access_token}
  Body(form): template_object=<JSON 문자열>
  ```
  text 템플릿 예:
  ```json
  {
    "object_type": "text",
    "text": "🎾 빈 코트 발견\n{시설명} {코트}\n{날짜} {시간}\n바로 예약 👉",
    "link": { "web_url": "{예약링크}", "mobile_web_url": "{예약링크}" },
    "button_title": "예약하러 가기"
  }
  ```
  성공: `{"result_code":0}`
- 토큰 갱신:
  ```
  POST https://kauth.kakao.com/oauth/token
  Body: grant_type=refresh_token&client_id={REST_KEY}&refresh_token={refresh}
  ```
  응답에 `access_token`(필수), `refresh_token`(올 때만 — 회전 시 저장), `expires_in`.
- 에러코드 대응:
  - `-401`(만료/유효하지 않은 토큰) → refresh 후 1회 재시도
  - `-2`(파라미터 오류) → 로깅 후 스킵
  - 그 외 → 로깅, 다음 주기 재시도

---

## 4. 모듈 분해 (WBS) + 공개 시그니처

| 모듈 | 책임 | 입력 | 출력 | 의존성 |
|------|------|------|------|--------|
| collectors/seoul_api | OA-2266 호출·테니스 필터·정규화 | 설정 | `list[NormalizedSlot]` | httpx, config |
| services/diff | 스냅샷 갱신 + 새 빈 슬롯 추출 | 정규화 슬롯, DB | `list[Slot]` | db, models |
| services/notifier | 카카오 발송 + 토큰 갱신 | 슬롯, DB | 발송결과 | httpx, db |
| services/filters | 필터 매칭 | 슬롯, user_filter | bool | models |
| scheduler | 주기 잡 등록·격리 | app | — | APScheduler |
| routers | /health,/preview,/filters | HTTP | JSON | db |
| store(db) | 엔진·세션·테이블 | — | session | SQLModel |

공개 함수 시그니처(파이썬 타입힌트):
```python
# collectors/seoul_api.py
async def fetch_tennis_slots() -> list[NormalizedSlot]: ...

# services/diff.py
def upsert_and_extract_new(session: Session, slots: list[NormalizedSlot],
                           allow_reopen: bool = False) -> list[Slot]: ...

# services/filters.py
def match_filters(slot: Slot, filters: list[UserFilter]) -> bool: ...

# services/notifier.py
async def get_valid_access_token(session: Session) -> str: ...
async def send_to_me(session: Session, text: str, link_url: str) -> bool: ...
async def notify_slots(session: Session, slots: list[Slot], batch_max: int = 10) -> int: ...

# scheduler.py
def start_scheduler(app) -> AsyncIOScheduler: ...
async def poll_job() -> None: ...
```

`NormalizedSlot`(dataclass/pydantic): svc_id, facility_name, court, date, time, gu, is_open, is_night, reserve_url.

---

## 5. '새로 빈 슬롯' 판정 알고리즘 (의사코드)

```
function poll_job():
    raw = fetch_tennis_slots()                 # 외부호출(타임아웃/재시도)
    with session:
        new_slots = []
        for s in raw:
            h = sha256(s.svc_id | s.court | s.date | s.time)
            row = slot.get(h)
            if row is None:
                row = insert slot(h, ..., first_seen=now)
            update row.last_seen=now, row.is_open=s.is_open
            # 취소표 감지: 직전 is_open=false 였다가 true 로 바뀜
            reopened = (row.was_open == false and s.is_open == true)
            row.was_open = s.is_open

            if s.is_open == true:
                already = notified_slot.get(h)
                if already is None:
                    new_slots.append(row)        # 최초 빈 슬롯
                elif allow_reopen and reopened:
                    new_slots.append(row)        # 취소표 재알림(옵션)

        # 필터 매칭
        filters = active user_filters
        matched = [r for r in new_slots if match_filters(r, filters)]

        # 폭주 방지: batch_max 만큼만, 1개 메시지로 요약
        to_send = matched[:batch_max]
        if to_send:
            ok = notify_slots(session, to_send)
            if ok:
                for r in to_send:
                    upsert notified_slot(r.slot_hash, notified_at=now,
                                         reopen_count += 1 if reopen else 0)
        commit
```

핵심: **알림 발송 성공 후에만** notified_slot 기록(실패 시 다음 주기 재시도). slot_hash가 시설·코트·날짜·시간을 모두 포함 → 충돌 없음.

---

## 6. 설정 / 시크릿 (.env)

| 키 | 설명 |
|----|------|
| SEOUL_API_KEY | 서울 열린데이터광장 인증키 |
| KAKAO_REST_KEY | 카카오 REST API 키 (refresh에 client_id로 사용) |
| KAKAO_REFRESH_TOKEN | 최초 발급한 refresh_token(부트스트랩용) |
| KAKAO_ACCESS_TOKEN | (선택) 초기 access_token |
| POLL_INTERVAL_MINUTES | 폴링 주기(기본 7) |
| BATCH_MAX | 1회 발송 최대 슬롯 수(기본 10) |
| ALLOW_REOPEN_ALERT | 취소표 재알림(기본 false) |
| QUIET_HOURS | 무음 시간대(예: "23-06") |
| DB_URL | 기본 sqlite:///./data/app.db |
| SEOUL_API_BASE | 기본 http://openapi.seoul.go.kr:8088 |

---

## 7. 리스크 & 미해결 질문

| 리스크 | 대응 |
|--------|------|
| OA-2266에 원하는 코트가 없음 | 우선 수록 코트만. yeyak 읽기전용 보조조회는 v2(저빈도). 미수록은 README에 명시 |
| OA-2266 응답 필드명이 가정과 다름 | **probe_seoul.py로 최초 확정**. 파서에 매핑 상수 분리 |
| API 장애/일시 오류 | 타임아웃+지수백오프 재시도, 실패 시 잡만 스킵(스케줄러 생존) |
| 알림 폭주 | batch_max 묶음발송 + 무음시간대 + 하루 총량 상한(v2) |
| 카카오 refresh_token 회전/만료 | 응답에 새 refresh 오면 저장. 완전 만료 시 README 재인증 절차 + 텔레그램 백업(v2) |
| 약관 위반 | 자동예약 미구현, yeyak 고빈도 스크래핑 금지(저빈도·읽기전용만) |

---

## 8. 작업 티켓 (coder 1회 세션 단위, 순서대로)

- **T1 — 프로젝트 골격**: 디렉터리, config(pydantic-settings), db(엔진/세션/테이블), models 5종, .env.example, .gitignore, requirements.txt.
- **T2 — Collector + probe**: `scripts/probe_seoul.py`(응답 구조 출력), `seoul_api.py`(호출·테니스필터·정규화). 필드 미확정분은 매핑 상수 + TODO 주석.
- **T3 — Diff Engine**: `services/diff.py` upsert_and_extract_new + slot_hash. 단위테스트.
- **T4 — Filters**: `services/filters.py` match_filters(구/요일/시간대/야간). 단위테스트.
- **T5 — Notifier**: `services/notifier.py` 토큰갱신·send_to_me·notify_slots(batch). mock 테스트.
- **T6 — Scheduler + main**: `scheduler.py`(max_instances=1, 격리), `main.py`(lifespan).
- **T7 — Routers**: /health, /preview, /filters CRUD.
- **T8 — Docker + README + 무음시간/총량상한**: Dockerfile, docker-compose, README(발급절차·실행법), QUIET_HOURS 적용.

> coder 지시: 외부 API 응답 필드는 추측 금지. T2에서 probe로 확정 후 파서 고정. 키 없으면 README에 발급절차 + 파서 TODO.

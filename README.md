# 🎾 서울권 테니스 빈코트 알림 시스템

서울 공공 테니스 코트의 **예약 가능한 빈 슬롯**을 주기적으로 감지해, 내 카카오톡
**'나에게 보내기'** 로 알림을 보내는 백엔드. **예약 자체는 자동화하지 않는다** — 알림을 받고
사람이 직접 [yeyak.seoul.go.kr](https://yeyak.seoul.go.kr)에서 예약한다.

> 데이터는 스크래핑이 아니라 서울 열린데이터광장 **OA-2266(체육시설 공공서비스예약 정보)**
> 공식 오픈API로 가져온다(합법·안정적).

---

## 구조

```
APScheduler(기본 7분)
   → Collector(OA-2266 호출 + 테니스 필터)
   → Diff(직전 스냅샷 대비 '새로 빈 슬롯' 추출, 중복 알림 방지)
   → Filter(구/요일/시간대/야간 매칭)
   → Notifier(카카오 나에게 보내기, 토큰 자동 갱신)
FastAPI: /health  /preview  /filters(CRUD)
```

```
app/
  main.py            FastAPI 엔트리(lifespan: 스케줄러 시작 + link-only 시드)
  config.py          .env 로드(pydantic-settings)
  db.py              엔진/세션/테이블 (SQLite WAL)
  models.py          slot, notified_slot, user_filter, kakao_token, send_log, link_court
  http_util.py       타임아웃+지수백오프 재시도
  collectors/
    base.py            CourtCollector 인터페이스 + 표준 SlotDTO
    seoul_open_api.py  Tier 1 OA-2266(공식 오픈API)
    gangnam.py         Tier 2 강남구 통합예약 [시범/opt-in, 파서 probe 필요]
    link_registry.py   Tier 4~5 link-only(스매시/베이스라인 등 바로가기 전용)
    registry.py        멀티소스 오케스트레이터(격리 호출 + cross-source dedup)
  services/diff.py          '새로 빈 슬롯' 추출 + notified 기록
  services/filters.py       구/요일/시간대/야간/자격·유료 매칭
  services/notifier.py      카카오 발송 + 토큰 갱신 + 배치/무음/총량상한
  scheduler.py              tier 차등 주기(tier1 7분 / tier2~3 20분, 잡 격리)
  routers/                  health, preview(+link_only), filters
scripts/probe_seoul.py      OA-2266 응답 구조 확인
scripts/probe_gangnam.py    강남 페이지 구조/로그인 여부 확인
docs/SOURCES.md             예약처 Tier별 조사 결과(합법성/robots/권장처리)
tests/                      diff/filters/notifier/collector/registry/links/safety
```

### 멀티소스 구조 (Tier)
| Tier | 예시 | 처리 |
|---|---|---|
| 1 | yeyak(OA-2266) | 공식 오픈API 자유 폴링 |
| 2~3 | 강남구 등 자치구·공단 HTML | 저빈도(20분)+캐시+매너 UA, **opt-in** |
| 4~5 | 스매시/베이스라인/네이버 | **자동수집 안 함 — 바로가기 링크만**(`link_court`) |

새 소스는 `collectors/`에 `CourtCollector` 구현 파일 1개 추가 → `registry`에 등록하면 끝.

**자치구 수집기 활성화(2단계 게이트, 무단 크롤링 방지):**
1. `ENABLED_SOURCES=seoul_open_api,gangnam` 로 opt-in (이것만으로는 네트워크 호출 안 함).
2. `python -m scripts.probe_gangnam` 로 **비로그인 조회 가부 + DOM 구조 실측** →
   `collectors/gangnam.py`의 `_parse()` 구현 → `_PARSER_VERIFIED = True` 로 변경.
   - probe가 로그인 페이지로 리다이렉트되면 자동수집 불가 → 이 소스는 link-only로 강등.
   - `_PARSER_VERIFIED = False`(기본) 동안에는 fetch가 외부 요청을 일절 보내지 않는다.

---

## 1. 사전 준비 (사람이 1회)

### 1-A. 서울 열린데이터광장 인증키
1. https://data.seoul.go.kr 회원가입 → 인증키 신청(무료).
2. **OA-2266 체육시설 공공서비스예약 정보** API 사용 신청.
3. 발급된 키를 `.env` 의 `SEOUL_API_KEY` 에 입력.

### 1-B. 카카오 '나에게 보내기' 토큰
1. https://developers.kakao.com 에서 앱 생성 → **REST API 키** 확보 → `.env` `KAKAO_REST_KEY`.
2. [카카오 로그인] 활성화, [동의항목]에서 **카카오톡 메시지 전송(talk_message)** 사용 설정.
3. 브라우저에서 인가코드 발급:
   ```
   https://kauth.kakao.com/oauth/authorize?client_id={REST_KEY}&redirect_uri={REDIRECT}&response_type=code&scope=talk_message
   ```
4. 인가코드 → 토큰 교환(터미널 1회):
   ```bash
   curl -X POST https://kauth.kakao.com/oauth/token \
     -d grant_type=authorization_code \
     -d client_id={REST_KEY} \
     -d redirect_uri={REDIRECT} \
     -d code={발급된_코드}
   ```
   응답의 **`refresh_token`** 을 `.env` `KAKAO_REFRESH_TOKEN` 에 저장(핵심).
   (`access_token` 은 약 6시간마다 refresh로 자동 재발급되므로 선택사항.)
5. 발송 테스트:
   ```bash
   curl -X POST https://kapi.kakao.com/v2/api/talk/memo/default/send \
     -H "Authorization: Bearer {ACCESS_TOKEN}" \
     -d 'template_object={"object_type":"text","text":"테스트 알림","link":{"web_url":"https://yeyak.seoul.go.kr"}}'
   ```
   성공 시 `{"result_code":0}` 반환 + 나와의 채팅방에 도착.

---

## 2. 환경설정

```bash
cp .env.example .env   # Windows: copy .env.example .env
# .env 편집: SEOUL_API_KEY, KAKAO_REST_KEY, KAKAO_REFRESH_TOKEN 채우기
```

| 키 | 설명 |
|----|------|
| `SEOUL_API_KEY` | 서울 오픈API 인증키 |
| `KAKAO_REST_KEY` | 카카오 REST 키(refresh의 client_id) |
| `KAKAO_REFRESH_TOKEN` | 최초 발급 refresh_token |
| `POLL_INTERVAL_MINUTES` | 폴링 주기(기본 7) |
| `BATCH_MAX` | 1회 발송 최대 슬롯 수(기본 10) |
| `ALLOW_REOPEN_ALERT` | 취소표(재오픈) 재알림(기본 false) |
| `QUIET_HOURS` | 무음 시간대(KST, 예: `23-06`, 비우면 항상) |
| `DAILY_SEND_LIMIT` | 하루 발송 **슬롯** 상한(KST 자정 리셋, 0=무제한) |

---

## 3. 실행

### Docker (권장)
```bash
docker compose up --build
```

### 로컬
```bash
python -m venv .venv
. .venv/Scripts/activate      # Windows PowerShell: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

기동 후:
- 헬스: http://localhost:8000/health
- 현재 빈코트: http://localhost:8000/preview
- 필터 등록:
  ```bash
  curl -X POST http://localhost:8000/filters -H "Content-Type: application/json" \
    -d '{"name":"주말오전","gus":["강남구","서초구","송파구"],"weekdays":[5,6],"time_from":"06:00","time_to":"10:00"}'
  ```

---

## 4. ⚠️ OA-2266 응답 필드 확인 (코딩 후 필수 1회)

`collectors/seoul_api.py` 의 `FIELD_MAP` 은 서울 공공서비스예약 **표준 응답 가정**이며 `TODO` 로
표시돼 있다. 실제 키로 확정하려면 인증키 입력 후:

```bash
python -m scripts.probe_seoul
```

출력의 **첫 행 필드명**을 보고 `FIELD_MAP`(특히 `status_name` 예약가능 판정,
`v_min`/`v_max` 시간, 날짜 표현)을 맞춰라. 슬롯 날짜·시간 표현이 표준과 다르면 `_normalize()` 도 조정한다.

> ⚠️ **'슬롯' 단위 주의:** OA-2266의 `SVCSTAT`는 시설(서비스)의 **접수 진행 상태**이지,
> 특정 날짜·코트의 **잔여 한 칸**이 아닐 수 있다. probe로 응답을 확인했을 때 데이터가
> 시설 단위뿐이면, 이 시스템의 알림은 "특정 빈 슬롯"이 아니라 **"접수 개시/접수중"** 수준이 된다.
> 슬롯 단위 잔여(취소표) 정보가 필요하면 모델·해시(`svc_id|court|date|time`) 재설계가 필요하다.
> 현재 파서/판정은 이 가정 위에서 동작하며 `seoul_api.py`에 `TODO`로 표시돼 있다.

---

## 5. 테스트

```bash
pytest
```
- `test_diff.py` — 신규/중복/취소표 재오픈/해시 충돌
- `test_filters.py` — 구/요일/시간대/야간 매칭
- `test_notifier.py` — 발송 성공, 토큰만료→갱신→재시도, 회전 refresh 저장, 실패 시 미기록(respx mock)

---

## 5-1. 반포종합운동장 빈 시간 (테니스플레이, 선택)

반포종합운동장은 서울시 공공서비스예약이 아니라 [테니스플레이](https://www.thetennisplay.com/schedule-booking)에서 예약한다.
테니스플레이는 회원 로그인 뒤에만 예약 현황을 보여 주므로, **이메일 로그인 계정을 넣은 서버에서만** 동작한다.

- 설정: `TTP_EMAIL`, `TTP_PASSWORD` (로컬은 `.env`, Render 는 환경변수에 직접 입력 — 저장소에 올리지 않는다). 비우면 꺼지고 화면에도 나오지 않는다.
- 하는 일: 로그인 → 날짜별 '이미 예약된 시간' 조회 → 코트 운영 시간에서 뺀 나머지를 빈 시간으로 계산(테니스플레이 화면과 같은 계산) → 화면 '반포종합운동장 빈 시간'.
- 지키는 것: 조회만(예약·결제·취소 요청 없음) · 이름·연락처는 저장도 표시도 안 함 · 10분 주기, 01~06시 쉼, 실패하면 간격을 늘림(로그인 실패는 30분 이상) · 응답 모양이 다르면 빈 시간을 지어내지 않고 실패 처리.
- 날짜 범위: 오늘부터 7일 뒤까지. 7일 뒤 날짜는 매일 09:00 에 열린다(테니스플레이 화면의 날짜 선택 규칙).
- 점검: `GET /play/status` (설정 여부·마지막 성공 시각·실패 종류·읽은 항목 이름과 건수만, 비밀·개인정보 없음), `GET /health` 의 `play`.
- 코드: `app/services/tennisplay.py`, 테스트 `tests/test_tennisplay.py`(가짜 서버), 화면 미리보기 `/?mock=play | playfull | playerr`.
- 알림 두 가지(테스트 `tests/test_play_alerts.py`):
  - **예약 오픈 예고** — 반포는 매일 09:00 에 7일 뒤 날짜가 열린다. 전날 20시(`d1`)와 1시간 전(`h1`)에 알린다. 끄기 `TTP_NOTIFY_OPEN=false`.
  - **빈 시간이 새로 생기면** — 지난 조회에서는 예약돼 있던 칸이 비면(취소) 알린다. 서버를 켠 뒤 처음 읽은 것, 그날 09시에 새로 열린 날짜, 이미 시작한 시간은 알리지 않는다. 같은 칸은 3시간 안에 다시 알리지 않고, 무음 시간에는 모아 두었다가 끝난 뒤에도 비어 있는 것만 보낸다. 하루 상한 `TTP_FREE_DAILY_MAX`(기본 40), 끄기 `TTP_NOTIFY_FREE=false`.
  - 받는 곳: 카카오(서버 주인)는 자동, 앱 알림(웹 푸시)은 **그 알림을 고른 기기만**(알림 설정의 '반포종합운동장' · '반포에 빈 시간이 생기면' — 반포 구역의 [알림 받기]를 누르면 둘 다 골라진다). 구독의 `areas` 에 `반포` · `반포 빈 시간` 으로 저장한다.
  - 앱 아이콘 숫자 = **아직 앱에서 확인하지 않은 알림 수**. 알림(웹 푸시)마다 '어느 곳의 무슨 알림인지'(`items`)를 같이 보내고, 서비스워커(`sw.js`)가 보관함(Cache `tn-inbox`)에 적으면서 그 건수를 숫자로 띄운다. 앱을 열면 화면이 보관함을 읽어 맨 위 '새 알림' 목록과 그 테니스장 이름 옆 '새 알림' 표시로 보여 주고, 보관함·아이콘 숫자·알림 목록에 남은 알림을 지운다. 한 번 본 표시는 10분이 지난 뒤 앱을 다시 열면 사라진다(또는 [닫기]). 같은 오픈의 전날 알림과 1시간 전 알림은 한 줄로 합친다. 화면 미리보기 `/?mock=new | playnew`, 테스트 `tests/test_fresh_alerts.py`(서비스워커는 `tests/js/sw_harness.js` 가짜 브라우저). `/board` 의 `badge` · `play.badge` 와 알림의 `badge` 값은 옛 서비스워커가 남아 있는 기기를 위한 것이다.

## 6. 한계 / 안전장치

- **자동 예약 없음.** 알림만. 실제 예약은 사람이.
- OA-2266 미수록 코트는 잡히지 않는다(yeyak 보조 조회는 v2, 저빈도·읽기전용).
- 무음 시간대·하루 총량 상한·배치 요약 발송으로 알림 폭주 방지.
- 외부호출은 타임아웃·재시도, 잡 1회 실패는 스케줄러를 죽이지 않음.
- 시크릿은 `.env`(gitignore), 로그/예외에 토큰·키 미노출.

## 7. 로드맵 (v2)
텔레그램 백업 채널 · 취소표 재알림 기본화 · 인기코트 차등 주기 · 지도/표 대시보드.

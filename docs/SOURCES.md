# 코트 예약 소스 조사 — 서초·강남·송파 중심 (SOURCES.md)

> 작성: 데이터소스 리서처 / 조사일 2026-06-15
> 목적: 기존 '서울 테니스 빈코트 알림 시스템'(OA-2266 + yeyak.seoul.go.kr 기반)에 **추가**할 코트 예약 소스를
>      수집 가능성·합법성 관점에서 조사·분류.
> 원칙: **추측 금지.** 실제 웹 검색/접속/robots.txt 확인 결과만 기재. 확인 못 한 항목은 `TODO: 확인필요` 로 명시.

---

## 0. 핵심 결론 요약

- 서초·강남·송파 3개 자치구는 **모두 yeyak.seoul.go.kr(서울시 공공서비스예약)와 별개**의 '자체' 예약 사이트를 운영한다.
- 그중 **강남(life.gangnam.go.kr)** 만 robots.txt 가 `Allow: /` 로 자동수집에 열려 있다 → 시범 구현 1순위.
- **서초(seocho.go.kr/sports)** 는 robots.txt 에 `/sports/*` 명시 규칙이 없어(기본 허용) 형식상 가능하나, 예약현황이 로그인/AJAX 뒤에 있어 조건부.
- **송파**의 예약현황 사이트(spc.esongpa.or.kr)는 **SSL 인증서 체인 오류**로 자동 fetch 실패(브라우저는 정상). 공단 정보사이트(songpagongdan.or.kr)는 robots.txt `Disallow: /` → 불가.
- 사설 플랫폼(스매시·베이스라인)·네이버 예약은 **공개 API 미확인** → 기본 `[링크만 등록]`.

---

## 1. 요약 표

| 소스명 | 운영주체 | 관할지역 | 예약 URL | 데이터형태 | 합법수집가능성 | 구현난이도 | 자격제한 | robots.txt 자동수집 표현 | 권장처리 |
|--------|----------|----------|----------|-----------|----------------|-----------|----------|--------------------------|----------|
| **강남구 통합예약** | 강남구청 | 강남구 | life.gangnam.go.kr/fmcs/54 | HTML+AJAX(.do), 로그인필요(예약현황은 TODO) | **조건부** | 중 | 없음(공공시설, 회원가입은 예약 시) | `User-agent:* Allow:/` (예약경로 미차단) | **[저빈도 스크래핑]** 후보 1순위 |
| **서초 공공체육시설** | 서초구청 | 서초구 | seocho.go.kr/sports/fmcs/151 | HTML+AJAX(드롭다운 비동기) | **조건부** | 중~상 | 없음(예약 시 회원) | `/sports/*` 명시규칙 없음→기본 허용 | [저빈도 스크래핑] 또는 [링크만 등록] |
| **송파 공공체육시설 통합** | 송파구(esongpa) | 송파구 | spc.esongpa.or.kr | HTML(PHP), 로그인 추정 | **조건부(확인불가)** | 중 | 없음(예약 시 회원) | **TODO: SSL오류로 robots 미확인** | [링크만 등록](현시점) |
| 송파구시설관리공단(정보) | 송파구시설관리공단 | 송파구 | songpagongdan.or.kr/sports/sports05.asp | HTML(정보만, 예약기능 없음) | **불가** | - | - | `User-agent:* Disallow:/` | **[링크만 등록]** |
| **올림픽공원 테니스장** | 국민체육진흥공단(KSPO) | 송파구(올림픽공원) | ksponco.or.kr/online/tennis/index.do | HTML/.do, 로그인필요 | **조건부** | 중~상 | 없음(공공, 예약 시 회원) | root robots.txt **없음(404)** | [저빈도 스크래핑] 또는 [링크만 등록] |
| 서울시 공공서비스예약(yeyak) | 서울시 | 서울 전역 | yeyak.seoul.go.kr | **오픈API(OA-2266)** | **가능** | 하 | 없음 | 검색/게시판 경로만 Disallow, 예약상세 미차단 | **[API수집]**(기존 구현) |
| OA-12180 송파 예약정보 | 서울 열린데이터광장 | 송파구 | data.seoul.go.kr OA-12180 | 파일다운로드(오픈API 미명시), **테니스 미수록** | 가능(가치낮음) | 하 | 없음 | (열린데이터광장 정책) | [링크만 등록]/보류 |
| 스매시(SMAXH) | 스매시㈜ | 전국(사설코트) | smaxh.com/courts | 앱전용+웹, 공개API 미확인 | **조건부→불가(약관 미확인)** | 상 | 앱 회원 | `User-Agent:* Allow:/` (단 약관 TODO) | **[링크만 등록]** |
| 베이스라인(Baceline) | 베이스라인 | 전국(3,337+ 시설) | baceline.io/ko/courts | 앱전용+웹, `/api/` 차단 | **조건부→불가(약관 미확인)** | 상 | 앱 회원 | `/courts/` 허용·`/api/` Disallow | **[링크만 등록]** |
| 네이버 예약 | 네이버 | 전국(실내·사설) | booking.naver.com | 비공개, 공개API 없음 | **불가** | 상 | - | **TODO: 미확인(fetch 차단)** | **[링크만 등록]** |

---

## 2. 소스별 근거

### 2-1. 강남구 통합예약 (life.gangnam.go.kr) — ★시범 1순위
- **확인 URL**
  - 시설예약 목록: https://life.gangnam.go.kr/fmcs/54
  - 봉은테니스장: https://life.gangnam.go.kr/fmcs/107
  - 포이테니스장: https://life.gangnam.go.kr/fmcs/108
  - 강남세곡스포츠공원 테니스장(검색결과 언급)
- **robots.txt 발췌**(https://life.gangnam.go.kr/robots.txt, 실제 확인):
  ```
  User-agent: *
  Allow: /

  User-agent: Googlebot
  Disallow: /admin/
  Disallow: /fmcssetup/
  Disallow: /fmcstool/
  Disallow: /mngcms/
  ```
  → `*` 에이전트에 **전체 허용**. 예약 경로(`/fmcs/*`) 차단 없음. Googlebot 한정 차단은 admin/setup/tool/cms 관리경로뿐.
- **데이터형태**: fmcs 페이지의 예약현황은 드롭다운(센터/시설/장소) **AJAX 비동기 로딩**("…불러오는 중" 확인). 시설정보 페이지(fmcs/107) 자체는 정적 HTML이나, 가능시간 조회는 별도 .do 엔드포인트로 추정.
- **자격제한**: 공공 야외 테니스장. 예약(결제)에는 회원가입 필요하나, **가능시간 조회**의 비로그인 가능 여부는 **TODO: 확인필요**(브라우저 DevTools Network 탭으로 실제 .do/json 엔드포인트 확정 필요).
- **운영 메모**: 1회 1시간, 최대 8시간 연속, 매월 25일까지 온라인 신청, 현장 결제(카드/계좌이체).
- **판정**: robots 허용 + 공공시설 → **조건부(가능에 가까움)**, **[저빈도 스크래핑]**.

### 2-2. 서초 공공체육시설 (seocho.go.kr/sports)
- **확인 URL**
  - 대관신청 목록: https://www.seocho.go.kr/sports/fmcs/151
  - 테니스 시설: 내곡테니스장, 반포종합운동장 테니스장, 매헌시민의숲(양재)테니스장
  - 내곡테니스장은 **네이버 예약** 병행: https://booking.naver.com/booking/10/bizes/217811
- **robots.txt 발췌**(https://www.seocho.go.kr/robots.txt, 실제 확인 — 56여 개 규칙):
  ```
  User-agent:*
  Allow:/rss/*
  Allow:/site/*.jsp
  Allow:/site/*.do
  Disallow:/cmm/*
  Disallow:/secret/*
  Disallow:/jsp/search/*
  Disallow:/common/*
  ... (게시판 cbIdx 다수 Disallow) ...
  ```
  → `/sports/*` 에 대한 **명시 Allow/Disallow 모두 없음**. `Disallow: /` 전면차단도 없음 → 표준 해석상 **미차단 경로는 허용**. ("sports" 문자열 포함 라인 0건 실제 확인)
- **데이터형태**: fmcs/151 은 센터/시설/장소 드롭다운 **AJAX 로딩**("센터/시설/장소 불러오는 중"). 가용 슬롯은 로그인·AJAX 뒤. → 구현난이도 중~상.
- **자격제한**: 없음(공공). 예약 시 회원.
- **판정**: **조건부**. 내곡은 네이버예약 경유라 사실상 네이버 의존 → 그 시설은 [링크만 등록]이 현실적. 나머지 직영분만 [저빈도 스크래핑] 검토.

### 2-3. 송파 — 두 사이트 구분 주의
- **(A) spc.esongpa.or.kr — 송파구공공체육시설 통합사이트 (실제 예약처)**
  - 확인 URL: https://spc.esongpa.or.kr/ , 대관신청 예시 https://spc.esongpa.or.kr/page/rent/s01.od.list.php
  - 테니스장: 오금공원·오륜·성내천 테니스장 등. 파크골프/축구/풋살/테니스 동일 방식 예약.
  - 데이터형태: PHP(.php), 로그인 페이지(bbs/login.php)·회원가입(bbs/register.php) 존재 → 예약현황 열람에 로그인 필요 추정.
  - **robots.txt: TODO: 확인필요** — `spc.esongpa.or.kr` 가 **SSL 인증서 체인 검증 실패**("unable to verify the first certificate")로 WebFetch 불가. (한국 공공기관 흔한 중간 인증서 누락 이슈; 브라우저는 정상 접속될 가능성 높음.) → robots 와 비로그인 조회 가부를 브라우저로 재확인 필요.
- **(B) songpagongdan.or.kr — 송파구시설관리공단 (정보/안내 사이트)**
  - 확인 URL: https://www.songpagongdan.or.kr/sports/sports05.asp (오금공원테니스장 안내, 예약기능 없음)
  - **robots.txt 발췌**(실제 확인):
    ```
    User-agent: *
    Disallow: /
    Disallow: /custom/custom02.asp
    ... (이하 개별 .asp 다수) ...
    ```
    → **전면 자동수집 금지**. 분류규칙상 무조건 **불가 → [링크만 등록]**.
- **(C) 보조**: 송파 예약은 상당수 **yeyak.seoul.go.kr 경유**(검색결과 다수 yeyak 링크) → 기존 OA-2266 으로 일부 커버. 단 OA-2266 미수록 코트 존재 가능.
- **판정**: 실제 예약처 (A)는 **조건부(현시점 확인불가 → [링크만 등록])**, (B)는 **불가 → [링크만 등록]**.

### 2-4. 올림픽공원 테니스장 (KSPONCO, 국민체육진흥공단)
- **확인 URL**
  - 온라인예약: https://www.ksponco.or.kr/online/tennis/index.do
  - 예약신청: ./resrvtn_aplictn.do (index 내 링크)
  - 대기현황: https://www.ksponco.or.kr/spm/tennis/tennis_wait_status.do → **HTTP 404**(세션/파라미터 필요 추정)
- **robots.txt**: https://www.ksponco.or.kr/robots.txt → **404(파일 없음)**. robots 부재 시 표준상 "명시적 금지 없음"이나, **이용약관 별도 확인 필요(TODO)**.
- **데이터형태**: index.do 는 로그인(로그인 링크 노출) 뒤 예약 UI. 가용 슬롯 정적/AJAX 여부 **TODO: 확인필요**(예약신청 .do 페이지 미열람).
- **자격제한**: 공공. 예약 시 회원.
- **판정**: **조건부**. 로그인 뒤 데이터 가능성 높아 [저빈도 스크래핑] 난이도 중~상, 현실적으로 [링크만 등록] 우선.

### 2-5. 사설 플랫폼 — 스매시(SMAXH)
- **확인 URL**: https://www.smaxh.com/ , 코트리스트 https://www.smaxh.com/courts , 비즈니스 관리자 https://court.smaxh.com/
- **robots.txt 발췌**(실제 확인):
  ```
  User-Agent: *
  Allow: /
  Sitemap: https://smaxh.com/sitemap.xml
  ```
- **공개/제휴 API**: 검색상 **개발자/공개 API 프로그램 미발견**. '비즈니스 제휴' 메뉴는 사업장(코트) 입점용으로 추정.
- **이용약관 자동수집 조항**: https://www.smaxh.com/terms → **HTTP 404**(해당 경로 약관 미존재). 정확한 약관 URL/문구 **TODO: 확인필요**.
- **판정**: 앱 중심 + 공개API 미확인 + 약관 미확인 → 분류규칙(사설은 미확인 시 기본) → **[링크만 등록]**.

### 2-6. 사설 플랫폼 — 베이스라인(Baceline)
- **확인 URL**: https://www.baceline.io/ko/courts (3,337+ 시설), FAQ https://www.baceline.io/ko/faq
- **robots.txt 발췌**(실제 확인 요지):
  - 허용 에이전트에 Googlebot/GPTBot/**ClaudeBot**/Bingbot 등 명시, 허용경로 `/courts/`,`/clubs/`,`/tournaments/` 등.
  - **Disallow: `/api/`, /admin/, /auth/, /dashboard/, /_next/, /user/**.
  → 공개 콘텐츠 페이지(`/courts/`)는 크롤 허용이나, **데이터 API(`/api/`)는 명시적 차단**.
- **공개/제휴 API**: 공식 공개 API **미확인**. 약관(이용약관) 본문 자동수집 조항 **TODO: 확인필요**(terms 페이지에서 조항 본문 미추출).
- **판정**: `/api/` 차단 + 공개API 미확인 + 약관 미확인 → **[링크만 등록]**. (단 `/courts/` 페이지는 robots상 크롤 허용이므로, **개별 코트 상세 링크 수집** 정도는 합법 여지 — 실시간 빈슬롯 API 수집은 불가.)

### 2-7. 네이버 예약 (booking.naver.com)
- **확인**: 내곡테니스장 등 일부 공공/사설 코트가 네이버 예약 사용(서초 검색결과). https://booking.naver.com/booking/10/bizes/217811
- **robots.txt / fetch**: WebFetch **차단됨**(Claude Code unable to fetch from booking.naver.com). → robots **TODO: 확인필요**.
- **공개 API**: 일반 코트 예약현황용 공개 API **없음**(전제대로).
- **판정**: **불가 → [링크만 등록]**. (시설별 booking.naver 링크만 DB에 저장하고 사용자가 직접 확인하도록.)

### 2-8. 기존 소스 재확인 — yeyak / OA-2266
- yeyak.seoul.go.kr robots.txt(실제 확인): 검색(`/web/search/...`)·게시판(`/web/bbs/...`) 경로만 Disallow. **예약 상세(`/web/reservation/...`) 미차단**.
- OA-2266 오픈API는 기존 시스템이 이미 사용(합법, [API수집]). 본 라운드의 신규 추가 대상 아님(참고용).
- OA-12180(송파 전용)은 **파일 다운로드 위주, 오픈API 미명시, 테니스 미수록** → 가치 낮음. 보류.

---

## 3. '바로 추가 가능(합법수집 가능 등급)' 소스 Top 5 → 코딩 티켓

> 엄밀한 '가능' 등급은 yeyak(기존) 1건뿐이라, 여기서는 **robots 미차단 + 공공시설 = 합법 여지 높은 순**으로 5개를 코딩 티켓화한다.
> (사설/네이버는 규칙상 link-only 이므로 '수집' 티켓 대상 제외.)

### T-S1 — 강남구 통합예약 빈슬롯 수집기 (난이도 중) ★최우선
- 대상: life.gangnam.go.kr 봉은/포이/세곡 테니스장.
- 작업: 브라우저 DevTools(Network)로 **가용시간 조회 AJAX 엔드포인트(.do)와 파라미터(시설ID/날짜) 확정** → `app/collectors/gangnam.py` 신규, `fetch_gangnam_slots() -> list[NormalizedSlot]`.
- 선결 TODO: 비로그인 조회 가부 확인. 로그인 필요 시 read-only 세션 or [링크만 등록]으로 강등.
- 폴링: 저빈도(기존 7분 이상 권장), User-Agent 명시, 야간 무음 준수.

### T-S2 — 서초 공공체육시설 빈슬롯 수집기 (난이도 중~상)
- 대상: 반포종합운동장·양재(매헌) 테니스장 (내곡=네이버예약→제외/링크만).
- 작업: seocho.go.kr/sports/fmcs/151 의 드롭다운 AJAX 엔드포인트 확정 → `collectors/seocho.py`.
- 선결 TODO: `/sports/*` 경로 robots 미차단 재확인 + 비로그인 조회 가부.

### T-S3 — 올림픽공원(KSPO) 테니스장 (난이도 중~상)
- 대상: ksponco.or.kr/online/tennis.
- 작업: resrvtn_aplictn.do / wait_status.do 의 실제 요청 구조 확정 → `collectors/ksponco.py`.
- 선결 TODO: robots 부재 → **이용약관 자동수집 조항 확인**(불가면 링크만). 로그인 필요 가능성 높음.

### T-S4 — 송파 spc.esongpa 재조사 + 수집/링크 결정 (난이도 중)
- 작업: **브라우저로 SSL·robots·비로그인 조회 가부 확정**(WebFetch는 인증서오류로 실패). 가능시 `collectors/songpa.py`, 불가시 시설 링크만 DB 등록.
- 주의: songpagongdan.or.kr(공단 정보사이트)는 `Disallow:/` → 절대 수집 금지, 링크만.

### T-S5 — 베이스라인 코트 '링크 카탈로그' 수집기 (난이도 하, link-only 보강)
- 대상: baceline.io/courts (robots상 `/courts/` 크롤 허용).
- 작업: 서초·강남·송파 코트의 **상세 페이지 URL·코트명·주소만** 1회성 수집해 facility.reserve_url 보강. **실시간 빈슬롯은 수집 금지(/api/ 차단)**.
- 효과: 사설 실내코트의 '링크만 등록' 대상 자동 카탈로그화.

---

## 4. 이번에 시범 구현할 Tier-2 자치구 추천

### 추천: **강남구 (life.gangnam.go.kr)**

| 항목 | 내용 |
|------|------|
| 예약 페이지 URL | https://life.gangnam.go.kr/fmcs/54 (시설예약 목록) / 테니스: /fmcs/107(봉은), /fmcs/108(포이), 세곡 |
| 예상 데이터형태 | **HTML + AJAX(.do)** — 센터/시설/장소 드롭다운 비동기, 가용시간은 별도 .do 호출로 추정 |
| robots 확인 결과 | `User-agent:* Allow:/` (실측). 예약경로 `/fmcs/*` 미차단. Googlebot만 admin/cms 차단 → **자동수집 합법 여지 가장 높음** |
| 추천 이유 | 3개 후보 중 **유일하게 robots 전면 허용**. 사용자 주활동지(반포 근처) 강남 다수 야외코트(봉은/포이/세곡) 보유. 공공시설이라 자격제한 없음 |

**파서 작성 시 주의점**
1. **엔드포인트 확정 먼저**: 정적 HTML 파싱 금지. 브라우저 Network 탭에서 가용시간 조회 시 실제 **.do(또는 json) 요청 URL·파라미터(시설코드, 조회 연/월/일)**·응답형식을 캡처해 고정. (OA-2266 때처럼 probe 스크립트 `scripts/probe_gangnam.py` 작성 권장.)
2. **비로그인 조회 가부 = 선결조건**: 가용시간 조회가 로그인/세션 쿠키를 요구하면 자동수집 위험 → 그 경우 강남도 **[링크만 등록]으로 강등**. 로그인 없이 조회되면 그대로 [저빈도 스크래핑].
3. **저빈도·매너**: robots가 허용해도 공공서버. 기존 폴링주기(7분) 이상 유지, 명시적 User-Agent, 야간 무음(QUIET_HOURS) 준수, 시설 단위로 요청 묶기.
4. **정규화 일관성**: 출력은 기존 `NormalizedSlot`(svc_id/facility_name/court/date/time/gu/is_open/is_night/reserve_url)에 맞춰 강남 응답 필드를 매핑. gu="강남구" 고정, reserve_url 은 해당 fmcs 상세 링크.
5. **취소표/중복**: 기존 slot_hash·diff 엔진 그대로 재사용 가능(소스만 추가).

**만약 3곳 모두 자동수집 불가로 판명되면**: 강남(robots 허용)은 비로그인 조회만 막혀도 link-only가 현실적이다. 서초·송파·KSPO는 로그인/약관/SSL 장벽이 겹쳐 **현 시점 자동수집 불가 → 세 자치구 전부 facility.reserve_url 에 예약 페이지 링크만 등록하고, 사용자가 카카오 알림의 버튼으로 직접 확인**하는 link-only 방식이 가장 현실적이다. (단, 강남은 T-S1 비로그인 조회 확인 1건만 통과하면 실수집이 충분히 가능하므로 link-only 결론 전에 반드시 확인할 것.)

---

## 5. 미해결 TODO 모음
- [ ] 강남 fmcs 가용시간 조회 AJAX 엔드포인트·파라미터·비로그인 가부 (브라우저 DevTools)
- [ ] 서초 /sports AJAX 엔드포인트 + 비로그인 가부
- [ ] 송파 spc.esongpa.or.kr **SSL 인증서 체인·robots.txt·로그인 요구** (WebFetch 인증서오류로 미확인)
- [ ] KSPONCO 이용약관 자동수집 조항 + 예약 .do 데이터형태/로그인
- [ ] 스매시 정확한 이용약관 URL·자동수집 금지 조항 (smaxh.com/terms 404)
- [ ] 베이스라인 이용약관 본문 자동수집 조항 (terms 페이지 본문 미추출)
- [ ] 네이버 예약 booking.naver.com robots.txt (WebFetch 차단)

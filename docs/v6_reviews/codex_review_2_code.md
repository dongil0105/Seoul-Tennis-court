# 코트 오픈 v6 독립 검토
대상: dashboard_v6.html 전체, REDESIGN_V6.md §§4.1·4.2·10.1, 실제 board 및 v5. 네트워크·입력 수정 없음.
모델은 고정 시계 Node vm으로 실행했다. UI는 정적 검토와 브라우저 API를 대체한 vm 재현이며, 실제 브라우저·휴대폰 레이아웃 검증은 하지 않았다.

## P1 (버그·꼭 고칠 것)

1. **빈 시간 알림 끄기 실패 후 화면과 서버 상태 불일치** — `toggleFree`(1962), `turnOff`(1784) → 마지막 빈 시간 알림을 끄기 전에 `settings.free=false`로 바꾸고 실패 시 복구하지 않는다. → `areas:[], free:true, enabled:true`에서 `/push/unsubscribe` 실패: 재현값 `{on:true,free:false,areas:[]}`. 서버는 계속 보내지만 스위치는 꺼진다. → 끄기 성공 후 free를 변경하거나 실패 시 이전 설정을 복원한다. 실패 안내도 홈에서 토스트로 노출한다(`turnOff`의 say는 기본적으로 알림 탭에만 보임).
2. **서버 등록 실패에도 종이 켜지고 성공으로 안내될 수 있음** — `syncPush`(1698), `pushOn`·`subscribedTo`(1662 부근), `turnOnLoud` → 브라우저 구독과 저장된 enabled만으로 성공을 판정한다. user 실패 경로는 serverOk도 초기화하지 않는다. → 기존 enabled/구독이 있고 서버 등록이 실패하면 vm 재현값 `{on:true,serverOk:true}`; 복원 중 auto 실패도 sub가 있으면 종은 켜짐. 서버 등록이 실제 남았는지는 이 화면이 확인하지 못한다. → 등록 중/실패/성공을 구분하고 user 성공 여부를 명시적으로 반환한다. 실패 때 성공 토스트를 내지 말고 재등록을 예약한다. 기존에 확인한 등록을 유지할 경우에도 ‘변경 저장 실패’를 별도로 표시한다.
3. **잘못된 최상위 입력이 모델을 중단시킴** — `buildVenues`(958) → `d.openings`를 바로 읽어 §10.1의 null 방어 계약을 어긴다. → `buildVenues(null,T)`와 undefined가 TypeError; 각 입력의 두 검사가 실패(4건). → 시작 시 `d = d && typeof d === 'object' && !Array.isArray(d) ? d : {}`로 정규화한다. `renderBoard`의 `d.updated_at` 접근도 같은 방어가 필요하다.

## P2

1. **반포의 가장 이른 빈 시간이 아닌 첫 배열 항목을 표시** — `playVenue`(933), `playRanges`(765 부근) → 날짜·슬롯 정렬 없이 첫 원소를 쓴다. → 내일 20시 항목이 오늘 14시보다 먼저 오면 ‘내일 20~22시 외’; §4.1은 가장 이른 시간을 요구한다. → 날짜와 s/e를 정렬한 복사본으로 범위를 합친다. 입력 정렬 보장은 명세에 없어 합리적 해석으로 시험했다.
2. **반포 다음 오픈에 계약 밖 필수 필드 추가** — `playVenue`(949) → 미래 `next_open.at`가 있어도 `next_open.date`가 없으면 unknown. → 미래 at만 있는 부분 응답에서 실패. §4.2는 미래 at만 조건으로 적는다. → at로 다음 칸을 만들고 이용일 설명만 date 존재 시 추가한다. date 필수가 의도라면 명세를 보완한다(모호성).
3. **존재하지 않는 날짜를 정상 오픈으로 수용** — `kstMs`(622) → Date.parse가 11월 31일을 12월 1일로 보정하지만 출력 문자열은 11.31로 남는다. → `2026-11-31 09:00`이 next에 남아 실패. → 파싱한 KST 연·월·일·시·분을 원문과 대조하고 불일치하면 NaN. play의 정규식 날짜 검사에도 같은 검증을 사용한다.
4. **상태 재그리기 때 키보드 초점 소실** — `paintHome`(1434), `paintChips`, `renderBoard`, `paintFresh` → innerHTML 교체가 현재 초점 노드를 지운다. → 상세 코트/종/칩에 초점을 둔 채 자료 변경·새 알림·2시간 경계 도달; `popstate`의 `show(v,true)`도 제목 초점을 복원하지 않는다. → 교체 전 의미 키를 저장해 같은 컨트롤로 복원하고, 뒤로 이동 시 출발 카드/제목에 초점을 둔다. 전체 홈 제목에도 tabindex를 제공한다. 실제 보조기기 반응은 미검증.
5. **24시간 경계의 주황색과 큰 카드 줄이 늦게 바뀜** — `tick`(1544), `renderBoard`(1492) → countdown 텍스트만 바꾸며 soon·hero 추가 줄은 오픈/2시간/자정/데이터 변경 때만 다시 계산한다. → 24시간보다 조금 더 남은 응답이 내용 변화 없이 반복되면 `loadBoard` 동일 sig 경로도 재계산을 건너뛴다. 24시간 안으로 들어와도 주황색/곧 열려요 줄이 없을 수 있다. → 다음 24시간 경계도 재계산 예약에 포함하고 동일 응답에서도 모델의 시간 의존 상태를 갱신한다.
6. **v5의 cold 회차별 정보가 소실** — `nowSecHTML`(1270 부근), v5 `rowHTML`(792) → v5는 2시간 지난 모든 오픈의 이용 기간·시각·코트 링크를 회차별로 펼쳤다. v6는 `v.cold[0]` 시각만 보여 주고 나머지 코트는 합친다. → 하루 두 회차가 열리고 2시간이 지나면 두 번째 시작 시각·각 이용 기간을 확인할 수 없다(실제 샘플도 09:00/09:03). → cold를 회차별 접힘 목록으로 보존한다. 전체 화면에서 상세로 이동하는 변경 자체는 설계 의도이므로 회귀로 세지 않았다.
7. **과거 반포 오픈을 ‘오픈 전’으로 표시** — `playNowSecHTML`(1388 부근) → 날짜 문법만 검사하고 `no.at > now`를 검사하지 않는다. → 지난 next_open의 이용일이 days에 없으면 모델 next는 unknown인데 아래 목록에는 ‘오늘 09:00에 예약이 열려요 / 오픈 전’. → `v.next.state === 'date'`인 경우에만 추가 줄을 만든다. v5에도 있던 결함이다.
8. **서비스워커 준비가 끝나지 않으면 알림 조작 잠김** — `worker`(1688), `syncPush` → register 이후 `navigator.serviceWorker.ready`에 제한 시간이 없다. → 등록은 성공했으나 활성 워커가 생기지 않는 경우(추측: 설치 스크립트 오류) pushBusy가 계속 true. → 준비 대기에 제한 시간을 두고 finally로 잠금을 풀며 재시도 안내를 한다.
9. **작은 화면의 터치 영역이 계약보다 작음** — `.vchip`(94), `.sort select`(158), `.stale button`(109) → 각각 40/38/36px 높이여서 §9의 44px에 못 미친다. → 휴대폰에서 장소·정렬·오래됨 새로 고침 조작. → 높이/실제 클릭 영역을 44px 이상으로 확보한다. 320px에서는 카드 내부 너비 약 256px이므로 minmax(132px)의 duo가 한 열이 되는 계산은 적절하다. 긴 텍스트·200% 확대의 가로 넘침 여부는 실제 렌더링 미검증(추측).

## P3

1. **색 설명이 서울시 빈자리 보장으로 읽힘** — 더보기 `.legend`(530 부근), `nextSecHTML` → ‘초록: 지금 예약을 받아요 · 빈 시간이 있어요’가 한 문장이고 closed-only always도 ‘늘 예약을 받는 곳’. → 초록 hot에 unknown/full 코트가 있거나 상시 코트가 마감된 경우 오해. → ‘서울시: 예약 시작/접수 안내, 빈자리는 직접 확인 / 반포: 확인된 빈 시간’, ‘정해진 오픈 날이 없는 곳’으로 나눈다. §4.1 hot 우선과 §4.2 always 문구는 구현대로 시험했으며, 이 항목은 명세 자체의 문구 개선이다.
2. **알림 시각 선택과 성공 문구 불일치** — `onText`(1903), `alarmBlockHTML`, `sumText` → d1 또는 h1을 꺼도 ‘전날과 1시간 전’이라고 안내한다. → 한 시점만 선택한 기기에서 종으로 장소 추가. → 실제 settings.d1/h1에 맞춰 선택한 시점만 말한다. ‘일시중지’는 ‘잠시 멈춤’, ‘지난번’은 ‘지난 예약 시작’처럼 풀어 쓸 수 있다.
3. **새 알림 점의 접근 가능한 이름 누락** — `paintChips`(1422) → 점 옆 ‘새 알림’ span이 hidden이라 접근성 트리에서도 빠진다. → 새 알림 있는 칩을 보조기기로 읽을 때 상태를 알 수 없다. → 시각적으로만 숨기는 클래스를 쓰거나 aria-label에 상태를 덧붙인다. 종의 aria-pressed/상세 이름, 탭 aria-current, 토스트 status는 갖춰져 있다.

## 시험 결과

실행: `node court_open_v6/venue_model_cases.js` (Node v24.18.0, 종료 코드 1). 100건 중 93건 통과, 7건 실패. 독립 실행 시 아래처럼 각 실패의 expected/actual도 함께 출력한다.
```text
FAIL play/unsorted earliest
  expected: { state: 'free', tone: 'go', title: '빈 시간 있음', sub: '오늘 14~15시 외' }
  actual:   { state: 'free', tone: 'go', title: '빈 시간 있음', sub: '내일 20~22시 외' }
FAIL play/next future at without use date
  expected: { state: 'date', title: '내일 09:00', sub: '1일 남음', soon: false }
  actual:   { state: 'unknown', title: '아직 몰라요', sub: '일정이 아직 없어요', soon: false }
FAIL garbage/null/fixed venues
  expected: [ '한남', '장충', '마루공원', '선우공원', '서울숲' ]
  actual:   THREW TypeError: Cannot read properties of null (reading 'openings')
FAIL garbage/null/ignore bad openings
  expected: null
  actual:   THREW TypeError: Cannot read properties of null (reading 'openings')
FAIL garbage/undefined/fixed venues
  expected: [ '한남', '장충', '마루공원', '선우공원', '서울숲' ]
  actual:   THREW TypeError: Cannot read properties of undefined (reading 'openings')
FAIL garbage/undefined/ignore bad openings
  expected: null
  actual:   THREW TypeError: Cannot read properties of undefined (reading 'openings')
FAIL garbage/impossible date/ignore bad openings
  expected: null
  actual:   { area: '한남', open_at: '2026-11-31 09:00', courts: [ { court: '1번', reserve_url: 'https://yeyak.seoul.go.kr/1번' } ], opened: false }
FAIL 7/100
```
실패 원인은 P1-3(4건), P2-1/2/3(각 1건)이며 기대값은 완화하지 않았다. live와 +3h의 6곳 now/next 전체 문구·전역 hot/next, 2시간·24시간 경계, 공지/중복 제거/상태/수량/상시/과거/반포/잘못된 입력/정렬/자정 전환을 검사했다.
기대값 해석: ‘24시간 안’은 정확히 24시간을 제외, 번호 없는 예약은 건수, 정렬 동률은 입력 순서. §10.1의 서버 opened 우선 계약상 미래 opened:true도 hot으로 인정하는 시험은 통과하지만, API 충돌 데이터 처리 정책은 별도 확정이 필요하다. countdown 반올림은 명세 예시와 가장 가까운 올림으로 해석했다.

추가 vm 재현: 빈 시간 알림 끄기 실패 `{on:true,free:false,areas:[]}`, user 재등록 실패 `{on:true,serverOk:true}`. 실제 푸시 서버·OS 권한·SW는 호출하지 않았다.
XSS/링크: 서버의 이름·지역·기간·규칙·슬롯·알림·코트 문자열은 esc 또는 textContent 경로를 확인했다. 일부 날짜 출력은 esc 없이 나오지만 검증된 시각의 고정 길이 조각/숫자 변환이라 실행 가능한 주입은 확인하지 못했다. 예약 링크는 HTTPS seoul.go.kr 및 하위 도메인, 반포는 HTTPS www.thetennisplay.com만 허용하고 rel도 있다. 글꼴 CDN은 링크 목적지 검사의 예약 링크와 구분했다(외부 요청은 실행하지 않음).
다크 모드 대비: WCAG sRGB 상대휘도로 실제 텍스트 조합을 계산했다. ink/card 15.34, ink/bg 17.29, ink-2/card 10.43, ink-2/fill 9.26, ink-3/card 6.68, ink-3/fill 5.93, ink-3/bg 7.53, ink-2/go-bg 9.49, ink-2/warn-bg 9.48, go/go-bg 및 brand/brand-weak 8.20, soon/soon-bg 8.00, warn/warn-bg 9.15, on-brand/brand 8.44, on-alert/alert 6.63, on-lime/lime 11.46, hero-ink/hero-2 9.84, hero-sub/hero-2 6.19, hero-item 보조 글자 4.71, 고정 hero-btn 13.54, toast 17.29: 모두 4.5 이상. hero-sub는 흰색 .74, hero-item은 흰색 .12 배경 합성 후 계산했다. ink-4는 텍스트가 아닌 아이콘/선/스위치에 쓰인다. 반투명 탭/바의 모든 스크롤 배경 픽셀과 disabled 투명도는 실측하지 않았다.
동작 줄이기: CSS reduce에서 animation/transition을 끄고 JS smooth scroll도 calm으로 우회한다. v5의 무료/유료·조명·시간대·신청 마감·이용 기간, 과거 3회, 상세 펼침 유지, 공유/설치/테스트 알림·최근 feed·새 알림 정리는 코드상 유지된다. 새 알림 Cache 읽기/삭제의 동시 도착 경쟁은 SW 입력이 없어 확정하지 않았다(추측).

검토 기준: `claude/cool-tesla-x9frzd`, `ddda575`. 파일은 수정하지 않았습니다. 정적 검토와 메모리 내 재현을 수행했으며, 실제 iOS·Android 기기 검증은 하지 않았습니다.

**치명**

- 위치: [pose.js:141](/home/user/Seoul-Tennis-court/app/static/coach/js/pose.js:141) · 문제: 전체 분석이 취소 불가능한 상태로 멈출 수 있음 · 근거: 취소 확인이 프레임 콜백 안에만 있고, 콜백 내부 추론 예외도 Promise로 전달되지 않음. 콜백 중단 후 취소, GPU 예외 모두 미완료 상태를 재현 · 권장 수정: 직접 abort 리스너·진행 감시 타이머·콜백 try/catch와 공통 정리 경로 추가.
- 위치: [pose.js:77](/home/user/Seoul-Tennis-court/app/static/coach/js/pose.js:77), [app.js:275](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:275) · 문제: 영상과 뼈대가 서로 다른 순간인데 정상 결과로 표시됨 · 근거: 모든 화면이 같은 video를 seek하며, 1초·2초 동시 요청이 모두 2초에서 완료됨. `paintSeq`는 다른 화면의 seek를 막지 못하고, 1.5초 시간 초과도 성공으로 처리 · 권장 수정: seek 직렬화, 실제 디코딩 완료 검증, 요청 취소·시간 초과 오류 처리.
- 위치: [app.js:30](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:30), [app.js:175](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:175) · 문제: 뒤로가기·두 번째 영상 선택 후 이전 작업이 화면과 상태를 덮어씀 · 근거: 취소 catch가 현재 화면과 무관하게 setup/people로 이동하고 history를 교체함. await 이후 세션 일치 검사도 없음 · 권장 수정: 파일별 작업 ID를 도입하고, 모든 비동기 완료·history 복원에서 유효성 확인.
- 위치: [pose.js:138](/home/user/Seoul-Tennis-court/app/static/coach/js/pose.js:138), [app.js:451](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:451) · 문제: 긴 경기 영상에서 메모리 고갈 위험 · 근거: 전체 구간의 33관절 화면·월드 좌표를 무제한 보관한 뒤 정제 배열도 생성함. 18개 제한은 이후 후보에만 적용되며, 모델 캐시도 닫지 않음 · 권장 수정: 구간별 처리·수집률 제한·메모리 상한과 모델 해제 정책 적용.

**중요**

- 위치: [pose.js:62](/home/user/Seoul-Tennis-court/app/static/coach/js/pose.js:62), [app.js:70](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:70) · 문제: 파일 선택이 끝나지 않거나 object URL이 누수됨 · 근거: `loadeddata/error`만 기다리고 취소·시간 제한이 없음. 연속 선택 시 두 Promise가 새 파일의 이벤트로 함께 완료되고 이전 URL이 남는 것을 재현. 모바일에서는 `loadeddata`가 생략될 수 있음([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/loadeddata_event)) · 권장 수정: 이전 열기 취소, metadata/프레임 준비 분리, 실패·교체 시 URL 정리.
- 위치: [pose.js:90](/home/user/Seoul-Tennis-court/app/static/coach/js/pose.js:90) · 문제: FPS 측정이 후속 작업에 간섭하고 고속 영상을 과소 측정함 · 근거: 정상 종료 후에도 타이머가 다시 pause하고, 시간 초과 시 프레임 콜백이 남음. 콜백 빈도는 화면 주사율에도 제한됨([API 설명](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)) · 권장 수정: 종료 플래그·타이머/콜백 취소, 누락 프레임 고려, 원본 FPS와 분석 샘플률 분리.
- 위치: [reference.json:1](/home/user/Seoul-Tennis-court/app/static/coach/data/reference.json:1), [build_reference.mjs:95](/home/user/Seoul-Tennis-court/tools/coach/build_reference.mjs:95) · 문제: 배포 사진의 저작자·라이선스 표기가 전부 누락됨 · 근거: 84개 모두 author/license/licenseUrl이 null이며 기존 `test_reference_data_shape`가 실패함. 빌더는 metadata 없이도 표본을 배출 · 권장 수정: 출처 검증을 빌드 필수 조건으로 만들고 데이터를 재생성하며, 크롭·뼈대 추가 등 변경도 표시([CC 조건](https://creativecommons.org/licenses/by-sa/4.0/)).
- 위치: [track.js:62](/home/user/Seoul-Tennis-court/app/static/coach/js/track.js:62), [app.js:449](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:449) · 문제: 같은 색 옷의 다른 사람을 분석함 · 근거: 같은 시각에 등장한 두 사람도 하나로 묶이는 것을 재현. 선택한 사람의 위치·크기는 버리고 색만으로 추적을 시작하며 정밀 구간마다 초기화 · 권장 수정: 동시 등장 인물 병합 금지, 시간별 인물 ID 유지, 식별이 모호하면 재선택.
- 위치: [advice.js:172](/home/user/Seoul-Tennis-court/app/static/coach/js/advice.js:172), [app.js:215](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:215) · 문제: 측정 실패를 좋은 자세로 보상함 · 근거: 누락 지표는 건너뛰고 감점만 합산하므로 지표가 없는 입력도 96점·“아주 좋아요”. UI는 “크게 고칠 곳이 없다”고 표시하고 샷 순위에도 사용 · 권장 수정: 필수 지표·신뢰도 미달은 평가 불가 처리하고 순위에서 제외.
- 위치: [physview.js:55](/home/user/Seoul-Tennis-court/app/static/coach/js/physview.js:55), [physics.js:425](/home/user/Seoul-Tennis-court/app/static/coach/js/physics.js:425) · 문제: 공 발사각 범위를 라켓 면의 대칭 허용 오차로 잘못 설명함 · 근거: 엔진은 재조준 범위이며 고정 조준의 ±오차가 아니라고 명시하지만 UI는 `windowDeg/2`를 “라켓 면 ±…도”로 표시. 발사각과 라켓 면은 별개([연구](https://pmc.ncbi.nlm.nih.gov/articles/PMC2577482/)) · 권장 수정: 공 발사각 범위로 표현하고 고정 조준·라켓 충돌 모델을 구분.
- 위치: [advice.js:178](/home/user/Seoul-Tennis-court/app/static/coach/js/advice.js:178), [swing.js:147](/home/user/Seoul-Tennis-court/app/static/coach/js/swing.js:147) · 문제: cm 교정량과 “±오차”가 실제 정확도보다 정밀해 보임 · 근거: 오차는 프레임 간격만 반영하며 공·라켓 검출 오차와 자세 추정 오차는 빠짐. 허용 오차를 키의 0.12배로 잘라 큰 불확실성에서도 “60cm 더 앞”을 출력하는 것을 재현 · 권장 수정: 샘플링 오차라고 명시하고 불확실성이 크면 수치 처방을 보류.
- 위치: [physview.js:73](/home/user/Seoul-Tennis-court/app/static/coach/js/physview.js:73), [advice.js:154](/home/user/Seoul-Tennis-court/app/static/coach/js/advice.js:154) · 문제: “동호인은 수평·위로”, “면 5도 수정”을 일반 처방으로 제시함 · 근거: 자체 엔진도 타점 2m·125km/h에서 약 −2.0~−0.85°의 하향 서브를 허용함. 네트·아웃 결과만으로 면·속도·회전 중 원인을 분리할 수 없음 · 권장 수정: 조건부 연습 제안으로 바꾸고 고정 각도 처방 삭제.
- 위치: [advice.js:100](/home/user/Seoul-Tennis-court/app/static/coach/js/advice.js:100), [advice.js:117](/home/user/Seoul-Tennis-court/app/static/coach/js/advice.js:117) · 문제: 왼손잡이에게 반대 손을 지시하고 가슴 각도로 골반을 진단함 · 근거: “왼손으로 라켓 목”, “왼손 포핸드”가 고정 문자열이며 `bh2_rotation`은 `hipsAtContact` 대신 `chestAtContact` 사용 · 권장 수정: 주손/반대손 표현과 실제 골반 지표 사용.
- 위치: [advice.js:107](/home/user/Seoul-Tennis-court/app/static/coach/js/advice.js:107) · 문제: 피니시 한 장으로 감속 원인을 단정하고 반대 어깨 피니시를 강제함 · 근거: 손목의 몸 옆 위치만으로 “맞기 전부터 느려졌다”고 추론함. 기본 지도에서도 허리부터 어깨 위까지 다양한 마무리를 허용([USTA](https://www.usta.com/es/content/dam/usta/sections/southern/pdf/net-generation-high-school-team-tennis-manual.pdf)) · 권장 수정: 시간에 따른 감속을 확인하고 피니시 유형별 예외 적용.
- 위치: [build_reference.mjs:49](/home/user/Seoul-Tennis-court/tools/coach/build_reference.mjs:49), [metrics.js:52](/home/user/Seoul-Tennis-court/app/static/coach/js/metrics.js:52) · 문제: 자동 분류한 사진 분포가 검증된 코칭 기준처럼 제시됨 · 근거: 공 없이 손목 위치로 임팩트를 분류하고 그 손목 지표를 다시 정상 범위로 사용함. 원핸드·투핸드도 같은 백핸드 분포이며 서브 트로피는 6장뿐이라 기본 임계값 사용 · 권장 수정: 수동 검수·유형 분리·최소 표본 기준과 실제 기준 출처 표시.
- 위치: [app.js:111](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:111), [app.js:161](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:161), [app.js:236](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:236) · 문제: 분석 구간·“한 장씩” 조작이 안내와 다름 · 근거: 짧은 영상에서 시작값이 음수가 되거나 끝값이 길이를 초과할 수 있고, 스윙 모드는 알리지 않고 첫 40초만 분석. 보정은 실제 프레임 인덱스가 아닌 추정 step 덧셈 · 권장 수정: 구간 불변식 보장, 절단 안내/트리밍, 실제 프레임 시각 기준 이동.
- 위치: [app.js:476](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:476), [app.js:516](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:516) · 문제: 샷 목록 썸네일이 생성되지 않음 · 근거: working 화면에서 `renderSession()`이 `thumbs()`를 호출하므로 첫 `currentView() !== 'session'` 검사에서 즉시 종료 · 권장 수정: session 표시 후 실행하고 재진입 시 재개.
- 위치: [app.js:335](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:335), [app.js:385](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:385) · 문제: 왼손잡이의 저장한 기준 자세가 반대로 표시됨 · 근거: 저장할 때 오른손 기준으로 정규화하지만 `drawRef()`는 `mine`이면 뒤집기를 생략. ghost와 나란히 비교가 불일치 · 권장 수정: 저장 표본도 동일한 정규화·표시 규약 적용.
- 위치: [ui.js:39](/home/user/Seoul-Tennis-court/app/static/coach/js/ui.js:39) · 문제: 모바일 보조기술로 시트를 안정적으로 조작하기 어려움 · 근거: dialog 이름·초기 포커스·포커스 복원·배경 inert·명시적 닫기가 없고 화면 전환도 포커스를 이동하지 않음 · 권장 수정: 이름 있는 dialog와 포커스 관리, 닫기 버튼 및 뒤로가기 처리 추가.
- 위치: [app.js:356](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:356), [draw.js:100](/home/user/Seoul-Tennis-court/app/static/coach/js/draw.js:100) · 문제: 공유 실패가 무응답이며 영상에서 나온 실제 사진이 공유됨 · 근거: 카드 생성·`toBlob()`은 try 밖이고 null도 검사하지 않음. PNG는 얼굴·배경이 포함된 stage를 복사 · 권장 수정: 준비 완료까지 공유 비활성화, 전체 오류 처리, “현재 장면 사진 공유” 안내와 뼈대만 공유 옵션.
- 위치: [coach_engine.test.mjs:167](/home/user/Seoul-Tennis-court/tests/js/coach_engine.test.mjs:167), [test_coach.py:16](/home/user/Seoul-Tennis-court/tests/test_coach.py:16) · 문제: 실제 세션 실패를 잡는 테스트가 없음 · 근거: 합성 엔진 테스트에는 브라우저 흐름이 없고, Python 테스트 앱에는 실제 캐시 middleware도 없음 · 권장 수정: seek 지연/누락·추론 예외·취소/뒤로가기/재선택·동색 인물·왼손 표시·공유 실패·실제 응답 헤더 회귀 테스트 추가.

**사소**

- 위치: [coach.py:55](/home/user/Seoul-Tennis-court/app/routers/coach.py:55) · 문제: vendor 업데이트가 최대 30일 늦게 반영될 수 있음 · 근거: 고정 URL에 `immutable` 적용 · 권장 수정: 모델·WASM·JS를 같은 버전 또는 콘텐츠 해시 경로로 배포.
- 위치: [app.js:350](/home/user/Seoul-Tennis-court/app/static/coach/js/app.js:350), [coach.css:99](/home/user/Seoul-Tennis-court/app/static/coach/coach.css:99) · 문제: 사진 로딩 실패를 알리지 않고 일부 조작 영역이 작음 · 근거: 이미지 onerror가 없으며 선수 칩 높이는 36px, 순간/보정 버튼은 40px · 권장 수정: 사진 실패 안내·재시도와 44px 수준 터치 영역 확보.

검증: JS 테스트 파일 2개 통과, Python 출처 검사 실패·캐시 정책 검사 통과. HTTP 테스트 전체는 이 환경에서 완료하지 못했습니다. 자동 영상 업로드·파일명 XSS 경로는 발견하지 않았고, 선수 이미지는 CORS 설정 후 별도 캔버스에 그려 공유 카드 오염 경로도 확인되지 않았습니다. 주요 노랑/초록 텍스트 대비는 양호합니다.

먼저 고칠 6가지:

1. 분석 취소·예외·콜백 정리를 하나의 종료 경로로 통합.
2. seek 직렬화와 파일별 작업 ID로 화면·history 경쟁 제거.
3. 긴 영상 구간 처리와 메모리 상한 도입.
4. 측정 불충분 시 점수·교정량·샷 순위 산출 중단.
5. 발사각/라켓 면 혼동과 단정적인 코칭 문구 수정.
6. 출처가 검증된 reference.json 재생성 및 배포 테스트 필수화.

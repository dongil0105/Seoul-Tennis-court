파일 변경 없이 검토했습니다. `node --test tests/js/coach_physics.test.mjs`는 통과했지만, 아래 합성 입력에서는 추가 버그가 재현됐습니다.

- **치명 — 위치:** [clean.js:38](/home/user/Seoul-Tennis-court/app/static/coach/js/clean.js:38) — **문제:** 좌우 보정 상태를 잘못 누적합니다.
  **근거:** `flipped`는 이미 보정된 이전 자세에 대한 이번 프레임의 교환 여부인데 다시 XOR합니다. `[오류, 정상×4]` 입력이 전부 오류 방향으로 출력됐습니다. **권장:** `parity[i] = Number(flipped)`로 기록하고, 절대 좌우 판별이 불확실하면 사용자 손잡이 정보와 함께 보류하십시오.

- **치명 — 위치:** [swing.js:51](/home/user/Seoul-Tennis-court/app/static/coach/js/swing.js:51) — **문제:** 느린 스윙과 슬로모션을 구분할 수 없는 값으로 `sf`를 결정합니다.
  **근거:** 실제 최고속도 2m/s도 약 4.5배 슬로모션으로 취급하여 시간창·동작 간격을 왜곡합니다. **권장:** 촬영/재생 시간 매핑 또는 사용자 입력으로 `sf`를 받고, 240→30fps는 8, 정상 재생 240fps는 1로 구분하십시오. 가변 슬로모션은 구간별 매핑이 필요합니다.

- **치명 — 위치:** [swing.js:52](/home/user/Seoul-Tennis-court/app/static/coach/js/swing.js:52) — **문제:** 완전히 정지한 자세에서도 스윙을 생성합니다.
  **근거:** `vmax=thr=0`이면 평탄한 모든 점이 후보입니다. 12초 정지 입력에서 `peak=0, sf=12, conf=1` 스윙이 재현됐습니다. **권장:** 최소 변위·잡음 대비 피크 돌출도·지속시간을 요구하고, 무동작은 즉시 반환하십시오. 보행의 팔 흔들림도 별도 배제해야 합니다.

- **중요 — 위치:** [swing.js:34](/home/user/Seoul-Tennis-court/app/static/coach/js/swing.js:34), [swing.js:105](/home/user/Seoul-Tennis-court/app/static/coach/js/swing.js:105) — **문제:** 속도의 시간 위치와 필터 폭이 FPS에 종속됩니다.
  **근거:** 구간 평균속도를 끝 프레임에 붙여 약 반 프레임 늦고, 다시 12ms를 더합니다. 2회 이동평균은 속도 표본 5개를 사용하여 25fps에서 피크를 크게 뭉갭니다. **권장:** 실제 시간 기반 국소 다항식으로 위치를 평활화·미분하고, 속도 시각은 구간 중앙에 두십시오.

- **중요 — 위치:** [geom.js:136](/home/user/Seoul-Tennis-court/app/static/coach/js/geom.js:136), [swing.js:34](/home/user/Seoul-Tennis-court/app/static/coach/js/swing.js:34) — **문제:** 결측 구간을 정상 동작처럼 연결하며 NaN 검증도 부족합니다.
  **근거:** `poseAt`은 긴 공백도 보간하고 범위 밖은 끝 자세로 대체합니다. 속도는 0.5초 미만 공백을 연결하며, NaN은 `vmax`까지 전파됩니다. **권장:** 타임스탬프·좌표를 검증하고 공백에서 구간을 분리하십시오. 결측을 가로지르는 접촉·키 순간은 미측정으로 반환하십시오.

- **중요 — 위치:** [swing.js:95](/home/user/Seoul-Tennis-court/app/static/coach/js/swing.js:95) — **문제:** 접촉 시각의 근거가 약합니다.
  **근거:** 서브의 최대 `코−손목 높이`는 머리 숙임에도 변하고, 스트로크의 손목 최고속도+12ms는 실제 충돌을 식별하지 못합니다. **권장:** 전진 손목속도·팔꿈치 신전·어깨 회전·팔 뻗음의 결합으로 후보 구간을 찾고, 유형별 라벨 영상으로 보정하십시오. 결과는 ‘추정 접촉 구간’으로 제시해야 합니다.

- **중요 — 위치:** [swing.js:121](/home/user/Seoul-Tennis-court/app/static/coach/js/swing.js:121) — **문제:** 트로피·백스윙 끝·토스·피니시의 정의가 실제 사건과 다릅니다.
  **근거:** 최대 무릎 굽힘은 트로피와 다를 수 있고, 가장 뒤쪽 손목은 루프 백스윙의 종료가 아닙니다. 반대 손 최고점은 공 방출이 아니며 피니시는 고정 +0.3초입니다. **권장:** 트로피는 양팔 구성과 몸통 자세, 백스윙 끝은 지속적인 전진 전환으로 찾고, 무릎 로딩·토스팔 최고점은 별도 이름으로 유지하십시오.

- **중요 — 위치:** [swing.js:45](/home/user/Seoul-Tennis-court/app/static/coach/js/swing.js:45), [swing.js:81](/home/user/Seoul-Tennis-court/app/static/coach/js/swing.js:81) — **문제:** 왼손잡이·양손 백핸드·높은 스트로크 분류가 취약합니다.
  **근거:** 손잡이 기본값은 오른손이며, 손목 간 최소거리 한 번만 20cm 미만이면 양손입니다. 준비 때 두 손을 모은 포핸드도 해당하고, 머리 위 손목은 서브/스매시를 구분하지 못합니다. **권장:** 손잡이를 명시적으로 받고, 키로 정규화한 양손 거리·동행 속도의 지속성과 동작 순서를 사용하며 ‘불명’을 허용하십시오.

- **중요 — 위치:** [swing.js:109](/home/user/Seoul-Tennis-court/app/static/coach/js/swing.js:109), [geom.js:113](/home/user/Seoul-Tennis-court/app/static/coach/js/geom.js:113) — **문제:** 손목 이동을 타구 방향으로, 카메라의 위를 중력 방향으로 간주합니다.
  **근거:** 서브의 작은 수평 이동·와이퍼 팔로스루가 방향을 뒤집습니다. 3프레임 기준도 FPS마다 다르며, `d=0`조차 `side`가 됩니다. **권장:** 고정된 타구 방향을 사용자/코트 정보로 정하고 카메라 기울기를 보정하십시오. 축 길이가 작은 경우 방향·몸 기준 특징을 무효화하십시오.

- **중요 — 위치:** [swing.js:139](/home/user/Seoul-Tennis-court/app/static/coach/js/swing.js:139) — **문제:** `conf`가 분석 정확도처럼 보이지만 관절 가시성 평균뿐입니다.
  **근거:** [MediaPipe의 visibility](https://developers.google.cn/edge/api/mediapipe/js/tasks-vision.landmark)는 보임의 가능성이며 접촉 시각 정확도가 아닙니다. **권장:** 가시성·결측·보정량·후보 간 점수차를 분리하고, 필터/랜드마크 변동에 따른 시각 범위를 보고하십시오. 25fps의 40ms 간격에서 소수점 보간만으로 ms 정확도를 주장해서는 안 됩니다.

- **중요 — 위치:** [metrics.js:90](/home/user/Seoul-Tennis-court/app/static/coach/js/metrics.js:90), [metrics.js:110](/home/user/Seoul-Tennis-court/app/static/coach/js/metrics.js:110) — **문제:** 카메라 팬·줌·선수 이동이 점프와 신체 이동으로 섞입니다.
  **근거:** 과거 발의 화면 y와 현재 손목/발을 비교하고, 서로 다른 프레임의 머리·골반 픽셀 변위를 접촉 시점의 배율 하나로 환산합니다. **권장:** 배경 기반 영상 안정화와 프레임별 배율 보정이 필요합니다. 골격만 있다면 카메라 이동과 전신 이동을 분리할 수 없어 해당 지표를 제한해야 합니다.

- **중요 — 위치:** [metrics.js:39](/home/user/Seoul-Tennis-court/app/static/coach/js/metrics.js:39), [metrics.js:97](/home/user/Seoul-Tennis-court/app/static/coach/js/metrics.js:97), [physics.js:398](/home/user/Seoul-Tennis-court/app/static/coach/js/physics.js:398) — **문제:** 손목·발 기준 높이와 공의 접촉 높이가 혼동될 수 있습니다.
  **근거:** `wristHeight`는 점프 중 떠 있는 발부터의 높이이고, `contactHeight`는 손목 높이/신장인 반면 물리는 공 중심의 미터를 받습니다. **권장:** `wristHeightOverLowestFootH`, `wristHeightOverGroundH`, `ballContactHeightM`로 구분하십시오. 라켓 오프셋을 모르면 공 높이는 시나리오 범위로만 입력하십시오.

- **중요 — 위치:** [metrics.js:34](/home/user/Seoul-Tennis-court/app/static/coach/js/metrics.js:34), [metrics.js:110](/home/user/Seoul-Tennis-court/app/static/coach/js/metrics.js:110), [metrics.js:130](/home/user/Seoul-Tennis-court/app/static/coach/js/metrics.js:130) — **문제:** 여러 이름이 실제 측정량보다 강한 코칭 의미를 가집니다.
  **근거:** `weightShift`는 골반 이동이지 발 하중 이동이 아니며, `headMove`는 왕복 흔들림을 놓치는 양 끝 변위입니다. `abs(sep)`는 꼬임 방향을 지우고 NaN 비율은 `platform`이 됩니다. **권장:** 골반 이동·머리 RMS/최대편차·손잡이 정규화 부호 있는 꼬임을 보고하고, 스탠스 불명 상태를 추가하십시오.

- **중요 — 위치:** [geom.js:85](/home/user/Seoul-Tennis-court/app/static/coach/js/geom.js:85), [geom.js:94](/home/user/Seoul-Tennis-court/app/static/coach/js/geom.js:94) — **문제:** 개인 신장과 픽셀 배율을 과도하게 확정합니다.
  **근거:** `0.779`를 명백한 오상수라고 단정할 근거는 없지만, 모든 체형·자세에서 일정하다는 보장은 없습니다. `pxPerMeter`도 약한 원근 근사이며 신장 추정은 매 프레임 바뀝니다. **권장:** 고가시성 구간의 뼈 길이 중앙값으로 개인 기준을 고정하고, 배율 분산·유효 마디 수를 보고하며 `h || 1` 대체를 제거하십시오.

- **중요 — 위치:** [clean.js:59](/home/user/Seoul-Tennis-court/app/static/coach/js/clean.js:59) — **문제:** 스파이크 보간과 판정이 시간·신체 크기를 무시합니다.
  **근거:** 불균일 시간에도 양옆 좌표를 1/2씩 섞고, 화면 높이의 6%라는 문턱은 5m/15m 촬영에 다르게 작동합니다. 화면에서 안 보이는 world-z 스파이크는 남습니다. **권장:** `α=(tb−ta)/(tc−ta)`로 보간하고, 신장 대비 잔차·뼈 길이·가시성으로 2D/3D를 함께 검사하십시오.

- **중요 — 위치:** [physics.js:448](/home/user/Seoul-Tennis-court/app/static/coach/js/physics.js:448) — **문제:** 착지의 사이드라인 아웃을 검사하지 않습니다.
  **근거:** `groundWindow({speedKmh:110,spin:'flat',startY:-8})`는 feasible이지만 하한 착지 y≈−4.548m로 단식 경계 −4.115m 밖입니다. **권장:** 네트 통과와 함께 착지 `(x,y)`의 전체 코트 포함 여부를 검사하십시오. 목표점만 코트 안으로 제한해서는 부족합니다.

- **중요 — 위치:** [physics.js:343](/home/user/Seoul-Tennis-court/app/static/coach/js/physics.js:343), [physics.js:402](/home/user/Seoul-Tennis-court/app/static/coach/js/physics.js:402) — **문제:** `toleranceDeg`는 고정된 조준 방향의 발사각 허용오차가 아닙니다.
  **근거:** 고도각마다 방위각을 다시 맞춥니다. 140km/h·3000rpm 슬라이스 와이드 서브에서 하한/상한 방위각이 약 −11.43°/−9.08°로 달랐습니다. **권장:** ‘재조준 가능한 고도각 범위’로 이름을 바꾸거나, 방위각을 고정하여 고도각×방위각 성공 영역을 계산하십시오.

- **중요 — 위치:** [physics.js:175](/home/user/Seoul-Tennis-court/app/static/coach/js/physics.js:175), [physics.js:199](/home/user/Seoul-Tennis-court/app/static/coach/js/physics.js:199), [physics.js:281](/home/user/Seoul-Tennis-court/app/static/coach/js/physics.js:281) — **문제:** 상수 검증 누락으로 무한 루프·가짜 착지가 가능합니다.
  **근거:** `dt=0` 또는 `elevScanStepDeg=0`은 루프 진행을 막습니다. `maxTime=.01`에서는 아직 높이 2.59m인 공을 착지로 반환했습니다. **권장:** 양수·유한값과 반복 상한을 검사하고, `landed:false, reason:'timeout'`을 반환하십시오.

- **사소 — 위치:** [physics.js:28](/home/user/Seoul-Tennis-court/app/static/coach/js/physics.js:28), [physics.js:59](/home/user/Seoul-Tennis-court/app/static/coach/js/physics.js:59) — **문제:** 네트 모델이 복식 지주·선형 높이로 고정됩니다.
  **근거:** 단식 지지점은 중심에서 5.029m이고 높이 1.07m입니다([ITF 규칙](https://itf.uberflip.com/i/623773-rules-of-tennis/5)). 현재는 6.399m를 사용합니다. **권장:** 단식 스틱 유무와 네트 형상을 선택 가능하게 하십시오. 중력·항력·탑스핀 부호와 RK4에서는 명백한 오류를 찾지 못했지만, 수치 정밀도는 실제 궤적 정확도가 아닙니다.

먼저 적용할 다섯 가지는 다음 순서입니다.

1. 좌우 보정 XOR 오류 수정과 연속 뒤집힘 회귀 검증.
2. 명시적 시간 매핑 도입, 정지·보행 오검출 차단.
3. 시간 기반 평활화·미분, 결측 구간 분리와 유효성 검사.
4. 접촉·키 순간을 복합 특징으로 추정하고 불확실성 구간 표시.
5. 손목/공·이동/하중의 지표 구분과 물리의 코트 경계·종료 검증.

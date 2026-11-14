// 스윙 코치 — 테니스 공 비행 물리. 의존성·DOM 없는 순수 ES 모듈 (브라우저와 Node 22 에서 그대로 동작).
//
// 좌표계 (m)
//   x : 서버 쪽 베이스라인(0) → 네트(11.885) → 상대 서비스라인(18.285) → 상대 베이스라인(23.77)
//   y : 좌우. 센터라인 0, 서버가 봤을 때 오른쪽이 +
//   z : 위. 높이는 모두 "공 중심" 기준
// 각도 (deg)
//   elevDeg : 발사 고도각 (+ 위, − 아래)      azimDeg : 방위각 (+ 는 +y, 즉 서버의 오른쪽)
// 규약
//   착지     : 공 중심이 z = 공 반지름에 닿는 순간(공 밑면이 지면에 닿음). 착지점은 그때의 공 중심 (x, y)
//   인/아웃  : 공 중심이 라인을 넘었는지로 판정 (라인에 살짝 걸치는 경우는 아웃으로 보는 보수적 판정)
//   네트     : 네트 평면에서 공 밑면이 코드 위에 있어야 통과 → clearance = z − 반지름 − netHeightAt(y)
//   네트 높이: 센터 스트랩 0.914 m 에서 포스트 1.07 m 까지 |y| 에 대해 선형 (팽팽한 줄 가운데를 당긴 V 자)
// 모델
//   중력 + 항력(Cd 일정) + 마그누스 양력. 양력계수는 Cross & Lindsey 의 스핀비 식
//   Cl = 1 / (2 + v / (r·ω)), 양력 방향은 ω̂ × v̂. 스핀 감쇠와 바람은 무시. 적분은 RK4.

export const COURT = Object.freeze({
  length: 23.77,
  netX: 11.885,
  nearServiceLineX: 5.485,
  farServiceLineX: 18.285,
  farBaselineX: 23.77,
  singlesHalfWidth: 4.115,
  doublesHalfWidth: 5.485,
  netCenterHeight: 0.914,
  netPostHeight: 1.07,
  netPostY: 6.399, // 복식 사이드라인 바깥 0.914 m
  targetInset: 0.4, // 서브 T/와이드 목표선은 라인 안쪽 0.4 m
});

// 모든 공개 함수는 인자의 `constants` 로 이 값들을 부분 덮어쓸 수 있다. 예: { Cd: 0, lift: false }
export const DEFAULTS = Object.freeze({
  ballMass: 0.057, // kg
  ballRadius: 0.033, // m
  airDensity: 1.21, // kg/m³
  gravity: 9.81, // m/s²
  Cd: 0.55, // 항력계수
  lift: true, // false 면 마그누스 양력을 끈다
  dt: 0.002, // s, RK4 한 스텝
  sampleDt: 0.02, // s, path 샘플 간격
  maxTime: 15, // s, 이 안에 착지하지 않으면 중단
  elevTolDeg: 0.01, // 고도각 한계를 이분법으로 좁히는 정밀도
  elevScanStepDeg: 3, // 이분법 구간을 찾는 격자 간격
  elevCapDeg: 30, // 이보다 높이 띄우는 로브성 궤적은 창 계산에서 제외
});

// 스핀 축 기울기: 0° = 순수 탑스핀, 90° = 순수 사이드스핀, 180° = 백스핀. 'flat' 은 스핀 없음.
export const SPIN_TILT_DEG = Object.freeze({ topspin: 0, kick: 45, slice: 75, backspin: 180 });

const DEG = Math.PI / 180;
const KMH = 3.6;

const withConstants = (overrides) => (overrides ? { ...DEFAULTS, ...overrides } : DEFAULTS);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const optional = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/** 네트 코드 높이 (m). 포스트 바깥은 포스트 높이로 본다. */
export function netHeightAt(y) {
  const frac = Math.min(Math.abs(y), COURT.netPostY) / COURT.netPostY;
  return COURT.netCenterHeight + (COURT.netPostHeight - COURT.netCenterHeight) * frac;
}

/** 양력계수 Cl = 1 / (2 + v / (r·ω)). speed m/s, spinRadS rad/s. */
export function liftCoefficient(speed, spinRadS, radius = DEFAULTS.ballRadius) {
  const surface = radius * spinRadS;
  return surface > 0 ? 1 / (2 + speed / surface) : 0;
}

// 각속도 벡터 (rad/s).
// (x 앞, y 오른쪽, z 위)는 왼손 좌표계라서 "오른손 법칙"으로 읽으면 헷갈린다. 여기서는 외적을 성분 공식 그대로
// 계산했을 때 표면 속도 = ω × r 이 되도록 ω 를 정의한다. 그러면 양력 방향 ω̂ × v̂ 도 같은 공식으로 맞게 나온다.
//   탑스핀 축 = 진행 방향에 수평으로 직교 → 공 윗면이 앞으로 돌고 양력은 아래로
//   사이드 축 = −sideSign·ẑ            → sideSign=+1(오른손잡이 슬라이스)이면 공이 −y(서버의 왼쪽)로 휜다
function spinVector(shot, azim) {
  const { spin, spinRpm, sideSign = 1 } = shot;
  if (spin === 'flat' || !(spinRpm > 0)) return [0, 0, 0];
  const tiltDeg = shot.tiltDeg ?? SPIN_TILT_DEG[spin];
  if (!Number.isFinite(tiltDeg)) throw new RangeError(`physics: unknown spin "${spin}"`);
  const w = (spinRpm * 2 * Math.PI) / 60;
  const top = w * Math.cos(tiltDeg * DEG);
  const side = w * Math.sin(tiltDeg * DEG) * Math.sign(sideSign || 1);
  return [-top * Math.sin(azim), top * Math.cos(azim), -side];
}

function launchState(shot, elevDeg, azimDeg) {
  const v = shot.speedKmh / KMH;
  const el = elevDeg * DEG;
  const az = azimDeg * DEG;
  const horiz = v * Math.cos(el);
  return {
    x0: shot.x0,
    y0: shot.y0,
    z0: shot.z0,
    vx: horiz * Math.cos(az),
    vy: horiz * Math.sin(az),
    vz: v * Math.sin(el),
    w: spinVector(shot, az),
  };
}

// 상태 s = [x, y, z, vx, vy, vz] 를 h 초 전진시키는 RK4 스텝 함수를 만든다.
// 가속도는 속도만의 함수라서 위치는 각 단계의 속도로 적분하면 된다.
function makeStepper(c, w) {
  const k = (0.5 * c.airDensity * Math.PI * c.ballRadius ** 2) / c.ballMass; // ½ρA/m
  const kd = k * c.Cd;
  const g = c.gravity;
  const wMag = Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
  const hasLift = Boolean(c.lift) && wMag > 0;
  const ux = hasLift ? w[0] / wMag : 0;
  const uy = hasLift ? w[1] / wMag : 0;
  const uz = hasLift ? w[2] / wMag : 0;
  const a = new Float64Array(3);

  function accel(vx, vy, vz) {
    const v = Math.sqrt(vx * vx + vy * vy + vz * vz);
    const d = kd * v; // 항력: −½ρA·Cd·v·v⃗ / m
    let ax = -d * vx;
    let ay = -d * vy;
    let az = -d * vz - g;
    if (hasLift && v > 0) {
      const l = k * liftCoefficient(v, wMag, c.ballRadius) * v; // 양력: ½ρA·Cl·v²·(ω̂ × v̂) / m
      ax += l * (uy * vz - uz * vy);
      ay += l * (uz * vx - ux * vz);
      az += l * (ux * vy - uy * vx);
    }
    a[0] = ax;
    a[1] = ay;
    a[2] = az;
  }

  return function step(s, h) {
    const vx = s[3], vy = s[4], vz = s[5];
    accel(vx, vy, vz);
    const k1x = a[0], k1y = a[1], k1z = a[2];
    const v2x = vx + 0.5 * h * k1x, v2y = vy + 0.5 * h * k1y, v2z = vz + 0.5 * h * k1z;
    accel(v2x, v2y, v2z);
    const k2x = a[0], k2y = a[1], k2z = a[2];
    const v3x = vx + 0.5 * h * k2x, v3y = vy + 0.5 * h * k2y, v3z = vz + 0.5 * h * k2z;
    accel(v3x, v3y, v3z);
    const k3x = a[0], k3y = a[1], k3z = a[2];
    const v4x = vx + h * k3x, v4y = vy + h * k3y, v4z = vz + h * k3z;
    accel(v4x, v4y, v4z);
    const h6 = h / 6;
    s[0] += h6 * (vx + 2 * v2x + 2 * v3x + v4x);
    s[1] += h6 * (vy + 2 * v2y + 2 * v3y + v4y);
    s[2] += h6 * (vz + 2 * v2z + 2 * v3z + v4z);
    s[3] += h6 * (k1x + 2 * k2x + 2 * k3x + a[0]);
    s[4] += h6 * (k1y + 2 * k2y + 2 * k3y + a[1]);
    s[5] += h6 * (k1z + 2 * k2z + 2 * k3z + a[2]);
  };
}

// 스텝 [prev → cur] 사이에서 좌표축 i 가 target 을 지나는 지점.
// 선형 비율만큼 부분 스텝을 밟은 뒤 남은 오차(≪ 1 mm)를 속도로 한 번 더 보정한다.
function crossing(step, prev, cur, i, target, dt) {
  const s = prev.slice();
  const partial = ((target - prev[i]) / (cur[i] - prev[i])) * dt;
  step(s, partial);
  const fix = (target - s[i]) / s[i + 3];
  s[0] += s[3] * fix;
  s[1] += s[4] * fix;
  s[2] += s[5] * fix;
  return { s, t: partial + fix };
}

// 발사 상태에서 첫 착지까지 적분한다. 네트에 걸리더라도 멈추지 않고 clearance(음수)만 기록한다.
function fly(launch, c, wantPath) {
  const { dt, ballRadius: groundZ } = c;
  const step = makeStepper(c, launch.w);
  const s = Float64Array.of(launch.x0, launch.y0, launch.z0, launch.vx, launch.vy, launch.vz);
  const prev = new Float64Array(6);
  const path = wantPath ? [{ t: 0, x: s[0], y: s[1], z: s[2] }] : null;
  const sampleEvery = Math.max(1, Math.round(c.sampleDt / dt));
  const maxSteps = Math.ceil(c.maxTime / dt);
  let t = 0;
  let maxHeight = s[2];
  let net = null;
  let end = s[2] <= groundZ ? { s, t: 0 } : null; // 이미 지면 높이면 비행 없음

  for (let n = 1; n <= maxSteps && !end; n++) {
    prev.set(s);
    step(s, dt);
    if (net === null && prev[0] < COURT.netX && s[0] >= COURT.netX) {
      const hit = crossing(step, prev, s, 0, COURT.netX, dt);
      const z = hit.s[2];
      const y = hit.s[1];
      net = { z, y, t: t + hit.t, clearance: z - c.ballRadius - netHeightAt(y) };
    }
    if (s[2] <= groundZ) {
      end = crossing(step, prev, s, 2, groundZ, dt);
      end.t += t;
      break;
    }
    t = n * dt;
    if (s[2] > maxHeight) maxHeight = s[2];
    if (path && n % sampleEvery === 0) path.push({ t, x: s[0], y: s[1], z: s[2] });
  }
  if (!end) end = { s, t }; // maxTime 초과 (비현실적 입력)
  if (net && net.t > end.t) net = null; // 같은 스텝 안에서 네트 앞에 먼저 떨어진 경우

  const [x, y, z, vx, vy, vz] = end.s;
  if (path && end.t > path[path.length - 1].t) path.push({ t: end.t, x, y, z });
  return {
    landing: { x, y, t: end.t, angleDeg: Math.atan2(-vz, Math.hypot(vx, vy)) / DEG },
    net,
    maxHeight,
    speedAtLandingKmh: Math.sqrt(vx * vx + vy * vy + vz * vz) * KMH,
    path,
  };
}

/**
 * 공 한 개의 비행.
 * spin: 'topspin' | 'backspin' | 'slice' | 'kick' | 'flat' ('flat' 은 spinRpm 을 무시).
 * sideSign: 사이드스핀 성분의 방향. +1 = 오른손잡이 슬라이스/킥(−y 로 휨), −1 = 왼손잡이.
 * tiltDeg: 스핀 축 기울기를 직접 지정 (0 탑스핀 … 90 사이드스핀 … 180 백스핀). 생략하면 SPIN_TILT_DEG[spin].
 * 반환: { landing:{x,y,t,angleDeg}, net:{z,y,t,clearance}|null, maxHeight, speedAtLandingKmh, path:[{t,x,y,z}] }
 *   net 은 네트 평면에 닿기 전에 떨어지면 null. clearance < 0 이면 네트에 걸린 것.
 */
export function simulate({
  x0 = 0,
  y0 = 0,
  z0,
  speedKmh,
  elevDeg,
  azimDeg = 0,
  spinRpm = 0,
  spin = 'topspin',
  sideSign = 1,
  tiltDeg,
  constants,
} = {}) {
  if (![x0, y0, z0, speedKmh, elevDeg, azimDeg].every(Number.isFinite)) {
    throw new TypeError('simulate: z0, speedKmh, elevDeg must be finite numbers');
  }
  const shot = { x0, y0, z0, speedKmh, spinRpm, spin, sideSign, tiltDeg };
  return fly(launchState(shot, elevDeg, azimDeg), withConstants(constants), true);
}

// 목표선에 떨어지도록 방위각을 맞춰 날린다.
// 모델이 수직축 회전에 대칭이라, 고도각이 같으면 방위각을 바꿔도 궤적은 발사점을 중심으로 통째로 돌 뿐이다.
// 그래서 az = 0 시험 발사 한 번으로 착지 거리 R 과 스핀에 의한 휨각 δ 를 얻으면 필요한 방위각이 바로 나온다.
function flyAimed(shot, elevDeg, aim, c) {
  const probe = fly(launchState(shot, elevDeg, 0), c, false);
  const dx = probe.landing.x - shot.x0;
  const dy = probe.landing.y - shot.y0;
  const azimDeg = aim(Math.hypot(dx, dy), Math.atan2(dy, dx)) / DEG;
  const flight = Math.abs(azimDeg) < 1e-9 ? probe : fly(launchState(shot, elevDeg, azimDeg), c, false);
  flight.azimDeg = azimDeg;
  return flight;
}

// pred(a) = false, pred(b) = true 인 구간을 tol 이하로 좁힌다.
function bisect(pred, a, b, tol) {
  while (b - a > tol) {
    const mid = (a + b) / 2;
    if (pred(mid)) b = mid;
    else a = mid;
  }
  return [a, b];
}

const NO_WINDOW = Object.freeze({ minElevDeg: NaN, maxElevDeg: NaN, capped: false });

// 고도각 창: tooShort(네트에 걸림/너무 짧음)가 풀리는 첫 각도 ~ tooLong(라인을 넘음)이 시작되는 첫 각도.
// 두 조건은 직선성 궤적 범위(≤ elevCapDeg)에서 고도각에 단조이므로, 격자로 첫 전환 구간을 찾고 이분법으로 좁힌다.
function elevationWindow(flyAt, tooShort, tooLong, startDeg, c) {
  const tol = c.elevTolDeg / 2;
  const step = c.elevScanStepDeg;
  let e0 = startDeg;
  let r0 = flyAt(e0);
  while (!tooShort(r0) && e0 > -85) {
    e0 -= 2 * step; // 강한 백스핀 등으로 시작 각도에서 이미 넘어가면 더 아래에서 출발
    r0 = flyAt(e0);
  }
  let short0 = tooShort(r0);
  let long0 = tooLong(r0);
  let minElevDeg = short0 ? null : e0;
  let maxElevDeg = long0 ? e0 : null;
  while (e0 < c.elevCapDeg && (minElevDeg === null || maxElevDeg === null)) {
    const e1 = Math.min(e0 + step, c.elevCapDeg);
    const r1 = flyAt(e1);
    const short1 = tooShort(r1);
    const long1 = tooLong(r1);
    if (minElevDeg === null && short0 && !short1) {
      minElevDeg = bisect((e) => !tooShort(flyAt(e)), e0, e1, tol)[1];
    }
    if (maxElevDeg === null && !long0 && long1) {
      maxElevDeg = bisect((e) => tooLong(flyAt(e)), e0, e1, tol)[0];
    }
    e0 = e1;
    short0 = short1;
    long0 = long1;
  }
  if (minElevDeg === null) return NO_WINDOW; // 상한까지 올려도 네트를 못 넘는다
  const capped = maxElevDeg === null; // 상한까지 올려도 라인을 넘지 않는 느린 공
  return { minElevDeg, maxElevDeg: capped ? c.elevCapDeg : maxElevDeg, capped };
}

// 서브·스트로크 공통: 창을 풀고, 창 한가운데 각도("best")의 궤적을 요약한다.
function solveWindow(shot, aim, tooShort, tooLong, c) {
  const usable =
    [shot.x0, shot.y0, shot.z0, shot.speedKmh].every(Number.isFinite) &&
    shot.speedKmh > 0 &&
    shot.z0 > c.ballRadius &&
    shot.x0 < COURT.netX;
  const flyAt = (elevDeg) => flyAimed(shot, elevDeg, aim, c);
  // 시작 각도: 컨택점에서 네트 상단을 잇는 직선보다 6° 아래 (중력 때문에 여기서는 네트 앞에 떨어진다)
  const sightDeg = usable
    ? Math.atan2(COURT.netCenterHeight + c.ballRadius - shot.z0, COURT.netX - shot.x0) / DEG
    : 0;
  const win = usable ? elevationWindow(flyAt, tooShort, tooLong, Math.floor(sightDeg) - 6, c) : NO_WINDOW;

  const span = win.maxElevDeg - win.minElevDeg;
  const feasible = span > 0;
  const windowDeg = feasible ? span : 0;
  // simulate() 에 그대로 넣을 수 있는 발사 조건 (방위각은 그 고도각에서 목표선에 맞춘 값)
  const launchAt = (elevDeg, f = flyAt(elevDeg)) => ({ ...shot, elevDeg, azimDeg: f.azimDeg });
  let best = null;
  let minLaunch = null;
  let maxLaunch = null;
  if (Number.isFinite(span)) {
    const elevDeg = (win.minElevDeg + win.maxElevDeg) / 2;
    const f = flyAt(elevDeg);
    best = {
      elevDeg,
      azimDeg: f.azimDeg,
      netClearanceCm: f.net ? f.net.clearance * 100 : NaN,
      netY: f.net ? f.net.y : NaN,
      landingDepthM: f.landing.x - COURT.netX,
      flightTimeS: f.landing.t,
      landingSpeedKmh: f.speedAtLandingKmh,
      launch: launchAt(elevDeg, f),
    };
    minLaunch = launchAt(win.minElevDeg);
    maxLaunch = launchAt(win.maxElevDeg);
  }
  return {
    minElevDeg: win.minElevDeg,
    maxElevDeg: win.maxElevDeg,
    windowDeg,
    toleranceDeg: windowDeg / 2, // best 각도에서 위아래로 허용되는 발사각 오차 (±)
    feasible,
    maxElevCapped: win.capped,
    best,
    minLaunch, // 하한: 네트를 겨우 넘는 궤적
    maxLaunch, // 상한: 라인에 겨우 떨어지는 궤적
  };
}

function serveGeometry({ court, standY, contactForward, target }) {
  if (court !== 'deuce' && court !== 'ad') throw new RangeError(`physics: unknown court "${court}"`);
  const inset = {
    T: COURT.targetInset,
    body: COURT.singlesHalfWidth / 2,
    wide: COURT.singlesHalfWidth - COURT.targetInset,
  }[target]; // 센터라인에서 목표선까지의 거리
  if (inset === undefined) throw new RangeError(`physics: unknown target "${target}"`);
  const side = court === 'deuce' ? 1 : -1; // 듀스 코트: 서버는 센터마크 오른쪽(+y)에 서고 대각선 왼쪽(−y) 박스로 넣는다
  const x0 = contactForward;
  const y0 = side * standY || 0; // (−0 방지)
  const targetY = -side * inset;
  // 컨택점 → 서비스라인 위 목표점 직선이 네트를 지나는 곳
  const netFrac = (COURT.netX - x0) / (COURT.farServiceLineX - x0);
  const netY = y0 + netFrac * (targetY - y0);
  return { x0, y0, targetY, netY, distance: Math.hypot(COURT.farServiceLineX - x0, targetY - y0) };
}

/**
 * 서브의 발사 고도각 허용 창.
 * court: 'deuce' | 'ad'. standY: 센터마크에서 자기 쪽으로 떨어진 거리(m). contactForward: 베이스라인 안쪽 컨택 거리(m).
 * target: 'T'(센터라인 안쪽 0.4 m) | 'body'(박스 한가운데) | 'wide'(단식 사이드라인 안쪽 0.4 m) — 이 선 위에 떨어지도록 방위각을 푼다.
 * 반환: { minElevDeg(네트를 넘는 최저각), maxElevDeg(서비스라인 안에 떨어지는 최고각), windowDeg, toleranceDeg, feasible,
 *         maxElevCapped, best:{elevDeg, azimDeg, netClearanceCm, netY, landingDepthM(네트 뒤 거리), flightTimeS, landingSpeedKmh, launch},
 *         minLaunch, maxLaunch, netHeightOnPathCm, distanceToServiceLineM, contact:{x0,y0,z0}, targetY }
 *   best 는 창 한가운데 각도. best.launch / minLaunch / maxLaunch 는 simulate() 에 그대로 넣어 궤적을 그릴 수 있다.
 *   불가능(min ≥ max)하면 windowDeg = 0, feasible = false 이고 best 는 두 한계의 중간각(네트에 걸리거나 길다).
 *   어떤 각도로도 네트를 못 넘으면 min/max 는 NaN, best·minLaunch·maxLaunch 는 null.
 *   elevCapDeg(30°)까지 올려도 라인을 넘지 않는 느린 공은 maxElevDeg = elevCapDeg, maxElevCapped = true.
 */
export function serveWindow({
  contactHeight,
  speedKmh,
  spinRpm = 0,
  spin = 'flat',
  court = 'deuce',
  standY = 0.3,
  contactForward = 0.3,
  target = 'T',
  rightHanded = true,
  tiltDeg,
  constants,
} = {}) {
  const c = withConstants(constants);
  const geo = serveGeometry({ court, standY, contactForward, target });
  const shot = {
    x0: geo.x0, y0: geo.y0, z0: contactHeight, speedKmh, spinRpm, spin,
    sideSign: rightHanded ? 1 : -1, ...optional({ tiltDeg, constants }),
  };
  // 착지 y = y0 + R·sin(az + δ) = targetY
  const aim = (R, delta) => Math.asin(clamp((geo.targetY - geo.y0) / R, -0.99, 0.99)) - delta;
  const tooShort = (f) => f.net === null || f.net.clearance < 0;
  const tooLong = (f) => f.landing.x > COURT.farServiceLineX;
  const result = solveWindow(shot, aim, tooShort, tooLong, c);
  const netY = result.best && Number.isFinite(result.best.netY) ? result.best.netY : geo.netY;
  return {
    ...result,
    netHeightOnPathCm: netHeightAt(netY) * 100,
    distanceToServiceLineM: geo.distance,
    contact: { x0: geo.x0, y0: geo.y0, z0: contactHeight },
    targetY: geo.targetY,
  };
}

/**
 * 스트로크(포핸드/백핸드)의 발사 고도각 허용 창: 네트를 넘고 상대 베이스라인 안에 떨어지는 범위.
 * fromBaseline: 자기 베이스라인 뒤(+)/안(−) 거리. minDepthFromNet: 네트 뒤로 최소 이만큼은 가야 한다(짧은 공 제외).
 * startY: 컨택 지점의 좌우 위치 (기본 3 m, 단식 사이드라인 안쪽 약 1.1 m).
 * crossCourt: false = 사이드라인과 평행한 다운더라인, true = 반대편 같은 위치(y = −startY)를 향한 크로스
 *   (크로스는 낮은 네트 가운데를 지나고 코트가 대각선만큼 길어진다).
 *   목표점은 상대 베이스라인 위이며 단식 사이드라인 안쪽 0.4 m 를 넘지 않게 제한한다. 방위각은 컨택점 → 목표점 직선에 맞춘다.
 * 반환: serveWindow 와 같은 모양 (maxElevDeg 는 상대 베이스라인 안에 떨어지는 최고각) + distanceToBaselineM.
 */
export function groundWindow({
  contactHeight = 0.9,
  speedKmh,
  spinRpm = 0,
  spin = 'topspin',
  fromBaseline = 0,
  minDepthFromNet = 0,
  crossCourt = false,
  startY = 3,
  sideSign = 1,
  tiltDeg,
  constants,
} = {}) {
  const c = withConstants(constants);
  const x0 = 0 - fromBaseline;
  const y0 = startY;
  const reach = Math.min(Math.abs(startY), COURT.singlesHalfWidth - COURT.targetInset);
  const targetY = (crossCourt ? -1 : 1) * Math.sign(startY) * reach || 0;
  const aimLine = Math.atan2(targetY - y0, COURT.farBaselineX - x0);
  const shot = {
    x0, y0, z0: contactHeight, speedKmh, spinRpm, spin, sideSign, ...optional({ tiltDeg, constants }),
  };
  const aim = (_R, delta) => aimLine - delta; // 착지점이 컨택점 → 목표점 직선 위에 오도록
  const tooShort = (f) =>
    f.net === null || f.net.clearance < 0 || f.landing.x - COURT.netX < minDepthFromNet;
  const tooLong = (f) => f.landing.x > COURT.farBaselineX;
  const result = solveWindow(shot, aim, tooShort, tooLong, c);
  const straightNetY = y0 + ((COURT.netX - x0) / (COURT.farBaselineX - x0)) * (targetY - y0);
  const netY = result.best && Number.isFinite(result.best.netY) ? result.best.netY : straightNetY;
  return {
    ...result,
    netHeightOnPathCm: netHeightAt(netY) * 100,
    distanceToBaselineM: Math.hypot(COURT.farBaselineX - x0, targetY - y0),
    contact: { x0, y0, z0: contactHeight },
    targetY,
  };
}

/** 차트용: key 하나만 바꿔 가며 fn 을 호출한다 → [{ value, result }]. 예: sweep(serveWindow, base, 'contactHeight', [2.3, 2.4]) */
export function sweep(fn, baseArgs, key, values) {
  return Array.from(values, (value) => ({ value, result: fn({ ...baseArgs, [key]: value }) }));
}

/**
 * 중력·항력이 없다고 칠 때(공이 직선으로 날아갈 때) 네트를 넘겨 서비스라인에 넣을 수 있는 최소 컨택 높이 (m).
 * 닮은 삼각형: h = r + 네트높이 × (컨택→서비스라인 거리) / (네트→서비스라인 6.4 m).
 */
export function straightLineMinHeight({
  contactForward = 0,
  target = 'T',
  court = 'deuce',
  standY = 0.3,
  constants,
} = {}) {
  const c = withConstants(constants);
  const geo = serveGeometry({ court, standY, contactForward, target });
  const ratio = (COURT.farServiceLineX - geo.x0) / (COURT.farServiceLineX - COURT.netX);
  return c.ballRadius + netHeightAt(geo.netY) * ratio;
}

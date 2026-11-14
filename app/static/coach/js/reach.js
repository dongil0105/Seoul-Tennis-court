// 스윙 코치 — 높이를 몸으로 느낄 수 있는 말로 바꾼다. DOM 을 쓰지 않는다(브라우저·Node 공용).
//
// "타점 2.43m", "각도 폭 3.5도"는 느낌이 오지 않는다. 그래서
//  · 키 → 리치(팔과 라켓을 위로 쭉 뻗었을 때 라켓 가운데 높이) → 서브 종류별 타점 높이·위치(cm)
//  · 각도 폭 대신 "네트 위로 몇 cm(공 몇 개) 사이로 지나가야 들어가나"
//  · 스트로크 높이는 무릎·허리·가슴·어깨, 네트 위로는 "네트 높이의 몇 배"
// 로 말한다.
import * as Phys from './physics.js';

const RACKET_REACH_CM = 47.5;   // 손목에서 라켓 가운데(공이 맞는 곳)까지. physics.ballContactHeight 의 가운데값과 같다.
const BALL_CM = 6.7;            // 공 지름
const NET_CM = 91.4;            // 네트 가운데 높이
const r5 = (x) => Math.round(x / 5) * 5;

/**
 * 키(cm) → 리치.
 *  wrist: 팔을 위로 쭉 뻗었을 때 손목 높이(어깨 높이 0.818 + 팔 길이 0.332 = 키의 1.15배, 인체 비례)
 *  reach: 그 손에 든 라켓의 가운데 높이 = 발을 땅에 붙이고 칠 수 있는 가장 높은 타점
 */
export function reachOf(heightCm) {
  const wrist = 1.15 * heightCm;
  return { heightCm, wrist: Math.round(wrist), reach: Math.round(wrist + RACKET_REACH_CM) };
}

/** 영상에서 잰 손목 높이(키의 몇 배) → 공이 맞은 높이(cm)와 리치와의 차이 */
export function serveContact(wristRatio, heightCm) {
  const ball = Math.round(wristRatio * heightCm + RACKET_REACH_CM);
  const { reach } = reachOf(heightCm);
  return { ball, reach, diff: ball - reach, text: reachDiffText(ball - reach) };
}
/** '리치보다 13cm 낮음' / '리치 높이' / '리치보다 8cm 높음(뛰어서)' */
export function reachDiffText(diff) {
  const d = Math.round(diff);
  if (Math.abs(d) <= 3) return '리치 높이 그대로';
  return d < 0 ? `리치보다 ${-d}cm 낮음` : `리치보다 ${d}cm 높음`;
}

/**
 * 서브 종류별 타점(공) — 키에서 계산. 높이는 리치 기준, 위치는 앞발 기준(cm).
 * 근거: 선수는 플랫·킥을 거의 같은 높이에서 맞히고, 킥은 플랫보다 20cm쯤 반대쪽·15~20cm 몸 쪽(머리 위), 플랫이 가장 앞.
 * 동호인은 발을 거의 붙이고 치므로 리치 높이를 기준으로 잡고, 뛰어오르면 10cm쯤 더 높아진다.
 */
export function serveTargets(heightCm, hand = 'R') {
  const { reach } = reachOf(heightCm);
  const same = hand === 'L' ? '왼쪽' : '오른쪽', other = hand === 'L' ? '오른쪽' : '왼쪽';
  const fwd = (lo, hi) => [r5(lo * heightCm), r5(hi * heightCm)];
  return [
    { type: 'flat', label: '플랫', height: [reach, reach + 10], heightSay: '리치 높이, 뛰어오르면 10cm 더', front: fwd(0.18, 0.3),
      where: `치는 어깨 앞(시계 12~1시). 세 가지 중 가장 앞에서 맞습니다.` },
    { type: 'slice', label: '슬라이스', height: [reach - 5, reach + 5], heightSay: '플랫과 같은 높이', front: fwd(0.12, 0.24),
      where: `플랫보다 ${same}으로 15~20cm. 공의 ${same} 옆면을 깎습니다.` },
    { type: 'kick', label: '킥(스핀)', height: [reach - 15, reach], heightSay: '리치 높이이거나 10cm쯤 아래', front: fwd(0, 0.12),
      where: `머리 위(플랫보다 ${other}으로 20cm, 몸 쪽으로 15~20cm). 아래에서 위로 쓸어 올립니다.` },
  ];
}

const SPIN = { flat: { spin: 'flat', rpm: 0 }, slice: { spin: 'slice', rpm: 2200 }, kick: { spin: 'kick', rpm: 3200 } };

/**
 * 서브가 들어가려면 네트 위로 얼마나 높이 지나가야 하나(각도 대신 cm 와 공 개수로).
 * 돌려주는 것: { ok, lowCm, highCm, gapCm, balls, say } — ok 가 false 면 그 높이·속도로는 넣을 수 없다.
 */
export function serveGap({ contactCm, speedKmh, type = 'flat', target = 'T', hand = 'R' }) {
  const sp = SPIN[type] || SPIN.flat;
  let r = null;
  try { r = Phys.serveWindow({ contactHeight: contactCm / 100, speedKmh, spin: sp.spin, spinRpm: sp.rpm, court: 'deuce', target, rightHanded: hand !== 'L' }); } catch (_) { r = null; }
  if (!r || !r.feasible || !r.minLaunch || !r.maxLaunch) return { ok: false, lowCm: NaN, highCm: NaN, gapCm: 0, balls: 0, say: '넣을 수 없음' };
  const clr = (launch) => { try { const s = Phys.simulate(launch); return s.net ? s.net.clearance * 100 : NaN; } catch (_) { return NaN; } };
  const low = Math.max(0, clr(r.minLaunch)), high = clr(r.maxLaunch);
  if (!Number.isFinite(high)) return { ok: false, lowCm: NaN, highCm: NaN, gapCm: 0, balls: 0, say: '넣을 수 없음' };
  const gap = Math.max(0, high - low), balls = gap / BALL_CM;
  return { ok: true, lowCm: Math.round(low), highCm: Math.round(high), gapCm: Math.round(gap), balls: Math.round(balls * 10) / 10, say: gapSay(balls) };
}
export const gapSay = (balls) => (balls < 2 ? '아주 빠듯' : balls < 4 ? '빠듯' : balls < 7 ? '보통' : '넉넉');

// ── 포핸드·백핸드 ────────────────────────────────────────────────
/** 바닥에서 잰 높이(키의 몇 배) → 몸의 어느 높이인지 */
export function bodyLevel(ratio) {
  if (!Number.isFinite(ratio)) return '';
  if (ratio < 0.33) return '무릎 높이';
  if (ratio < 0.47) return '무릎과 허리 사이';
  if (ratio < 0.62) return '허리 높이';
  if (ratio < 0.76) return '가슴 높이';
  if (ratio < 0.88) return '어깨 높이';
  return '머리 높이';
}
/** 키 → 몸의 기준 높이(cm) */
export function bodyHeights(heightCm) {
  const at = (k) => Math.round(k * heightCm);
  return { knee: at(0.285), waist: at(0.55), chest: at(0.72), shoulder: at(0.82) };
}
/** 스트로크의 좋은 타점: 높이(허리~가슴)와 앞뒤(골반보다 몇 cm 앞) */
export function groundTargets(heightCm) {
  const b = bodyHeights(heightCm);
  const f = (lo, hi) => [r5(lo * heightCm), r5(hi * heightCm)];
  return {
    height: [r5(0.5 * heightCm), r5(0.72 * heightCm)], heightSay: '허리에서 가슴 사이', body: b,
    front: { forehand: f(0.12, 0.27), backhand2: f(0.08, 0.24), backhand1: f(0.18, 0.35) },
  };
}

/** 주어진 각도로 쳤을 때 떨어지는 곳(내 베이스라인에서의 거리 m)과 네트 위 여유(m). 네트를 못 넘으면 null */
function shot(elevDeg, { contactM, speedKmh, rpm }) {
  let s;
  try { s = Phys.simulate({ x0: 0, y0: 0, z0: contactM, speedKmh, elevDeg, azimDeg: 0, spinRpm: rpm, spin: rpm ? 'topspin' : 'flat' }); } catch (_) { return null; }
  if (!s || !s.net || !(s.net.clearance > 0)) return null;
  return { x: s.landing.x, clearance: s.net.clearance };
}
/** 떨어지는 곳이 targetX 가 되는 각도를 찾아 그때의 네트 위 여유(m)를 돌려준다. 못 찾으면 NaN */
function clearanceFor(targetX, o) {
  let lo = -5, hi = 40;                                       // 이 범위에서 각도가 클수록 멀리 떨어진다
  const far = shot(hi, o);
  if (!far || far.x < targetX) return NaN;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2, s = shot(mid, o);
    if (!s || s.x < targetX) lo = mid; else hi = mid;
  }
  const s = shot(hi, o);
  return s ? s.clearance : NaN;
}

/**
 * 스트로크를 깊게 보내려면 네트 위로 얼마나 높이 넘겨야 하나.
 * 돌려주는 것: { deepM(베이스라인 1m 안쪽에 떨어질 때), midM(서비스라인과 베이스라인 가운데), shortM(서비스라인), deepNets(네트 높이의 몇 배) }
 */
export function groundClearance({ speedKmh = 75, rpm = 1000, contactCm = 90 } = {}) {
  const o = { contactM: contactCm / 100, speedKmh, rpm };
  const base = Phys.COURT.length ?? 23.77, service = (Phys.COURT.netX ?? 11.885) + 6.4;
  const deep = clearanceFor(base - 1, o), mid = clearanceFor((service + base) / 2, o), short = clearanceFor(service, o);
  const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : NaN);
  return { deepM: r1(deep), midM: r1(mid), shortM: r1(short), deepNets: Number.isFinite(deep) ? Math.round((deep * 100 / NET_CM) * 2) / 2 : NaN };
}
/** '네트 높이의 2배쯤' */
export function netsText(nets) {
  if (!Number.isFinite(nets)) return '';
  if (nets < 0.75) return '네트 높이의 절반쯤';
  if (nets < 1.25) return '네트 하나 높이쯤';
  return `네트 높이의 ${Number.isInteger(nets) ? nets : nets.toFixed(1)}배쯤`;
}

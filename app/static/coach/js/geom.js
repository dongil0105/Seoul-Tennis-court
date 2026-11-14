// 스윙 코치 — 자세 좌표 계산의 바닥. DOM 을 쓰지 않는다(브라우저·Node 공용).
//
// 한 프레임(pose) = { t: 초, lm: [[x,y,z,v] × 33], w: [[x,y,z,v] × 33] }
//   lm = 화면 좌표(0~1, y 는 아래로), w = 몸 중심(골반) 기준 3차원 좌표(미터쯤, x 오른쪽 · y 아래 · z 카메라에서 멀어지는 쪽)
// 길이는 모두 '키에 대한 비율'로 다룬다. 그래야 카메라 거리·사람 키와 상관없이 비교할 수 있다.

export const J = {
  nose: 0, lEar: 7, rEar: 8, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16,
  lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20, lThumb: 21, rThumb: 22,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnk: 27, rAnk: 28, lHeel: 29, rHeel: 30, lToe: 31, rToe: 32,
};

// 뼈대 그릴 때 잇는 선
export const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32], [27, 29], [28, 30],
];

/** 치는 손('R'|'L') 기준으로 '치는 쪽 / 반대쪽' 관절 번호 */
export function sides(hand) {
  const R = { sh: J.rSh, el: J.rEl, wr: J.rWr, hip: J.rHip, knee: J.rKnee, ank: J.rAnk, heel: J.rHeel, toe: J.rToe, index: J.rIndex, pinky: J.rPinky };
  const Lf = { sh: J.lSh, el: J.lEl, wr: J.lWr, hip: J.lHip, knee: J.lKnee, ank: J.lAnk, heel: J.lHeel, toe: J.lToe, index: J.lIndex, pinky: J.lPinky };
  return hand === 'L' ? { hit: Lf, off: R } : { hit: R, off: Lf };
}

// ── 벡터 ────────────────────────────────────────────────────────
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], (a[2] || 0) - (b[2] || 0)];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], (a[2] || 0) + (b[2] || 0)];
export const mul = (a, k) => [a[0] * k, a[1] * k, (a[2] || 0) * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + (a[2] || 0) * (b[2] || 0);
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2] || 0);
export const unit = (a) => { const n = len(a) || 1; return [a[0] / n, a[1] / n, (a[2] || 0) / n]; };
export const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, ((a[2] || 0) + (b[2] || 0)) / 2];
export const dist = (a, b) => len(sub(a, b));
export const deg = (r) => (r * 180) / Math.PI;
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** 세 점 a-b-c 에서 b 의 각도(도). 팔꿈치·무릎처럼 '펴면 180'. */
export function angleAt(a, b, c) {
  const u = sub(a, b), v = sub(c, b);
  const d = len(u) * len(v);
  return d ? deg(Math.acos(clamp(dot(u, v) / d, -1, 1))) : NaN;
}
/** 두 벡터 사이 각(도) */
export function angleBetween(u, v) {
  const d = len(u) * len(v);
  return d ? deg(Math.acos(clamp(dot(u, v) / d, -1, 1))) : NaN;
}

// ── 통계 ────────────────────────────────────────────────────────
export function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function percentile(xs, p) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((q, r) => q - r);
  if (!a.length) return NaN;
  const i = clamp((a.length - 1) * p, 0, a.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}
/** 튀는 값에 덜 흔들리는 평균·표준편차(중앙값, MAD×1.4826) */
export function robust(xs) {
  const a = xs.filter((x) => Number.isFinite(x));
  if (!a.length) return { n: 0, mean: NaN, sd: NaN };
  const m = median(a);
  const sd = 1.4826 * median(a.map((x) => Math.abs(x - m)));
  return { n: a.length, mean: m, sd, p10: percentile(a, 0.1), p90: percentile(a, 0.9) };
}

// ── 한 자세에서 읽는 것 ──────────────────────────────────────────
const UP = [0, -1, 0];          // 3차원 좌표에서 '위'

/** 관절이 보이는 정도(0~1) — 여러 개면 가장 낮은 값 */
export function vis(pose, ...idx) {
  let v = 1;
  for (const i of idx) v = Math.min(v, pose.lm[i] ? pose.lm[i][3] : 0);
  return v;
}

/** 3차원 좌표로 잰 키(모델 미터). 정강이+허벅지+몸통 = 키의 77.9%(인체 비례)로 거꾸로 셈한다. */
export function statureW(pose) {
  const w = pose.w;
  const leg = (h, k, a) => dist(w[h], w[k]) + dist(w[k], w[a]);
  const legs = (leg(J.lHip, J.lKnee, J.lAnk) + leg(J.rHip, J.rKnee, J.rAnk)) / 2;
  const trunk = dist(mid(w[J.lHip], w[J.rHip]), mid(w[J.lSh], w[J.rSh]));
  return (legs + trunk) / 0.779;
}

/** 화면 픽셀 ÷ 3차원 미터 — 화면에서 잰 길이를 몸 크기로 바꾸는 환율. 관절이 기울어 짧아 보여도 흔들리지 않는다. */
export function pxPerMeter(pose, W, H) {
  const segs = [[J.lSh, J.lEl], [J.lEl, J.lWr], [J.rSh, J.rEl], [J.rEl, J.rWr], [J.lHip, J.lKnee], [J.lKnee, J.lAnk],
    [J.rHip, J.rKnee], [J.rKnee, J.rAnk], [J.lSh, J.lHip], [J.rSh, J.rHip], [J.lSh, J.rSh], [J.lHip, J.rHip]];
  const rs = [];
  for (const [a, b] of segs) {
    if (vis(pose, a, b) < 0.5) continue;
    const wx = pose.w[a][0] - pose.w[b][0], wy = pose.w[a][1] - pose.w[b][1];
    const wl = Math.hypot(wx, wy);
    if (wl < 0.12) continue;                         // 카메라 쪽으로 누운 마디는 믿지 않는다
    const pl = Math.hypot((pose.lm[a][0] - pose.lm[b][0]) * W, (pose.lm[a][1] - pose.lm[b][1]) * H);
    rs.push(pl / wl);
  }
  return median(rs);
}

/** 몸 기준 축: R = 그 사람의 오른쪽, U = 위, F = 가슴이 보는 쪽. 어깨선(또는 골반선)으로 잡는다. */
export function bodyFrame(pose, use = 'shoulders') {
  const w = pose.w;
  let r = use === 'hips' ? sub(w[J.rHip], w[J.lHip]) : sub(w[J.rSh], w[J.lSh]);
  r = unit([r[0], 0, r[2]]);                         // 수평으로 눕힌다
  const f = unit(cross(UP, r));
  return { R: r, U: UP, F: f };
}

/** 3차원 점을 몸 기준 좌표(오른쪽, 위, 앞)로. origin 은 3차원 점. */
export function inBody(frame, p, origin) {
  const d = sub(p, origin);
  return [dot(d, frame.R), dot(d, frame.U), dot(d, frame.F)];
}

/** 왼손잡이를 오른손잡이처럼 뒤집은 자세(좌우 관절을 바꾸고 x 를 뒤집는다) — 기준 자세와 견줄 때 쓴다 */
export function mirrorPose(pose) {
  const swap = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
  const flip = (arr, isLm) => {
    const out = arr.map((k) => [isLm ? 1 - k[0] : -k[0], k[1], k[2], k[3]]);
    for (const [a, b] of swap) { const t = out[a]; out[a] = out[b]; out[b] = t; }
    return out;
  };
  return { ...pose, lm: flip(pose.lm, true), w: flip(pose.w, false) };
}

/** 두 프레임 사이 시각 t 의 자세(선형 보간) */
export function lerpPose(a, b, t) {
  if (!b || a === b) return a;
  const k = clamp((t - a.t) / ((b.t - a.t) || 1), 0, 1);
  const mix = (p, q) => p.map((v, i) => [v[0] + (q[i][0] - v[0]) * k, v[1] + (q[i][1] - v[1]) * k, v[2] + (q[i][2] - v[2]) * k, Math.min(v[3], q[i][3])]);
  return { t, lm: mix(a.lm, b.lm), w: mix(a.w, b.w) };
}

/** 시각 t 의 자세 — 프레임 사이면 보간 */
export function poseAt(frames, t) {
  if (!frames.length) return null;
  if (t <= frames[0].t) return frames[0];
  for (let i = 1; i < frames.length; i++) if (frames[i].t >= t) return lerpPose(frames[i - 1], frames[i], t);
  return frames[frames.length - 1];
}

/** 기준 자세와 견줄 때 쓰는 특징: 주요 관절 12곳의 몸 기준 좌표 ÷ 키. 카메라 방향과 상관없다. */
export const FEATURE_JOINTS = [J.lSh, J.rSh, J.lEl, J.rEl, J.lWr, J.rWr, J.lHip, J.rHip, J.lKnee, J.rKnee, J.lAnk, J.rAnk];
export function poseFeature(pose) {
  const fr = bodyFrame(pose, 'hips');
  const o = mid(pose.w[J.lHip], pose.w[J.rHip]);
  const h = statureW(pose) || 1;
  const out = [];
  for (const j of FEATURE_JOINTS) { const b = inBody(fr, pose.w[j], o); out.push(b[0] / h, b[1] / h, b[2] / h); }
  return out;
}
const FEATURE_WEIGHT = [1, 1, 1.5, 1.5, 2, 2, 0.5, 0.5, 1, 1, 1, 1];   // 팔·손목을 더 무겁게
export function featureDistance(a, b) {
  let s = 0, wsum = 0;
  for (let j = 0; j < FEATURE_JOINTS.length; j++) {
    const k = j * 3, wt = FEATURE_WEIGHT[j];
    s += wt * Math.hypot(a[k] - b[k], a[k + 1] - b[k + 1], a[k + 2] - b[k + 2]);
    wsum += wt;
  }
  return s / wsum;
}

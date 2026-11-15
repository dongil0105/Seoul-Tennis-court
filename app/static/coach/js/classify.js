// 스윙 코치 — 학습한 분류기로 스윙의 종류를 가린다(포핸드·백핸드·포핸드 발리·백핸드 발리·머리 위[서브·스매시]).
// DOM 을 쓰지 않는다(브라우저·Node 공용). 학습은 tools/coach/train_strokes.py, 모델은 data/stroke_model.json.
//
// 특징 = '온몸의 움직임': 스윙의 가장 빠른 순간(tp) 앞 0.8초 ~ 뒤 0.6초를 0.1초 간격 15곳에서 본다. 곳마다 44값:
//   · 관절 13개(코, 치는 쪽 어깨·팔꿈치·손목·골반·무릎·발목, 반대쪽 같은 것)의 위치 — 그 스윙의 '기본 방향'(구간 평균 골반선)에 맞춘 좌표
//     (치는 쪽 +, 위 +, 앞 +). 원점은 그 순간의 골반 가운데, 키로 나눈다.
//   · 어깨선·골반선이 기본 방향에서 돈 정도(각각 두 값), 치는 손목의 속도
// 기본 방향에 맞추므로 카메라가 어느 쪽에 있든 같은 값이 나오고(3차원 좌표가 맞다면), 왼손잡이는 좌우를 뒤집어 오른손잡이처럼 본다.
import * as G from './geom.js';

const { J } = G;
export const STEPS = [-0.8, -0.7, -0.6, -0.5, -0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
export const PER_STEP = 44;
export const N_FEAT = STEPS.length * PER_STEP;
const UP = [0, -1, 0];          // 3차원 좌표에서 '위'(미디어파이프는 y 가 아래) — geom.js 와 같은 값
const SIDE = { R: [J.rSh, J.rEl, J.rWr, J.rHip, J.rKnee, J.rAnk], L: [J.lSh, J.lEl, J.lWr, J.lHip, J.lKnee, J.lAnk] };

/**
 * 스윙 하나의 특징 벡터(길이 N_FEAT).
 * frames = 다듬은 자세 줄, tp = 치는 손목이 가장 빨랐던 시각(초), hand 'R'|'L', h = 키(모델 미터), sf = 슬로모션 배수,
 * speed = wristSpeed(frames, hand) 결과(프레임마다의 손목 속도. 안 주면 속도 칸은 0)
 */
export function swingSequence(frames, tp, hand, h, sf = 1, speed = null) {
  const sign = hand === 'L' ? -1 : 1, hit = SIDE[hand === 'L' ? 'L' : 'R'], off = SIDE[hand === 'L' ? 'R' : 'L'];
  const poses = STEPS.map((dt) => G.poseAt(frames, tp + dt * sf));
  // 기본 방향: 구간 평균 골반선(왼 → 오른)을 수평으로 눕힌 것. 몸 기준 '오른쪽' R 과 '앞' F 를 geom.bodyFrame 과 같은 규칙으로 잡는다.
  let rx = 0, rz = 0;
  for (const p of poses) { rx += p.w[J.rHip][0] - p.w[J.lHip][0]; rz += p.w[J.rHip][2] - p.w[J.lHip][2]; }
  const n = Math.hypot(rx, rz) || 1;
  const R = [rx / n, 0, rz / n], F = G.unit(G.cross(UP, R));
  const out = [];
  poses.forEach((p, k) => {
    const o = G.mid(p.w[J.lHip], p.w[J.rHip]);
    for (const j of [J.nose, ...hit, ...off]) {
      const d = [p.w[j][0] - o[0], p.w[j][1] - o[1], p.w[j][2] - o[2]];
      out.push((G.dot(d, R) * sign) / h, -d[1] / h, G.dot(d, F) / h);          // 치는 쪽, 위(미디어파이프는 y 가 아래), 앞
    }
    for (const [a, b] of [[J.lSh, J.rSh], [J.lHip, J.rHip]]) {
      const d = [p.w[b][0] - p.w[a][0], 0, p.w[b][2] - p.w[a][2]], len = Math.hypot(d[0], d[2]) || 1;
      out.push((G.dot(d, F) * sign) / len, G.dot(d, R) / len);                  // 선이 기본 방향에서 돈 정도
    }
    let v = 0;
    if (speed) {                                                                // 그 시각에 가장 가까운 프레임의 손목 속도
      const t = tp + STEPS[k] * sf; let bi = 0;
      for (let i = 1; i < frames.length; i++) if (Math.abs(frames[i].t - t) < Math.abs(frames[bi].t - t)) bi = i;
      v = (speed[bi] * sf) / h;
    }
    out.push(v);
  });
  return out.map((x) => (Number.isFinite(x) ? x : 0));
}

/**
 * 모델(은닉층 하나짜리 신경망: { classes, mean, scale, W1[은닉][특징], b1, W2[종류][은닉], b2 })로 종류별 확률을 낸다.
 * 돌려주는 것: { cls, p, prob: {종류: 확률} }
 */
export function predictStroke(model, feat) {
  const nIn = model.mean.length, hid = model.b1.length;
  const x = new Array(nIn);
  for (let i = 0; i < nIn; i++) x[i] = (feat[i] - model.mean[i]) / model.scale[i];
  const a = new Array(hid);
  for (let j = 0; j < hid; j++) { const w = model.W1[j]; let s = model.b1[j]; for (let i = 0; i < nIn; i++) s += w[i] * x[i]; a[j] = s > 0 ? s : 0; }
  const z = model.W2.map((w, k) => { let s = model.b2[k]; for (let j = 0; j < hid; j++) s += w[j] * a[j]; return s; });
  const m = Math.max(...z), e = z.map((v) => Math.exp(v - m)), sum = e.reduce((p, c) => p + c, 0);
  const prob = e.map((v) => v / sum);
  let best = 0; for (let k = 1; k < prob.length; k++) if (prob[k] > prob[best]) best = k;
  return { cls: model.classes[best], p: prob[best], prob: Object.fromEntries(model.classes.map((c, k) => [c, prob[k]])) };
}

/** 모델 파일이 이 코드와 맞는 모양인지(특징 수·종류) */
export function validModel(m) {
  return !!m && m.kind === 'stroke-mlp' && Array.isArray(m.classes) && Array.isArray(m.mean) && m.mean.length === N_FEAT && Array.isArray(m.scale) && m.scale.length === N_FEAT
    && Array.isArray(m.W1) && Array.isArray(m.b1) && m.W1.length === m.b1.length && m.W1.every((w) => w.length === N_FEAT)
    && Array.isArray(m.W2) && m.W2.length === m.classes.length && m.W2.every((w) => w.length === m.b1.length) && Array.isArray(m.b2) && m.b2.length === m.classes.length
    && ['forehand', 'backhand', 'fvolley', 'bvolley', 'overhead'].every((c) => m.classes.includes(c));
}

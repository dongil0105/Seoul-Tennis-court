// 스윙 코치 — 학습한 분류기로 스윙의 종류를 가린다(포핸드·백핸드·서브·스매시·포핸드 발리·백핸드 발리).
// DOM 을 쓰지 않는다(브라우저·Node 공용). 학습은 tools/coach/train_strokes.py, 모델은 data/stroke_model.json.
//
// 특징: 스윙의 가장 빠른 순간(tp) 앞뒤 1.2초를 0.1초 간격 13곳에서 본다. 곳마다
//   · 치는 손목의 위치(몸 기준: 치는 쪽, 위, 앞 — 어깨 가운데에서, 키로 나눔)
//   · 반대 손목의 위치(같은 기준)
//   · 두 손목 사이 거리, 치는 손목의 높이(코 기준)
// 몸 기준 좌표라 카메라 방향에 덜 매이고, 왼손잡이는 좌우를 뒤집어 오른손잡이처럼 본다.
import * as G from './geom.js';

const { J } = G;
export const STEPS = [-0.7, -0.6, -0.5, -0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4, 0.5];
export const N_FEAT = STEPS.length * 8 + 3;

/** 스윙 하나의 특징 벡터. frames = 다듬은 자세 줄, tp = 손목이 가장 빨랐던 시각(초), hand 'R'|'L', h = 키(모델 미터), sf = 슬로모션 배수 */
export function swingFeatures(frames, tp, hand, h, sf = 1) {
  const S = G.sides(hand), sign = hand === 'L' ? -1 : 1;
  const out = [];
  let reach = 0, top = -9;
  for (const dt of STEPS) {
    const p = G.poseAt(frames, tp + dt * sf);
    const B = G.bodyFrame(p), mid = G.mid(p.w[J.lSh], p.w[J.rSh]);
    const loc = (j) => { const v = G.inBody(B, p.w[j], mid); return [(v[0] * sign) / h, v[1] / h, v[2] / h]; };
    const a = loc(S.hit.wr), b = loc(S.off.wr);
    const up = (p.w[J.nose][1] - p.w[S.hit.wr][1]) / h;                 // 코보다 위면 +
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], G.dist(p.w[J.lWr], p.w[J.rWr]) / h, up);
    reach = Math.max(reach, Math.hypot(a[0], a[1], a[2]));
    top = Math.max(top, up);
  }
  // 덧붙임: 팔을 가장 멀리 뻗은 정도, 손목이 가장 높았던 정도, 좌우로 간 거리(끝 − 처음)
  out.push(reach, top, out[8 * (STEPS.length - 3)] - out[8 * 3]);
  return out.map((x) => (Number.isFinite(x) ? x : 0));
}

/** 모델(다항 로지스틱 회귀: { classes, mean, scale, W, b })로 종류별 확률을 낸다 */
export function predictStroke(model, feat) {
  const z = model.W.map((w, k) => { let s = model.b[k]; for (let i = 0; i < feat.length; i++) s += w[i] * ((feat[i] - model.mean[i]) / model.scale[i]); return s; });
  const m = Math.max(...z), e = z.map((x) => Math.exp(x - m)), sum = e.reduce((a, c) => a + c, 0);
  const prob = e.map((x) => x / sum);
  let best = 0; for (let k = 1; k < prob.length; k++) if (prob[k] > prob[best]) best = k;
  return { cls: model.classes[best], p: prob[best], prob: Object.fromEntries(model.classes.map((c, k) => [c, prob[k]])) };
}

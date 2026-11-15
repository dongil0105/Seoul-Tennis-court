// 스윙 코치 — '치는 순간'까지 배운 모델로 스윙을 찾는다. DOM 을 쓰지 않는다(브라우저·Node 공용).
// 손목 속도의 꼭대기(후보)마다 종류 5가지 + '스윙 아님'의 확률을 내고, 스윙일 확률이 높은 것만 남긴다.
// 모델은 data/moment_model.json (학습: tools/coach/train_moment.py). 지금은 '화면 보고 학습'(watch.js)과 재는 도구가 쓴다 —
// 영상을 올려 분석하는 본 화면(app.js)은 아직 예전 방식(swing.js 의 detectSwings)을 쓴다.
import { wristSpeed, bodyScale } from './swing.js';
import { swingSequence, predictStroke, N_FEAT } from './classify.js';

export const FLOOR = 1.0, GAP = 0.35;

/** 손목 속도의 꼭대기(초당 1m 이상, 서로 0.35초 이상 떨어진 것) — 학습 자료를 만들 때와 같은 규칙. 돌려주는 것: 프레임 번호들 */
export function candidates(frames, v, floor = FLOOR, gap = GAP) {
  const c = [];
  for (let i = 2; i < v.length - 2; i++) {
    if (v[i] < floor || v[i] < v[i - 1] || v[i] <= v[i + 1]) continue;
    const last = c[c.length - 1];
    if (last != null && frames[i].t - frames[last].t < gap) { if (v[i] > v[last]) c[c.length - 1] = i; continue; }
    c.push(i);
  }
  return c;
}

/** 모델 파일이 이 코드와 맞는 모양인지 */
export function validMomentModel(m) {
  return !!m && m.kind === 'moment-mlp' && Array.isArray(m.classes) && m.classes.includes('none') && Array.isArray(m.mean) && m.mean.length === N_FEAT
    && Array.isArray(m.scale) && m.scale.length === N_FEAT && Array.isArray(m.W1) && Array.isArray(m.b1) && m.W1.length === m.b1.length
    && Array.isArray(m.W2) && m.W2.length === m.classes.length && Array.isArray(m.b2) && m.b2.length === m.classes.length
    && ['forehand', 'backhand', 'fvolley', 'bvolley', 'overhead'].every((c) => m.classes.includes(c));
}

/** 후보마다 확률. 돌려주는 것: [{ i, t, v, s(스윙일 확률), stroke, sub, conf, P }]. opt.keepX 면 특징 벡터(x)도 함께 */
export function scoreCandidates(frames, hand, model, opt = {}) {
  const h = bodyScale(frames);
  if (!Number.isFinite(h) || frames.length < 5) return [];
  const v = wristSpeed(frames, hand);
  return candidates(frames, v, opt.floor, opt.gap).map((i) => {
    const x = swingSequence(frames, frames[i].t, hand, h, opt.sf || 1, v);
    const P = predictStroke(model, x).prob;
    const pf = P.forehand + P.fvolley, pb = P.backhand + P.bvolley, po = P.overhead;
    const s = 1 - P.none, top = Math.max(pf, pb, po);
    const stroke = po === top ? 'serve' : pf === top ? 'forehand' : 'backhand';
    const sub = stroke === 'forehand' ? (P.fvolley > P.forehand ? 'volley' : null) : stroke === 'backhand' ? (P.bvolley > P.backhand ? 'volley' : null) : null;
    return { i, t: frames[i].t, v: v[i], s, stroke, sub, conf: s > 0 ? top / s : 0, P, x: opt.keepX ? x : undefined };
  });
}

/** 스윙일 확률이 thr 이상인 후보만, 서로 minGap 초 안에 있으면 확률이 높은 것 하나만 */
export function detectLearned(frames, hand, model, { thr = 0.5, minGap = 0.7, floor, gap } = {}) {
  return pickSwings(scoreCandidates(frames, hand, model, { floor, gap }), { thr, minGap });
}

/** 확률을 매긴 후보들에서 스윙만 고른다(위와 같은 규칙) */
export function pickSwings(scored, { thr = 0.5, minGap = 0.7 } = {}) {
  const c = scored.filter((x) => x.s >= thr).sort((a, b) => b.s - a.s);
  const keep = [];
  for (const x of c) if (!keep.some((k) => Math.abs(k.t - x.t) < minGap)) keep.push(x);
  return keep.sort((a, b) => a.t - b.t);
}

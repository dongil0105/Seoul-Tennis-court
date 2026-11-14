// '치는 순간'까지 배운 모델로 스윙을 찾는다: 손목 속도의 꼭대기(후보)마다 종류 5 + '스윙 아님'의 확률을 내고, 스윙일 확률이 높은 것만 남긴다.
// 아직 앱에는 넣지 않았다(학습·재기용). 앱에 넣을 때는 이 파일의 함수가 swing.js 의 스윙 찾기를 대신한다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'static', 'coach', 'js');
const { wristSpeed, bodyScale } = await import(path.join(JS, 'swing.js'));
const { swingSequence, predictStroke } = await import(path.join(JS, 'classify.js'));

export const FLOOR = 1.0, GAP = 0.35;

/** 손목 속도의 꼭대기(초당 1m 이상, 서로 0.35초 이상 떨어진 것) — 학습 자료를 만들 때와 같은 규칙 */
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

/** 후보마다 확률 */
export function scoreCandidates(frames, hand, model, opt = {}) {
  const h = bodyScale(frames);
  if (!Number.isFinite(h)) return [];
  const v = wristSpeed(frames, hand);
  return candidates(frames, v, opt.floor, opt.gap).map((i) => {
    const P = predictStroke(model, swingSequence(frames, frames[i].t, hand, h, 1, v)).prob;
    const pf = P.forehand + P.fvolley, pb = P.backhand + P.bvolley, po = P.overhead;
    const s = 1 - P.none, top = Math.max(pf, pb, po);
    const stroke = po === top ? 'serve' : pf === top ? 'forehand' : 'backhand';
    const sub = stroke === 'forehand' ? (P.fvolley > P.forehand ? 'volley' : null) : stroke === 'backhand' ? (P.bvolley > P.backhand ? 'volley' : null) : null;
    return { i, t: frames[i].t, v: v[i], s, stroke, sub, conf: s > 0 ? top / s : 0, P };
  });
}

/** 스윙일 확률이 thr 이상인 후보만, 서로 minGap 초 안에 있으면 확률이 높은 것 하나만 */
export function detectLearned(frames, hand, model, { thr = 0.5, minGap = 0.7, floor, gap } = {}) {
  const c = scoreCandidates(frames, hand, model, { floor, gap }).filter((x) => x.s >= thr).sort((a, b) => b.s - a.s);
  const keep = [];
  for (const x of c) if (!keep.some((k) => Math.abs(k.t - x.t) < minGap)) keep.push(x);
  return keep.sort((a, b) => a.t - b.t);
}

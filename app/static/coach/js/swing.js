// 스윙 코치 — 자세 프레임 줄에서 스윙을 찾고(서브·포핸드·백핸드), 준비·임팩트 같은 핵심 순간을 고른다.
// DOM 을 쓰지 않는다(브라우저·Node 공용).
import * as G from './geom.js';

const { J } = G;

/** 3점 이동 평균을 n 번 */
function smooth(xs, n = 2) {
  let a = xs.slice();
  for (let k = 0; k < n; k++) {
    const b = a.slice();
    for (let i = 1; i < a.length - 1; i++) b[i] = (a[i - 1] + a[i] + a[i + 1]) / 3;
    a = b;
  }
  return a;
}
/** 꼭대기 근처 세 점으로 포물선을 맞춰 프레임 사이의 진짜 꼭대기 위치를 잡는다(-0.5~0.5 프레임) */
function parabolic(ym, y0, yp) {
  const d = ym - 2 * y0 + yp;
  return d ? G.clamp((0.5 * (ym - yp)) / d, -0.5, 0.5) : 0;
}
const idxAt = (frames, t) => {
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (frames[m].t < t) lo = m + 1; else hi = m; }
  return lo;
};

/** 손목 속도(초당 미터, 골반 기준 3차원) — 몸이 걸어가는 것은 빠지고 팔 휘두르는 것만 남는다 */
export function wristSpeed(frames, hand) {
  const wr = G.sides(hand).hit.wr;
  const v = new Array(frames.length).fill(0);
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i].t - frames[i - 1].t;
    if (dt > 0 && dt < 0.5) v[i] = G.dist(frames[i].w[wr], frames[i - 1].w[wr]) / dt;
  }
  return smooth(v, 2);
}

/**
 * 스윙 찾기. frames = [{t, lm, w}] (사람이 안 잡힌 프레임은 빼고 넘긴다).
 * opts.hand 'R'|'L', opts.stroke 를 주면 종류를 그걸로 고정한다(스윙 영상에서 사용자가 고른 경우).
 * 돌려주는 것: [{ i0, i1, ip, tc, sf, peak, stroke, twoHanded, dir, view, keys:{...초}, conf }]
 */
export function detectSwings(frames, opts = {}) {
  const hand = opts.hand === 'L' ? 'L' : 'R';
  if (frames.length < 8) return [];
  const v = wristSpeed(frames, hand);
  const vmax = Math.max(...v);
  const p99 = G.percentile(v, 0.99);
  // 슬로모션(시간이 늘어난 영상)이면 속도가 낮게 나온다 → 시간 창을 그만큼 늘린다
  const sf = p99 < 3.5 ? G.clamp(9 / Math.max(vmax, 0.5), 1, 12) : 1;
  const thr = p99 < 3.5 ? 0.5 * vmax : Math.max(3.5, 0.45 * p99);
  const minGap = 0.8 * sf;

  const peaks = [];
  for (let i = 2; i < v.length - 2; i++) {
    if (v[i] < thr || v[i] < v[i - 1] || v[i] < v[i + 1]) continue;
    const last = peaks[peaks.length - 1];
    if (last && frames[i].t - frames[last].t < minGap) { if (v[i] > v[last]) peaks[peaks.length - 1] = i; continue; }
    peaks.push(i);
  }

  const out = [];
  for (const ip of peaks) {
    const tp = frames[ip].t;
    const i0 = idxAt(frames, tp - 2.0 * sf), i1 = Math.min(frames.length - 1, idxAt(frames, tp + 0.9 * sf));
    if (ip - i0 < 3 || i1 - ip < 1) continue;                 // 앞뒤가 잘린 스윙은 분석하지 않는다
    const sw = analyzeSwing(frames, v, { i0, i1, ip, sf, hand, stroke: opts.stroke });
    if (sw) out.push(sw);
  }
  return out;
}

function analyzeSwing(frames, v, { i0, i1, ip, sf, hand, stroke }) {
  const S = G.sides(hand);
  const sign = hand === 'L' ? -1 : 1;
  const tp = frames[ip].t;
  const near = (a, b) => { const r = []; for (let i = i0; i <= i1; i++) if (frames[i].t >= tp + a * sf && frames[i].t <= tp + b * sf) r.push(i); return r; };

  // ① 종류: 손목이 머리 위로 올라가면 서브(스매시 포함), 아니면 백스윙 때 손목이 몸의 어느 쪽에 있었나로 포핸드/백핸드
  const up = (i) => frames[i].w[J.nose][1] - frames[i].w[S.hit.wr][1];       // 손목이 코보다 얼마나 위(미터)
  const upMax = Math.max(...near(-0.12, 0.12).map(up));
  const back = near(-0.5, -0.1);
  let side = 0;
  for (const i of back) {
    const fr = G.bodyFrame(frames[i]);
    side += G.dot(G.sub(frames[i].w[S.hit.wr], G.mid(frames[i].w[J.lSh], frames[i].w[J.rSh])), fr.R) * sign;
  }
  side = back.length ? side / back.length : 0;
  const hands = Math.min(...near(-0.3, 0.02).map((i) => G.dist(frames[i].w[J.lWr], frames[i].w[J.rWr])));
  const auto = upMax > 0.18 ? 'serve' : side >= 0 ? 'forehand' : 'backhand';
  const kind = stroke || auto;
  const twoHanded = kind !== 'serve' && hands < 0.2;

  // ② 임팩트 시각: 서브는 손목이 가장 높은 순간, 스트로크는 손목이 가장 빠른 순간 바로 뒤
  let tc, ic = ip;
  const dtAt = (i) => (frames[Math.min(i + 1, frames.length - 1)].t - frames[Math.max(i - 1, 0)].t) / 2 || 1 / 30;
  if (kind === 'serve') {
    const cand = near(-0.18, 0.18);
    ic = cand.reduce((b, i) => (up(i) > up(b) ? i : b), cand[0] ?? ip);
    const off = ic > 0 && ic < frames.length - 1 ? parabolic(up(ic - 1), up(ic), up(ic + 1)) : 0;
    tc = frames[ic].t + off * dtAt(ic);
  } else {
    const off = parabolic(v[ip - 1], v[ip], v[ip + 1]);
    tc = frames[ip].t + off * dtAt(ip) + 0.012 * sf;
  }

  // ③ 치는 방향(카메라 좌표, 수평): 임팩트 앞뒤 손목이 움직인 쪽
  const a = frames[Math.max(i0, ic - 2)], b = frames[Math.min(i1, ic + 1)];
  let d = G.sub(b.w[S.hit.wr], a.w[S.hit.wr]);
  d = G.unit([d[0], 0, d[2]]);
  // 화면에서 좌우로 움직였으면 '옆에서 찍음'. 화면 안쪽·바깥쪽으로 움직였으면 뒤(또는 앞)에서 찍은 것.
  const dx2 = (b.lm[S.hit.wr][0] - a.lm[S.hit.wr][0]);
  const view = Math.abs(d[0]) >= 0.8 * Math.abs(d[2]) ? 'side' : d[2] > 0 ? 'behind' : 'front';
  const dirX = Math.sign(dx2) || 1;                           // 옆 화면에서 '앞'이 오른쪽(+1)인지 왼쪽(-1)인지

  // ④ 핵심 순간
  const win = (t0, t1) => { const r = []; for (let i = i0; i <= i1; i++) if (frames[i].t >= t0 && frames[i].t <= t1) r.push(i); return r; };
  const knee = (i) => (G.angleAt(frames[i].w[J.lHip], frames[i].w[J.lKnee], frames[i].w[J.lAnk]) + G.angleAt(frames[i].w[J.rHip], frames[i].w[J.rKnee], frames[i].w[J.rAnk])) / 2;
  const argBest = (ids, f) => (ids.length ? ids.reduce((best, i) => (f(i) < f(best) ? i : best), ids[0]) : null);
  const pre = win(tc - 1.3 * sf, tc - 0.08 * sf);
  const keys = { contact: tc, finish: Math.min(frames[i1].t, tc + 0.3 * sf) };
  if (kind === 'serve') {
    const iTrophy = argBest(pre, knee);                       // 무릎이 가장 깊이 굽은 순간 = 트로피(로딩)
    const iToss = argBest(win(frames[i0].t, tc), (i) => -(frames[i].w[J.nose][1] - frames[i].w[S.off.wr][1]));
    keys.start = frames[i0].t;
    if (iToss != null) keys.toss = frames[iToss].t;
    if (iTrophy != null) keys.trophy = frames[iTrophy].t;
  } else {
    const iBack = argBest(pre, (i) => G.dot(frames[i].w[S.hit.wr], d));   // 손목이 치는 방향의 가장 뒤에 있을 때
    if (iBack != null) {
      keys.backswing = frames[iBack].t;
      const iLoad = argBest(win(frames[iBack].t, tc - 0.03 * sf), knee);
      if (iLoad != null) keys.load = frames[iLoad].t;
    }
    keys.ready = frames[i0].t;
  }

  // ⑤ 믿을 만한 정도: 임팩트 무렵 팔·다리가 얼마나 잘 보였나
  const around = near(-0.25, 0.1);
  const conf = around.length
    ? around.reduce((s, i) => s + G.vis(frames[i], S.hit.wr, S.hit.el, S.hit.sh, J.lHip, J.rHip, J.lKnee, J.rKnee), 0) / around.length : 0;

  return { i0, i1, ip, ic, tc, sf, peak: v[ip], stroke: kind, auto, twoHanded, hand, dir: d, dirX, view, keys, conf };
}

/** 스윙 하나만 담긴 짧은 영상: 가장 빠른 스윙 하나를 고른다 */
export function mainSwing(frames, opts = {}) {
  const all = detectSwings(frames, opts);
  if (!all.length) return null;
  return all.reduce((a, b) => (b.peak > a.peak ? b : a));
}

// 스윙 코치 — 자세 프레임 줄에서 스윙을 찾고(서브·포핸드·백핸드), 준비·임팩트 같은 핵심 순간을 고른다.
// DOM 을 쓰지 않는다(브라우저·Node 공용).
//
// 공·라켓은 보지 못한다. 치는 손목이 타점을 대신한다. 그래서 임팩트 시각은 '어림'이고,
// 그 어림이 얼마나 틀릴 수 있는지(tcErr 초, posErr 미터)를 같이 돌려준다. 화면에서 사용자가 한 프레임씩 고칠 수 있다(withContact).
import * as G from './geom.js';

const { J } = G;
const GAP = 0.25;                       // 이보다 긴 빈 구간(사람을 놓친 구간)은 이어 붙이지 않는다

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

/**
 * 손목 속도(초당 미터, 골반 기준 3차원). 몸이 걸어가는 것은 빠지고 팔 휘두르는 것만 남는다.
 * 프레임 수가 아니라 '시간'으로 다듬는다(sigma 초) — 25fps 와 240fps 에서 같은 뜻이 되게. 속도는 앞뒤 프레임의 가운데 차분.
 */
export function wristSpeed(frames, hand, sigma = 0.018) {
  const wr = G.sides(hand).hit.wr, n = frames.length;
  const q = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, sz = 0, sw = 0;
    for (let j = i; j >= 0 && frames[i].t - frames[j].t < 3 * sigma; j--) add(j);
    for (let j = i + 1; j < n && frames[j].t - frames[i].t < 3 * sigma; j++) add(j);
    q[i] = [sx / sw, sy / sw, sz / sw];
    function add(j) {
      const dt = frames[j].t - frames[i].t, w = Math.exp(-(dt * dt) / (2 * sigma * sigma));
      const p = frames[j].w[wr];
      sx += w * p[0]; sy += w * p[1]; sz += w * p[2]; sw += w;
    }
  }
  const v = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const a = frames[i].t - frames[i - 1].t, b = frames[i + 1].t - frames[i].t;
    if (a > 0 && b > 0 && a < GAP && b < GAP) v[i] = G.dist(q[i + 1], q[i - 1]) / (a + b);
  }
  return v.map((x) => (Number.isFinite(x) ? x : 0));
}

/** 영상 전체에서 그 사람의 키(모델 미터): 잘 보인 프레임들의 가운데값. 프레임마다 흔들리지 않게 하나로 고정한다. */
export function bodyScale(frames) {
  const hs = [];
  for (const f of frames) if (G.vis(f, J.lHip, J.rHip, J.lKnee, J.rKnee, J.lAnk, J.rAnk, J.lSh, J.rSh) > 0.5) hs.push(G.statureW(f));
  const h = G.median(hs.length >= 5 ? hs : frames.map(G.statureW));
  return Number.isFinite(h) && h > 0.5 ? h : NaN;
}

/**
 * 스윙 찾기. frames = [{t, lm, w}] (사람이 안 잡힌 프레임은 빼고, clean.js 로 다듬어서 넘긴다).
 * opts: hand 'R'|'L'(꼭 알려 준다), stroke(사용자가 고른 종류로 고정), sf(슬로모션 배수. 안 주면 어림하고 sfAuto 로 표시)
 * 돌려주는 것: 스윙 배열. 못 찾으면 [].
 */
export function detectSwings(frames, opts = {}) {
  const hand = opts.hand === 'L' ? 'L' : 'R';
  if (frames.length < 8) return [];
  const h = bodyScale(frames);
  if (!Number.isFinite(h)) return [];
  let v = wristSpeed(frames, hand);
  let vmax = Math.max(...v), p99 = G.percentile(v, 0.99);
  // 슬로모션(시간이 늘어난 영상)이면 속도가 낮게 나온다. 배수를 받았으면 그대로, 아니면 어림한다(느린 연습 스윙과 구분은 안 된다 → 화면에서 고칠 수 있게 표시).
  const sfGiven = Number(opts.sf) > 0 ? Number(opts.sf) : 0;
  if (!(vmax >= (sfGiven ? 1.2 / sfGiven : 0.5))) return [];   // 가만히 서 있는 영상: 스윙 없음
  let sf = sfGiven || 1, sfAuto = false;
  if (!sfGiven && p99 < 3.0 && vmax < 4.0) { sf = G.clamp(8 / vmax, 2, 12); sfAuto = true; }
  if (sf > 1) { v = wristSpeed(frames, hand, 0.018 * sf); vmax = Math.max(...v); p99 = G.percentile(v, 0.99); }
  const med = G.median(v);
  const thr = Math.max(0.45 * p99, 3.5 / sf, 2.5 * med, 1.0 / sf);
  const minGap = 0.8 * sf;

  const peaks = [];
  for (let i = 2; i < v.length - 2; i++) {
    if (v[i] < thr || v[i] < v[i - 1] || v[i] <= v[i + 1]) continue;
    // 돌출도: 앞뒤 0.4초 안에 속도가 절반 아래로 내려간 적이 있어야 '휘두름'이다(걷는 팔 흔들림·떨림 배제)
    let lowB = v[i], lowA = v[i];
    for (let j = i; j >= 0 && frames[i].t - frames[j].t < 0.45 * sf; j--) lowB = Math.min(lowB, v[j]);
    for (let j = i; j < v.length && frames[j].t - frames[i].t < 0.45 * sf; j++) lowA = Math.min(lowA, v[j]);
    if (lowB > 0.5 * v[i] || lowA > 0.6 * v[i]) continue;
    // 손이 실제로 멀리 갔어야 한다(자세 인식이 떨려서 생긴 속도 꼭대기 배제): 앞뒤 0.35초 사이 손목이 키의 0.3배 이상 이동
    const wrI = G.sides(hand).hit.wr;
    const pa = G.poseAt(frames, frames[i].t - 0.25 * sf), pb = G.poseAt(frames, frames[i].t + 0.1 * sf);
    if (G.dist(pa.w[wrI], pb.w[wrI]) < 0.3 * h) continue;
    const last = peaks[peaks.length - 1];
    if (last != null && frames[i].t - frames[last].t < minGap) { if (v[i] > v[last]) peaks[peaks.length - 1] = i; continue; }
    peaks.push(i);
  }

  const out = [];
  for (const ip of peaks) {
    const tp = frames[ip].t;
    const i0 = idxAt(frames, tp - 2.0 * sf), i1 = Math.min(frames.length - 1, idxAt(frames, tp + 0.9 * sf));
    if (ip - i0 < 3 || i1 - ip < 1) continue;                 // 앞뒤가 잘린 스윙은 분석하지 않는다
    let broken = false;                                        // 임팩트 무렵에 사람을 놓친 구간이 있으면 버린다
    for (let i = Math.max(i0 + 1, idxAt(frames, tp - 0.5 * sf)); i <= Math.min(i1, idxAt(frames, tp + 0.2 * sf)); i++) {
      if (frames[i].t - frames[i - 1].t > GAP * Math.max(1, sf / 2)) { broken = true; break; }
    }
    if (broken) continue;
    const sw = analyze(frames, v, { i0, i1, ip, sf, sfAuto, hand, h, stroke: opts.stroke });
    if (sw) out.push(sw);
  }
  // 서브 바로 앞(1.4초 안)에 잡힌 다른 스윙은 서브의 준비 동작(팔을 뒤로 돌려 올리는 것)이다 → 뺀다
  return out.filter((a) => a.stroke === 'serve' || !out.some((b) => b.stroke === 'serve' && b.tc > a.tc && b.tc - a.tc < 1.4 * sf));
}

function analyze(frames, v, { i0, i1, ip, sf, sfAuto, hand, h, stroke, tcOverride }) {
  const S = G.sides(hand), sign = hand === 'L' ? -1 : 1;
  const tp = frames[ip].t;
  const win = (t0, t1) => { const r = []; for (let i = i0; i <= i1; i++) if (frames[i].t >= t0 && frames[i].t <= t1) r.push(i); return r; };
  const near = (a, b) => win(tp + a * sf, tp + b * sf);
  const argBest = (ids, f) => (ids.length ? ids.reduce((best, i) => (f(i) < f(best) ? i : best), ids[0]) : null);
  const W = (i, j) => frames[i].w[j];
  const dtAt = (i) => (frames[Math.min(i + 1, frames.length - 1)].t - frames[Math.max(i - 1, 0)].t) / 2 || 1 / 30;

  // ① 종류: 손목이 머리 위로 올라가면 서브(스매시 포함), 아니면 백스윙 때 손목이 몸의 어느 쪽에 있었나로 포핸드/백핸드
  const upNose = (i) => W(i, J.nose)[1] - W(i, S.hit.wr)[1];
  const upMax = Math.max(...near(-0.12, 0.12).map(upNose));
  const back = near(-0.5, -0.1);
  let side = 0;
  for (const i of back) side += G.dot(G.sub(W(i, S.hit.wr), G.mid(W(i, J.lSh), W(i, J.rSh))), G.bodyFrame(frames[i]).R) * sign;
  side = back.length ? side / back.length / h : 0;
  const grip = near(-0.25, 0.0);
  const together = grip.length ? grip.filter((i) => G.dist(W(i, J.lWr), W(i, J.rWr)) < 0.13 * h).length / grip.length : 0;
  // 서브: 임팩트 무렵 손목이 머리 위로 올라가 있고, 그 직전(0.15초 전)에 이미 손이 어깨 위에 있었거나 반대 팔(토스)이 머리 위로 올라갔었다.
  // 원핸드 백핸드·높은 포핸드의 피니시도 손이 머리 위로 가지만, 치기 직전에는 손이 허리께에 있고 토스도 없다.
  const pPre = G.poseAt(frames, tp - 0.15 * sf);
  const preAboveShoulder = pPre.w[S.hit.sh][1] - pPre.w[S.hit.wr][1] > 0.02 * h;
  const tossUp = Math.max(-9, ...win(tp - 1.5 * sf, tp - 0.15 * sf).map((i) => W(i, J.nose)[1] - W(i, S.off.wr)[1])) > 0.03 * h;
  const auto = upMax > 0.11 * h && (preAboveShoulder || tossUp) ? 'serve' : side >= 0 ? 'forehand' : 'backhand';
  const kind = stroke || auto;
  const twoHanded = kind !== 'serve' && together >= 0.6;      // 임팩트 전 0.25초 동안 두 손이 계속 붙어 있었나
  const uncertain = !stroke && auto !== 'serve' && Math.abs(side) < 0.02;

  // ② 임팩트 시각(어림): 서브는 손목이 골반 기준 가장 높은 순간, 스트로크는 손목이 가장 빠른 순간 바로 뒤
  const wrUp = (i) => -W(i, S.hit.wr)[1];                     // 골반 중심 기준 손목 높이(머리를 숙여도 안 변한다)
  let tc, ic = ip;
  if (tcOverride != null) {
    tc = tcOverride; ic = idxAt(frames, tc);
  } else if (kind === 'serve') {
    const cand = near(-0.18, 0.18);
    ic = argBest(cand, (i) => -wrUp(i)) ?? ip;
    const off = ic > 0 && ic < frames.length - 1 ? parabolic(wrUp(ic - 1), wrUp(ic), wrUp(ic + 1)) : 0;
    tc = frames[ic].t + off * dtAt(ic);
  } else {
    tc = frames[ip].t + parabolic(v[ip - 1], v[ip], v[ip + 1]) * dtAt(ip) + 0.01 * sf;
  }
  const tcErr = dtAt(ic) / 2;                                 // 프레임 간격의 절반만큼은 알 수 없다
  const posErr = v[ic] * tcErr;                               // 그 사이 손목이 움직이는 거리(미터) = 타점 위치의 오차

  // ③ 핵심 순간
  const knee = (i) => (G.angleAt(W(i, J.lHip), W(i, J.lKnee), W(i, J.lAnk)) + G.angleAt(W(i, J.rHip), W(i, J.rKnee), W(i, J.rAnk))) / 2;
  const P = (t) => G.poseAt(frames, t);
  const horiz = (a, b) => { const d = G.sub(b, a); return [d[0], 0, d[2]]; };
  const keys = { contact: tc };
  // 피니시: 임팩트 뒤 손목 속도가 최고속도의 1/4 아래로 떨어지는 때(0.12~0.6초 사이)
  const after = win(tc + 0.12 * sf, tc + 0.6 * sf);
  const iFin = after.find((i) => v[i] < 0.25 * v[ip]);
  keys.finish = frames[iFin ?? after[after.length - 1] ?? i1].t;

  let dRaw, tFrom;
  const pc = P(tc);
  const d0 = horiz(P(tc - 0.06 * sf).w[S.hit.wr], P(Math.min(frames[i1].t, tc + 0.03 * sf)).w[S.hit.wr]);
  if (kind === 'serve') {
    const pre = win(tc - 1.3 * sf, tc - 0.08 * sf);
    const iLoad = argBest(pre, knee);                          // 무릎이 가장 깊이 굽은 순간
    const iToss = argBest(win(frames[i0].t, tc), (i) => -(W(i, J.nose)[1] - W(i, S.off.wr)[1]));
    // 트로피: 라켓이 등 뒤로 떨어지기(손목이 잠깐 내려가기) 직전, 치는 손이 가장 높이 들린 순간
    const iDrop = argBest(win(tc - 0.35 * sf, tc - 0.05 * sf), wrUp);
    let iTrophy = iDrop != null ? argBest(win(tc - 1.0 * sf, frames[iDrop].t), (i) => -wrUp(i)) : null;
    if (iTrophy == null || iDrop == null || wrUp(iTrophy) - wrUp(iDrop) < 0.03 * h) iTrophy = iLoad;
    keys.start = frames[i0].t;
    if (iToss != null) keys.toss = frames[iToss].t;
    if (iLoad != null) keys.load = frames[iLoad].t;
    if (iTrophy != null) keys.trophy = frames[iTrophy].t;
    tFrom = keys.trophy;
  } else {
    const u0 = G.len(d0) > 1e-6 ? G.unit(d0) : [1, 0, 0];
    const iBack = argBest(win(tc - 0.9 * sf, tc - 0.06 * sf), (i) => G.dot(W(i, S.hit.wr), u0));   // 손목이 가장 뒤에 있을 때
    keys.ready = frames[i0].t;
    if (iBack != null) {
      keys.backswing = frames[iBack].t;
      const iLoad = argBest(win(frames[iBack].t - 0.2 * sf, tc - 0.03 * sf), knee);
      if (iLoad != null) keys.load = frames[iLoad].t;
      tFrom = keys.backswing;
    }
  }

  // ④ 치는 방향(카메라 좌표, 수평): 백스윙 끝(트로피)에서 임팩트까지 손목이 간 쪽. 짧은 구간보다 훨씬 덜 흔들린다.
  dRaw = tFrom != null ? horiz(P(tFrom).w[S.hit.wr], pc.w[S.hit.wr]) : d0;
  if (G.len(dRaw) < 0.12 * h) dRaw = d0;
  const dirKnown = G.len(dRaw) >= 0.03 * h;
  const d = dirKnown ? G.unit(dRaw) : [1, 0, 0];
  // 화면에서 좌우로 움직였으면 '옆에서 찍음'. 화면 안쪽·바깥쪽이면 뒤(또는 앞)에서 찍은 것.
  const view = !dirKnown ? 'unknown' : Math.abs(d[0]) >= 0.8 * Math.abs(d[2]) ? 'side' : d[2] > 0 ? 'behind' : 'front';
  const from2 = P(tFrom != null ? tFrom : tc - 0.06 * sf);
  const dirX = Math.sign(pc.lm[S.hit.wr][0] - from2.lm[S.hit.wr][0]) || Math.sign(d[0]) || 1;   // 옆 화면에서 '앞'이 오른쪽(+1)인지

  // ⑤ 팔다리가 얼마나 잘 보였나(정확도가 아니라 '보인 정도')
  const around = near(-0.25, 0.1);
  const vis = around.length
    ? around.reduce((s, i) => s + G.vis(frames[i], S.hit.wr, S.hit.el, S.hit.sh, J.lHip, J.rHip, J.lKnee, J.rKnee), 0) / around.length : 0;

  return { i0, i1, ip, ic, tc, tcErr, posErr, sf, sfAuto, h, peak: v[ip], stroke: kind, auto, uncertain, twoHanded, hand,
    dir: d, dirKnown, dirX, view, keys, vis, conf: vis, _v: v };
}

/** 사용자가 임팩트 순간을 직접 고쳤을 때: 그 시각으로 핵심 순간·방향을 다시 잡는다 */
export function withContact(frames, swing, tc) {
  return analyze(frames, swing._v, { i0: swing.i0, i1: swing.i1, ip: swing.ip, sf: swing.sf, sfAuto: swing.sfAuto, hand: swing.hand, h: swing.h, stroke: swing.stroke, tcOverride: tc });
}

/** 사용자가 종류(서브·포핸드·백핸드)를 바로잡았을 때: 그 종류로 임팩트·핵심 순간을 다시 잡는다 */
export function withStroke(frames, swing, stroke) {
  return analyze(frames, swing._v, { i0: swing.i0, i1: swing.i1, ip: swing.ip, sf: swing.sf, sfAuto: swing.sfAuto, hand: swing.hand, h: swing.h, stroke });
}

/** 스윙 하나만 담긴 짧은 영상: 가장 빠른 스윙 하나를 고른다 */
export function mainSwing(frames, opts = {}) {
  const all = detectSwings(frames, opts);
  if (!all.length) return null;
  return all.reduce((a, b) => (b.peak > a.peak ? b : a));
}

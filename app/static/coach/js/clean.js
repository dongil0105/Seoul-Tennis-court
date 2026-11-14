// 스윙 코치 — 자세 프레임 줄 다듬기. 빠르게 휘두를 때 자세 인식이 흔들리는 두 가지를 고친다.
//  ① 좌우 뒤바뀜: 옆모습에서 왼쪽·오른쪽 관절 이름이 프레임마다 뒤집히는 것 → 앞 프레임과 이어지는 쪽으로 맞추고, 영상 전체에서 더 많은 쪽을 옳다고 본다.
//  ② 튀는 점: 한 프레임만 엉뚱한 곳으로 갔다 돌아오는 관절 → 앞뒤 프레임의 가운데로 바꾼다.
// DOM 을 쓰지 않는다(브라우저·Node 공용).
const PAIRS = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
const CHECK = [[11, 12], [13, 14], [15, 16], [23, 24], [25, 26], [27, 28]];   // 뒤바뀜을 판단할 때 보는 쌍
const LIMBS = [13, 14, 15, 16, 25, 26, 27, 28];

function swapLR(f) {
  const lm = f.lm.slice(), w = f.w.slice();
  for (const [a, b] of PAIRS) { [lm[a], lm[b]] = [lm[b], lm[a]]; [w[a], w[b]] = [w[b], w[a]]; }
  return { ...f, lm, w, swapped: !f.swapped };
}
const d2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** frames = [{t, lm, w}] → 다듬은 새 배열(원본은 건드리지 않는다). aspect = 영상 가로÷세로 */
export function cleanFrames(frames, aspect = 1) {
  if (frames.length < 3) return frames.slice();
  const sc = (p) => [p[0] * aspect, p[1]];
  // ① 좌우 뒤바뀜: 앞 두 프레임으로 '이번에 있을 자리'를 어림하고, 좌우를 바꾼 쪽이 그 자리에 훨씬 잘 맞으면 뒤집힌 것으로 본다.
  //    (빠르게 휘두르는 손목을 뒤바뀜으로 잘못 보지 않으려고 '그대로 이어 간 자리'와 견준다.)
  const parity = new Array(frames.length).fill(0);
  const seq = [frames[0]];
  for (let i = 1; i < frames.length; i++) {
    let cur = frames[i];
    const p1 = seq[i - 1], p2 = seq[i - 2];
    const dt = cur.t - p1.t;
    const k = p2 && p1.t - p2.t > 0 && p1.t - p2.t < 0.25 ? Math.min(2, dt / (p1.t - p2.t)) : 0;
    const pred = (j) => { const q = sc(p1.lm[j]); if (!k) return q; const r = sc(p2.lm[j]); return [q[0] + (q[0] - r[0]) * k, q[1] + (q[1] - r[1]) * k]; };
    let keep = 0, swap = 0;
    for (const [a, b] of CHECK) {
      const pa = pred(a), pb = pred(b);
      keep += d2(sc(cur.lm[a]), pa) + d2(sc(cur.lm[b]), pb);
      swap += d2(sc(cur.lm[a]), pb) + d2(sc(cur.lm[b]), pa);
    }
    const size = d2(sc(cur.lm[11]), sc(cur.lm[23])) + d2(sc(cur.lm[12]), sc(cur.lm[24])) || 0.2;   // 몸통 길이 두 배쯤
    const flipped = dt < 0.25 && swap < 0.5 * keep && keep > 0.6 * size && swap < 0.9 * size;
    parity[i] = parity[i - 1] ^ (flipped ? 1 : 0);
    if (flipped) cur = swapLR(cur);       // 앞 프레임과 이어지게 맞춘다
    seq.push(cur);
  }
  // 영상 전체에서 어느 쪽이 옳았나: 몸이 카메라를 정면(또는 등)으로 향해 어깨가 넓게 보일 때는 좌우가 헷갈리지 않는다.
  // 그런 프레임에서 더 많이 나온 쪽을 옳다고 본다.
  let w0 = 0, w1 = 0;
  frames.forEach((f, i) => {
    const wide = d2(sc(f.lm[11]), sc(f.lm[12])) / (d2(sc(f.lm[11]), sc(f.lm[23])) || 0.2);    // 어깨 너비 ÷ 몸통 길이
    const v = Math.max(0, wide - 0.25) * Math.min(f.lm[11][3], f.lm[12][3]) + 1e-4;
    if (parity[i]) w1 += v; else w0 += v;
  });
  let out = w1 > w0 ? seq.map(swapLR) : seq;

  // ② 한 프레임만 튄 팔다리 관절
  out = out.map((f) => ({ ...f, lm: f.lm.slice(), w: f.w.slice() }));
  for (let i = 1; i < out.length - 1; i++) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    if (c.t - a.t > 0.3) continue;
    for (const j of LIMBS) {
      const span = d2(sc(a.lm[j]), sc(c.lm[j]));
      const mx = [(a.lm[j][0] + c.lm[j][0]) / 2, (a.lm[j][1] + c.lm[j][1]) / 2];
      const off = d2(sc(b.lm[j]), sc(mx));
      if (off > 3 * span + 0.06) {
        b.lm[j] = [mx[0], mx[1], (a.lm[j][2] + c.lm[j][2]) / 2, Math.min(a.lm[j][3], c.lm[j][3]) * 0.5];
        b.w[j] = [(a.w[j][0] + c.w[j][0]) / 2, (a.w[j][1] + c.w[j][1]) / 2, (a.w[j][2] + c.w[j][2]) / 2, b.w[j][3]];
        b.fixed = (b.fixed || 0) + 1;
      }
    }
  }
  return out;
}

/** 다듬기 전후 통계(화면에 '화질이 낮아 정확도가 떨어져요'를 알릴 때) */
export function cleanStats(before, after) {
  let swapped = 0, fixed = 0;
  after.forEach((f, i) => { if (!!f.swapped !== !!before[i].swapped) swapped++; if (f.fixed) fixed++; });
  return { frames: after.length, swapped, fixed };
}

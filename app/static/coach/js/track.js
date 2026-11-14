// 스윙 코치 — 여러 사람이 나오는 영상에서 '이 사람'을 고르고 끝까지 따라간다.
// 사람을 알아보는 단서는 웃옷 색과 화면 위치다. 성별은 영상으로 맞히지 않는다(자주 틀리고, 틀리면 기분만 상한다) —
// 사용자가 사진을 보고 직접 고르고, 성별은 비교 기준(선수 분포)을 고를 때만 따로 묻는다.
// 색 계산은 DOM 없이 돌아간다(브라우저·Node 공용). 픽셀을 읽는 부분만 캔버스를 쓴다.

/** 웃옷 색: 어깨–골반 사각형 안쪽 픽셀의 가운데값. data = ImageData.data(RGBA), W,H = 그 이미지 크기. 못 구하면 null */
export function torsoColor(data, W, H, lm) {
  const P = (i) => [lm[i][0] * W, lm[i][1] * H];
  const [ls, rs, lh, rh] = [P(11), P(12), P(23), P(24)];
  const rsamp = [], gsamp = [], bsamp = [];
  for (let u = 0.25; u <= 0.75; u += 0.125) {            // 어깨선에서 골반선 쪽으로 15~60% (가슴·배)
    for (let v = 0.15; v <= 0.6; v += 0.09) {
      const ax = ls[0] + (rs[0] - ls[0]) * u, ay = ls[1] + (rs[1] - ls[1]) * u;
      const bx = lh[0] + (rh[0] - lh[0]) * u, by = lh[1] + (rh[1] - lh[1]) * u;
      const x = Math.round(ax + (bx - ax) * v), y = Math.round(ay + (by - ay) * v);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const o = (y * W + x) * 4;
      rsamp.push(data[o]); gsamp.push(data[o + 1]); bsamp.push(data[o + 2]);
    }
  }
  if (rsamp.length < 6) return null;
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  return [med(rsamp), med(gsamp), med(bsamp)];
}

/** RGB → 색 이름(한국어). 조명에 따라 달라지므로 넓게 나눈다. */
export function colorName([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 510, d = mx - mn;
  const s = mx === 0 ? 0 : d / mx;
  if (l > 0.82 && s < 0.18) return '흰색';
  if (l < 0.2) return '검정';
  if (s < 0.16) return l > 0.55 ? '밝은 회색' : '회색';
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  if (h < 15 || h >= 345) return l > 0.7 ? '분홍' : '빨강';
  if (h < 40) return l < 0.4 ? '갈색' : '주황';
  if (h < 70) return '노랑';
  if (h < 165) return l < 0.3 ? '짙은 초록' : '초록';
  if (h < 200) return '청록';
  if (h < 250) return l < 0.3 ? '남색' : '파랑';
  if (h < 290) return '보라';
  return '분홍';
}

/** 두 색의 거리(0~약 1.7). 밝기 차이는 덜 보고 색조 차이를 더 본다(그늘·햇빛에 덜 흔들리게). */
export function colorDist(a, b) {
  const n = (c) => { const s = c[0] + c[1] + c[2] + 1; return [c[0] / s, c[1] / s, c[2] / s, s / 766]; };
  const p = n(a), q = n(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 2.2 + Math.abs(p[3] - q[3]) * 0.6;
}

const center = (lm) => [(lm[11][0] + lm[12][0] + lm[23][0] + lm[24][0]) / 4, (lm[11][1] + lm[12][1] + lm[23][1] + lm[24][1]) / 4];
const height = (lm) => { let lo = 9, hi = -9; for (const k of lm) { if (k[1] < lo) lo = k[1]; if (k[1] > hi) hi = k[1]; } return hi - lo; };

const MIN_PERSON_VIS = 0.8;
/** 몸통·다리 관절이 또렷하게 보이는 정도(0~1). 배경을 사람으로 잘못 본 뼈대는 이 값이 낮다. */
export function poseVis(lm) {
  const idx = [11, 12, 23, 24, 25, 26, 27, 28];
  return idx.reduce((s, i) => s + (lm[i] && Number.isFinite(lm[i][3]) ? lm[i][3] : 0), 0) / idx.length;
}
/** 사람다운 몸 비례인지: 몸통(어깨–골반)에 견줘 다리·전체 길이가 터무니없지 않은지 */
export function bodyRatio(lm, aspect = 1) {
  const P = (i) => [lm[i][0] * aspect, lm[i][1]];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const torso = d(mid(P(11), P(12)), mid(P(23), P(24)));
  const leg = (d(P(23), P(25)) + d(P(25), P(27)) + d(P(24), P(26)) + d(P(26), P(28))) / 2;
  return torso > 1e-6 ? leg / torso : Infinity;
}

/**
 * 영상 여러 군데에서 본 사람들(obs = [{t, lm, color}])을 '같은 사람끼리' 묶는다. 색이 비슷하고 화면 크기가 비슷하면 같은 사람.
 * 돌려주는 것: [{ color, name, count, size, sample:{t,lm} }] — 많이 나온 순.
 */
export function groupPeople(obs) {
  const groups = [];
  for (const o of obs) {
    if (!o.color) continue;
    if (Number.isFinite(o.vis) && o.vis < MIN_PERSON_VIS) continue;    // 배경을 사람으로 잘못 본 뼈대(관절이 흐릿하게 잡힌다)는 버린다
    const size = height(o.lm);
    let best = null, bd = 0.27;
    for (const g of groups) {
      if (g.times.has(o.t)) continue;                             // 같은 화면에 이미 이 사람이 있다 → 다른 사람이다
      const d = colorDist(o.color, g.color) + Math.abs(Math.log(size / g.size)) * 0.04;   // 같은 사람도 멀리·가까이 오간다
      if (d < bd) { bd = d; best = g; }
    }
    const vis = Number.isFinite(o.vis) ? o.vis : 1, ratio = Number.isFinite(o.ratio) ? o.ratio : 1.7;
    if (!best) { groups.push({ color: o.color.slice(), count: 1, size, vis, ratio, sample: o, sizeBest: size, times: new Set([o.t]) }); continue; }
    best.count++; best.times.add(o.t);
    best.vis += (vis - best.vis) / best.count; best.ratio += (ratio - best.ratio) / best.count;
    best.color = best.color.map((c, i) => c + (o.color[i] - c) / best.count);
    best.size += (size - best.size) / best.count;
    const q = (x, sz) => (Number.isFinite(x.vis) ? x.vis : 1) * Math.sqrt(sz);
    if (q(o, size) > q(best.sample, best.sizeBest)) { best.sizeBest = size; best.sample = o; }   // 또렷하고 크게 나온 장면을 대표 사진으로
  }
  groups.sort((a, b) => b.count * b.size - a.count * a.size);
  return groups.map(({ times, ...g }) => ({ ...g, name: colorName(g.color) }));
}

/**
 * 고를 수 있는 사람들과 '한 사람 영상인지'. groups = groupPeople 결과(많이 나온 순), seen = 사람이 보인 화면 수.
 *  · 살펴본 화면의 1/4 이상(적어도 2번)에 나온 사람만 센다 — 잠깐 지나간 사람은 뺀다.
 *    카메라가 움직여 아무도 그만큼 나오지 않으면 2번 이상, 그래도 없으면 본 사람 모두를 후보로 둔다.
 *  · 주인공이 대부분의 화면(60% 이상)에 크게(화면 높이의 45% 이상) 나오고 나머지가 그 절반도 안 되면 한 사람 영상으로 본다 — 뒤 코트·구경하는 사람.
 *  · 경기 영상처럼 모두 작게 나오거나 누구도 계속 나오지 않으면, 크기와 상관없이 고르게 한다.
 */
export function mainPeople(groups, seen) {
  if (!groups.length) return { people: [], single: true };
  const need = Math.max(2, Math.ceil(seen * 0.25));
  let people = groups.filter((g) => g.count >= need);
  if (!people.length) people = groups.filter((g) => g.count >= 2);
  if (!people.length) people = groups.slice(0, 4);
  const main = people[0];
  const dominant = main.size >= 0.45 && main.count >= 0.6 * seen;
  const others = people.slice(1).filter((g) => !dominant || g.size >= 0.5 * main.size);
  people = [main, ...others].slice(0, 6);
  return { people, single: people.length === 1 };
}

/**
 * 따라가기: 이번 화면의 사람들(poses = [{lm}], colors = 각자의 웃옷 색) 중 대상이 누구인지 고른다. 없으면 -1.
 * state = { color, pos, size, t } 를 갱신한다(처음에는 { color } 만 채워 넘긴다).
 */
export function pickTarget(poses, colors, state, t) {
  let best = -1, bc = 0.34;
  for (let i = 0; i < poses.length; i++) {
    if (!colors[i]) continue;
    let cost = colorDist(colors[i], state.color);
    if (state.pos && t - state.t < 1.5) {
      const c = center(poses[i].lm);
      cost += Math.hypot(c[0] - state.pos[0], c[1] - state.pos[1]) * 0.5;      // 방금 있던 자리에서 가까울수록
      cost += Math.abs(Math.log(height(poses[i].lm) / state.size)) * 0.12;
    } else if (state.sizeRef) {
      cost += Math.abs(Math.log(height(poses[i].lm) / state.sizeRef)) * 0.06;    // 놓쳤다 다시 찾을 때: 고른 사람의 평소 크기에 가까운 쪽
    }
    if (cost < bc) { bc = cost; best = i; }
  }
  if (best >= 0) {
    state.pos = center(poses[best].lm); state.size = height(poses[best].lm); state.t = t;
    state.color = state.color.map((c, i) => c * 0.97 + colors[best][i] * 0.03);  // 조명이 서서히 바뀌는 것을 따라간다
  }
  return best;
}

/**
 * 한 사람 영상의 따라가기: 옷 색으로 찾되, 색을 못 읽었거나 조명이 달라져 못 찾으면
 * 방금 있던 자리에서 가장 가까운 사람을, 그것도 없고 화면에 한 명뿐이면 그 사람을 본다.
 * (처음부터 '가장 큰 사람'을 잡지 않는다 — 앞을 지나가는 사람이 대상이 되는 것을 막는다.)
 */
export function pickSingle(poses, colors, state, t) {
  const j = pickTarget(poses, colors, state, t);
  if (j >= 0 || !poses.length) return j;
  let best = -1, bd = 0.22;
  if (state.pos) poses.forEach((p, i) => { const c = center(p.lm), d = Math.hypot(c[0] - state.pos[0], c[1] - state.pos[1]); if (d < bd) { bd = d; best = i; } });
  if (best < 0 && poses.length === 1) best = 0;
  if (best >= 0) { state.pos = center(poses[best].lm); state.size = height(poses[best].lm); state.t = t; }
  return best;
}

/** 캔버스에 그린 화면에서 사람들 웃옷 색을 읽는다(브라우저 전용). ctx 는 작은 캔버스(가로 320쯤)의 2D 컨텍스트. */
export function readColors(ctx, source, poses) {
  const c = ctx.canvas;
  ctx.drawImage(source, 0, 0, c.width, c.height);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  return poses.map((p) => torsoColor(data, c.width, c.height, p.lm));
}

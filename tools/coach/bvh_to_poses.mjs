// 모션캡처(BVH) → 앱 엔진이 읽는 자세 줄. 같은 동작을 원하는 방향의 카메라에서 본 것처럼 만든다.
// Tennis-MoCap(https://github.com/jdpulgarin/Tennis-MoCap, CC BY-SA 3.0)의 뼈대(Arena, 23점)를 기준으로 썼다.
//
//   import { loadBvh, toFrames, facingDeg } from './bvh_to_poses.mjs'
//   const mo = loadBvh('x.bvh');                       // { fps, joints, frames: [{ pos: {이름: [x,y,z] (미터)}, fwd: {Hips, Head} }] }
//   const frames = toFrames(mo, { yaw: 180, every: 2 }) // yaw = 사람의 평균 정면을 기준으로 카메라를 돌린 각도(0 앞, 90·270 옆, 180 뒤)
//
// BVH 좌표: X = 사람의 왼쪽, Y = 위, Z = 사람의 앞(오른손 좌표계, 단위 cm).
// 앱(미디어파이프) 좌표: x = 화면 오른쪽, y = 아래, z = 카메라에서 멀어지는 쪽. 골반 가운데가 원점, 단위 m.
import fs from 'node:fs';

const rad = (d) => (d * Math.PI) / 180;
const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const app = (A, v) => A.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const ROT = {
  Xrotation: (a) => { const c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, -s], [0, s, c]]; },
  Yrotation: (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; },
  Zrotation: (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; },
};
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export function parseBvh(text) {
  const lines = text.split(/\r?\n/);
  const joints = [], stack = [];
  let pending = -1, i = 0;
  for (; i < lines.length; i++) {
    const L = lines[i].trim();
    if (L.startsWith('ROOT') || L.startsWith('JOINT')) { joints.push({ name: L.split(/\s+/)[1], parent: stack.length ? stack[stack.length - 1] : -1, offset: [0, 0, 0], channels: [] }); pending = joints.length - 1; }
    else if (L.startsWith('End Site')) { const p = stack[stack.length - 1]; joints.push({ name: joints[p].name + '_End', parent: p, offset: [0, 0, 0], channels: [] }); pending = joints.length - 1; }
    else if (L === '{') stack.push(pending);
    else if (L === '}') stack.pop();
    else if (L.startsWith('OFFSET')) joints[stack[stack.length - 1]].offset = L.split(/\s+/).slice(1).map(Number);
    else if (L.startsWith('CHANNELS')) joints[stack[stack.length - 1]].channels = L.split(/\s+/).slice(2);
    else if (L.startsWith('MOTION')) break;
  }
  const n = Number(lines[i + 1].split(':')[1]), dt = Number(lines[i + 2].split(':')[1]);
  const rows = [];
  for (let k = i + 3; k < lines.length && rows.length < n; k++) { const L = lines[k].trim(); if (L) rows.push(L.split(/\s+/).map(Number)); }
  return { joints, dt, rows };
}

/** 관절 위치(미터)와 골반·머리의 '앞' 방향을 프레임마다 계산한다 */
export function loadBvh(file) {
  const { joints, dt, rows } = parseBvh(fs.readFileSync(file, 'utf8'));
  const frames = rows.map((row) => {
    let c = 0;
    const R = new Array(joints.length), P = new Array(joints.length), pos = {}, fwd = {};
    joints.forEach((j, idx) => {
      let t = [0, 0, 0], local = I3;
      for (const ch of j.channels) {
        const val = row[c++];
        if (ch === 'Xposition') t[0] = val; else if (ch === 'Yposition') t[1] = val; else if (ch === 'Zposition') t[2] = val;
        else local = mul(local, ROT[ch](rad(val)));
      }
      if (j.parent < 0) { P[idx] = [j.offset[0] + t[0], j.offset[1] + t[1], j.offset[2] + t[2]]; R[idx] = local; }
      else { const o = app(R[j.parent], j.offset); P[idx] = [P[j.parent][0] + o[0], P[j.parent][1] + o[1], P[j.parent][2] + o[2]]; R[idx] = mul(R[j.parent], local); }
      pos[j.name] = P[idx].map((x) => x / 100);
      if (j.name === 'Hips' || j.name === 'Head') fwd[j.name] = app(R[idx], [0, 0, 1]);
    });
    return { pos, fwd };
  });
  return { fps: 1 / dt, joints: joints.map((j) => j.name), frames };
}

/** 사람이 평균적으로 향한 방향(수평, 도). 0 = +Z, 90 = +X(사람의 왼쪽 방향 축) */
export function facingDeg(mo) {
  let x = 0, z = 0;
  for (const f of mo.frames) { x += f.fwd.Hips[0]; z += f.fwd.Hips[2]; }
  return (Math.atan2(x, z) * 180) / Math.PI;
}

/**
 * 앱의 자세 프레임으로 바꾼다. opt: yaw(도, 사람 정면 기준 카메라 방향: 0 앞에서, 180 뒤에서), every(몇 프레임마다),
 * scale(화면에서 1m 가 차지하는 높이 비율, 기본 0.28), aspect(가로/세로, 기본 16/9)
 */
export function toFrames(mo, { yaw = 0, every = 1, scale = 0.28, aspect = 16 / 9 } = {}) {
  const a = rad(facingDeg(mo) + yaw), ca = Math.cos(a), sa = Math.sin(a);
  // 사람의 평균 정면이 카메라를 보게 돌린 뒤(yaw 만큼 더), 카메라 좌표로: x' = 사람 왼쪽 → 화면 오른쪽, y 아래, z 멀어지는 쪽
  const cam = (p) => { const X = p[0] * ca - p[2] * sa, Z = p[0] * sa + p[2] * ca; return [X, -p[1], -Z]; };
  const hip0 = (() => { const s = [0, 0, 0]; for (const f of mo.frames) { const h = cam(f.pos.Hips); s[0] += h[0]; s[1] += h[1]; s[2] += h[2]; } return s.map((x) => x / mo.frames.length); })();
  const out = [];
  for (let i = 0; i < mo.frames.length; i += every) {
    const f = mo.frames[i], J = (n) => cam(f.pos[n]);
    const add = (p, q, k) => [p[0] + q[0] * k, p[1] + q[1] * k, p[2] + q[2] * k];
    const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const head = J('Head'), top = J('Head_End');
    const hf = (() => { const v = f.fwd.Head; const X = v[0] * ca - v[2] * sa, Z = v[0] * sa + v[2] * ca; return [X, -v[1], -Z]; })();
    const mid = add(head, sub(top, head), 0.5);
    const nose = add(mid, hf, 0.09);
    const lsh = J('LeftShoulder'), rsh = J('RightShoulder');
    const earAxis = (() => { const d = sub(lsh, rsh); const L = Math.hypot(...d) || 1; return d.map((x) => x / L); })();
    const pts = new Array(33);
    pts[0] = nose; for (const k of [1, 2, 3]) pts[k] = add(nose, earAxis, 0.03); for (const k of [4, 5, 6]) pts[k] = add(nose, earAxis, -0.03);
    pts[7] = add(mid, earAxis, 0.075); pts[8] = add(mid, earAxis, -0.075);
    pts[9] = add(add(nose, [0, 1, 0], 0.05), earAxis, 0.02); pts[10] = add(add(nose, [0, 1, 0], 0.05), earAxis, -0.02);
    pts[11] = lsh; pts[12] = rsh; pts[13] = J('LeftElbow'); pts[14] = J('RightElbow'); pts[15] = J('LeftWrist'); pts[16] = J('RightWrist');
    for (const k of [17, 19, 21]) pts[k] = J('LeftWrist_End'); for (const k of [18, 20, 22]) pts[k] = J('RightWrist_End');
    pts[23] = J('LeftHip'); pts[24] = J('RightHip'); pts[25] = J('LeftKnee'); pts[26] = J('RightKnee'); pts[27] = J('LeftAnkle'); pts[28] = J('RightAnkle');
    pts[29] = add(pts[27], [0, 1, 0], 0.05); pts[30] = add(pts[28], [0, 1, 0], 0.05); pts[31] = J('LeftAnkle_End'); pts[32] = J('RightAnkle_End');
    const hc = [(pts[23][0] + pts[24][0]) / 2, (pts[23][1] + pts[24][1]) / 2, (pts[23][2] + pts[24][2]) / 2];
    const w = pts.map((p) => [p[0] - hc[0], p[1] - hc[1], p[2] - hc[2], 1]);
    const lm = pts.map((p) => [0.5 + ((p[0] - hip0[0]) * scale) / aspect, 0.55 + (p[1] - hip0[1]) * scale, p[2] - hc[2], 1]);
    out.push({ t: i / mo.fps, lm, w });
  }
  return out;
}

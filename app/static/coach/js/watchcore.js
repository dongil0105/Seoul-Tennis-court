// 스윙 코치 — '화면 보고 학습'의 계산 부분. DOM 을 쓰지 않는다(브라우저·Node 공용, 테스트가 여기를 본다).
// 화면(watch.js)은 다른 탭의 영상을 화면 공유로 받아 프레임마다 자세를 뽑고, 여기 함수들로
//   ① 여러 사람 중 누구를 볼지 정하고 ② 멀리 작게 찍힌 선수는 따라가며 확대하고 ③ 2분쯤마다 '묶음'으로 만들어 보낸다.
// 묶음에 들어가는 것: 스윙 후보(손목이 빨랐던 순간)마다의 움직임 특징 660개와 모델이 본 확률, 몇 개 스윙의 관절 좌표, 설정.
// 영상·소리·화면 그림·영상 주소는 들어가지 않는다(메모 칸에 사용자가 직접 적은 글만 들어간다).
import { packFrames, unpackFrames, DIAG_KEEP } from './diag.js';

export const CHUNK_SEC = 120;        // 묶음 하나의 길이(초)
export const OVERLAP = 2;            // 다음 묶음과 겹치는 길이(초) — 경계에 걸린 스윙을 놓치지 않게
export const TAIL = 0.8;             // 묶음 끝에서 이만큼 안쪽의 후보만 그 묶음에서 다룬다(뒤쪽 동작이 아직 안 들어왔다)
export const DETAIL_SEC = 600;       // 처음 10분은 자세 줄 전체도 보낸다(제대로 보고 있는지 확인용). 그 뒤로는 특징만
export const WINDOWS = 3;            // 묶음마다 관절 좌표까지 보내는 스윙 수(확률이 높은 것부터)
export const TAP_KEYS = { KeyF: 'forehand', KeyB: 'backhand', KeyS: 'serve', KeyV: 'volley', KeyM: 'smash' };

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r = (x, n) => (Number.isFinite(x) ? Math.round(x * n) / n : null);

/** 자세가 화면 어디에 얼마나 크게 있는지(화면 비율 0~1): 골반 가운데와 키 */
export function personBox(lm) {
  let top = Infinity, bottom = -Infinity;
  for (const p of lm) { if (!p || !Number.isFinite(p[1])) continue; if (p[1] < top) top = p[1]; if (p[1] > bottom) bottom = p[1]; }
  return { cx: (lm[23][0] + lm[24][0]) / 2, cy: (lm[23][1] + lm[24][1]) / 2, h: Math.max(0, bottom - top) };
}

/**
 * 여러 사람 중 누구를 볼지. boxes = personBox 들, target = 지금 따라가는 사람(없으면 null).
 * 따라가는 사람이 있으면 그 자리에 가장 가까운 사람(너무 멀면 -1: 다른 사람으로 갈아타지 않는다), 없으면 가장 크게 나온 사람.
 */
export function pickPerson(boxes, target, maxJump = 0.22) {
  if (!boxes.length) return -1;
  if (!target) { let k = 0; boxes.forEach((b, i) => { if (b.h > boxes[k].h) k = i; }); return k; }
  let k = -1, best = Infinity;
  boxes.forEach((b, i) => { const d = Math.hypot(b.cx - target.cx, b.cy - target.cy); if (d < best) { best = d; k = i; } });
  return best <= Math.max(maxJump, target.h * 0.9) ? k : -1;
}

/** 따라가는 자리를 새 자세 쪽으로 부드럽게 옮긴다 */
export function follow(target, box, a = 0.6) {
  if (!target) return { ...box };
  return { cx: target.cx + a * (box.cx - target.cx), cy: target.cy + a * (box.cy - target.cy), h: target.h + 0.3 * (box.h - target.h) };
}

/** 선수가 화면 높이의 zoomBelow 보다 작게 나오면 따라가며 확대한다 */
export const needZoom = (target, zoomBelow = 0.45) => !!target && target.h > 0.02 && target.h < zoomBelow;

/** 확대해서 볼 정사각형(픽셀): 선수 키의 k 배, 화면 밖으로 나가지 않게 */
export function zoomRect(target, W, H, k = 2.6) {
  const s = Math.round(clamp(target.h * H * k, Math.min(160, W, H), Math.min(W, H)));
  return { x: Math.round(clamp(target.cx * W - s / 2, 0, W - s)), y: Math.round(clamp(target.cy * H - s / 2, 0, H - s)), s };
}

/** 확대한 화면에서 얻은 자세(0~1)를 전체 화면의 좌표(0~1)로 */
export function toFull(lm, rect, W, H) {
  return lm.map((p) => [(rect.x + p[0] * rect.s) / W, (rect.y + p[1] * rect.s) / H, (p[2] * rect.s) / W, p[3]]);
}

// ── 특징 벡터를 작게: 16비트 정수 → base64. 위치·회전은 ×10000(±3.27), 44번째마다 있는 손목 속도는 ×2000(±16.4)
const scaleOf = (i) => (i % 44 === 43 ? 2000 : 10000);
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
export function packFeat(x) {
  const q = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) q[i] = clamp(Math.round((Number.isFinite(x[i]) ? x[i] : 0) * scaleOf(i)), -32767, 32767);
  return b64(new Uint8Array(q.buffer));
}
export function unpackFeat(text) {
  const bin = atob(text), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const q = new Int16Array(bytes.buffer);
  return Array.from(q, (v, i) => v / scaleOf(i));
}

/**
 * 묶음 하나의 내용.
 *   frames = 이번 묶음의 자세 줄(다듬기 전, 시각은 이번 보기를 시작한 때부터의 초)
 *   cands  = 이번 묶음에서 새로 다루는 후보들 [{ t, v, s, stroke, sub, P, x }] (moment.scoreCandidates 에 keepX 를 준 것)
 *   shots  = 그중 스윙으로 고른 것(moment.pickSwings), taps = 보면서 누른 표시 [{ t, k }]
 *   detail = 자세 줄 전체를 담을지(아니면 확률 높은 스윙 몇 개의 앞뒤 1.5초만)
 */
export function buildChunk({ session, seq, profile, meta, frames, cands, shots, taps, final, detail }) {
  const t0 = frames.length ? frames[0].t : 0, t1 = frames.length ? frames[frames.length - 1].t : 0;
  const classes = cands && cands.length ? Object.keys(cands[0].P) : [];
  const best = [...(shots || [])].sort((a, b) => b.s - a.s).slice(0, WINDOWS);
  return {
    kind: 'swing-coach-watch', v: 1, made: new Date().toISOString(), app: 'w1',
    session: String(session), seq: Number(seq) || 0, final: !!final,
    profile: { hand: profile.hand === 'L' ? 'L' : 'R', backhand: profile.backhand === '1h' ? '1h' : '2h' },
    meta: { note: String(meta.note || '').slice(0, 300), view: meta.view || null, level: meta.level || null, only: meta.only || null, device: meta.device ? String(meta.device).slice(0, 20) : null,
      width: meta.width || null, height: meta.height || null, zoomed: r(meta.zoomed, 100), found: r(meta.found, 100),
      fps: r(frames.length > 1 ? (frames.length - 1) / Math.max(1e-6, t1 - t0) : 0, 10) },
    t0: r(t0, 1000), t1: r(t1, 1000), frames: frames.length, classes,
    cands: (cands || []).map((c) => ({ t: r(c.t, 100), v: r(c.v, 100), P: classes.map((k) => r(c.P[k], 1000)), x: packFeat(c.x) })),
    shots: (shots || []).map((s) => ({ t: r(s.t, 100), stroke: s.stroke, sub: s.sub || null, s: r(s.s, 1000) })),
    taps: (taps || []).map((x) => ({ t: r(x.t, 100), k: x.k })),
    keep: DIAG_KEEP,
    track: detail ? packFrames(frames) : null,
    windows: detail ? [] : best.map((s) => ({ t: r(s.t, 100), track: packFrames(frames.filter((f) => Math.abs(f.t - s.t) <= 1.5)) })),
  };
}

/** 머리말(X-Coach-Meta)에 넣을 짧은 설명 — 아스키 글자만(한글은 \uXXXX 로) */
export function metaHeader(chunk) {
  const m = { session: chunk.session, seq: chunk.seq, frames: chunk.frames, sec: Math.round(chunk.t1 - chunk.t0), cands: chunk.cands.length, shots: chunk.shots.length,
    only: chunk.meta.only, view: chunk.meta.view, device: chunk.meta.device ? chunk.meta.device.slice(0, 10) : null, note: chunk.meta.note.slice(0, 24) };
  return JSON.stringify(m).replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/**
 * 받은 쪽에서: 한 번 보기(session)의 묶음들을 잇는다(겹친 부분은 한 번만).
 * 돌려주는 것: { cands: [{ t, v, P: {종류: 확률}, x: [660], seq, only, view, hand }], shots, taps, frames(자세 줄 전체를 보낸 구간), windows, profile, meta(첫 묶음의 것) }
 */
export function joinChunks(chunks) {
  const list = [...chunks].sort((a, b) => a.seq - b.seq);
  const frames = [], shots = [], taps = [], cands = [], windows = [];
  let last = -Infinity;
  for (const c of list) {
    if (c.track) for (const f of unpackFrames(c.track)) if (f.t > last + 1e-4) { frames.push(f); last = f.t; }
    for (const w of c.windows || []) windows.push({ t: w.t, frames: unpackFrames(w.track) });
    for (const x of c.cands || []) if (!cands.some((y) => Math.abs(y.t - x.t) < 0.05)) cands.push({ t: x.t, v: x.v, P: Object.fromEntries(c.classes.map((k, i) => [k, x.P[i]])), x: unpackFeat(x.x),
      seq: c.seq, only: (c.meta || {}).only || null, view: (c.meta || {}).view || null, hand: (c.profile || {}).hand || 'R', fps: (c.meta || {}).fps || 0 });   // 설정은 묶음마다 다를 수 있다(영상마다 바꿔 가며 볼 때)
    for (const s of c.shots || []) if (!shots.some((x) => Math.abs(x.t - s.t) < 0.35)) shots.push(s);
    for (const x of c.taps || []) if (!taps.some((y) => Math.abs(y.t - x.t) < 0.05 && y.k === x.k)) taps.push(x);
  }
  for (const a of [cands, shots, taps]) a.sort((p, q) => p.t - q.t);
  return { cands, shots, taps, frames, windows, profile: list[0] ? list[0].profile : null, meta: list[0] ? list[0].meta : null };
}

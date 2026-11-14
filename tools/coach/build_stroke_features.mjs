#!/usr/bin/env node
// 분류기 학습 자료 만들기: THETIS(영상 → 자세 인식)와 Tennis-MoCap(모션캡처)의 스윙마다 특징 벡터와 정답을 한 줄씩 적는다.
//   node tools/coach/build_stroke_features.mjs --thetis <자세 줄 폴더> --mocap <Tennis-MoCap 폴더> --out feats.jsonl
//   그다음: python3 tools/coach/train_strokes.py feats.jsonl --out app/static/coach/data/stroke_model.json
//
// 자료(이 저장소에 싣지 않는다):
//  · THETIS — https://github.com/THETIS-dataset/dataset 의 VIDEO_RGB/<종류>/<사람>_<종류>_s1.avi 를 video_to_poses.mjs(--fps 17) 로 뽑아
//    <자세 줄 폴더>/<종류>__<파일 이름>.json 으로 둔다. 영상은 좌우가 거울처럼 뒤집혀 있어서 치는 손은 사람별로 영상에서 정한다.
//  · Tennis-MoCap — https://github.com/jdpulgarin/Tennis-MoCap (CC BY-SA 3.0). labels.csv 와 data/*.bvh.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..'), JS = path.join(REPO, 'app', 'static', 'coach', 'js');
const arg = {};
{ const v = process.argv.slice(2); for (let i = 0; i < v.length; i += 2) arg[v[i].replace(/^--/, '')] = v[i + 1]; }
if (!arg.thetis || !arg.mocap || !arg.out) { console.error('usage: build_stroke_features.mjs --thetis <dir> --mocap <dir> --out feats.jsonl'); process.exit(2); }
const { cleanFrames } = await import(`${JS}/clean.js`);
const { detectSwings, wristSpeed, bodyScale } = await import(`${JS}/swing.js`);
const { swingFeatures } = await import(`${JS}/classify.js`);
const G = await import(`${JS}/geom.js`);
const { loadBvh, toFrames } = await import(path.join(HERE, 'bvh_to_poses.mjs'));
const out = fs.createWriteStream(arg.out);
const put = (o) => out.write(JSON.stringify(o) + '\n');
const r4 = (a) => a.map((x) => Math.round(x * 1e4) / 1e4);

// ── THETIS: 영상 하나에 스윙 하나 ──
const LABEL = { backhand: 'bh1', backhand2hands: 'bh2', backhand_slice: 'bhslice', backhand_volley: 'bvolley', forehand_flat: 'fh', forehand_openstands: 'fh',
  forehand_slice: 'fhslice', forehand_volley: 'fvolley', flat_service: 'serve', kick_service: 'serve', slice_service: 'serve', smash: 'smash' };
const dir = arg.thetis;
const clips = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { const [cls, name] = f.replace(/\.json$/, '').split('__'); return { f, cls, who: name.split('_')[0] }; });
const load = (c) => { if (!c.frames) { const d = JSON.parse(fs.readFileSync(path.join(dir, c.f), 'utf8')); c.frames = cleanFrames(d.frames.filter(G.validPose), d.width / d.height); } return c.frames; };
const vote = {};
for (const c of clips) {
  if (c.cls === 'backhand2hands') continue;
  const fr = load(c); if (fr.length < 10) continue;
  const mv = [0, 0];
  for (let i = 1; i < fr.length; i++) for (const [k, j] of [[0, 15], [1, 16]]) mv[k] += Math.hypot(fr[i].lm[j][0] - fr[i - 1].lm[j][0], fr[i].lm[j][1] - fr[i - 1].lm[j][1]);
  if (Math.max(...mv) > 1.25 * Math.min(...mv)) (vote[c.who] ||= []).push(mv[1] >= mv[0] ? 'R' : 'L');
}
const handOf = (w) => { const v = vote[w]; if (!v) return 'R'; return v.filter((x) => x === 'R').length >= v.length / 2 ? 'R' : 'L'; };
let n1 = 0, nodet = 0;
for (const c of clips) {
  const fr = load(c); if (fr.length < 20) continue;
  const hand = handOf(c.who), h = bodyScale(fr);
  if (!Number.isFinite(h)) continue;
  const all = detectSwings(fr, { hand, backhand: c.cls === 'backhand2hands' ? '2h' : '1h' });
  let tp, det = true, rule = null;
  if (all.length) { const real = all.filter((s) => !s.suspect); const s = (real.length ? real : all).reduce((a, b) => (b.peak > a.peak ? b : a)); tp = fr[s.ip].t; rule = s.stroke; }
  else { const v = wristSpeed(fr, hand); let bi = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[bi]) bi = i; tp = fr[bi].t; det = false; nodet++; }
  put({ src: 'thetis', who: 'T' + c.who, label: LABEL[c.cls], cls: c.cls, det, rule, x: r4(swingFeatures(fr, tp, hand, h)) });
  n1++;
}
console.error(`THETIS ${n1}개(스윙을 못 찾아 가장 빠른 순간을 쓴 것 ${nodet}개)`);

// ── Tennis-MoCap: 파일 하나에 같은 스윙 여러 번. 카메라 네 방향 + 자세 인식처럼 흔들림을 넣는다 ──
const DATA = arg.mocap;
const KIND = ['serve', 'smash', 'fh', 'fvolley', 'bh', 'bvolley'];
const rows = fs.readFileSync(path.join(DATA, 'labels.csv'), 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(';')).filter((r) => fs.existsSync(path.join(DATA, 'data', r[0])));
const who = (f) => f.split('_')[0].toLowerCase();
const mo = new Map();
const getMo = (f) => { if (!mo.has(f)) mo.set(f, loadBvh(path.join(DATA, 'data', f))); return mo.get(f); };
const mvote = {};
for (const [f, , , , k] of rows) { if (!['0', '1', '2', '3'].includes(k)) continue; const fr = toFrames(getMo(f), { yaw: 90, every: 2 }); (mvote[who(f)] ||= []).push(Math.max(...wristSpeed(fr, 'R')) >= Math.max(...wristSpeed(fr, 'L')) ? 'R' : 'L'); }
const mhand = (f) => { const v = mvote[who(f)] || ['R']; return v.filter((x) => x === 'R').length >= v.length / 2 ? 'R' : 'L'; };
// 자세 인식의 흔들림 흉내: 화면 방향 1.5cm, 깊이 6cm (0.15초쯤 이어지는 느린 흔들림 + 프레임마다 작은 떨림)
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
function shake(frames) {
  const drift = Array.from({ length: 33 }, () => [0, 0, 0]);
  return frames.map((f) => {
    const w = f.w.map((p, j) => {
      for (let k = 0; k < 3; k++) drift[j][k] = 0.85 * drift[j][k] + 0.53 * gauss() * (k === 2 ? 0.06 : 0.015);
      return [p[0] + drift[j][0] + 0.004 * gauss(), p[1] + drift[j][1] + 0.004 * gauss(), p[2] + drift[j][2] + 0.015 * gauss(), 1];
    });
    return { t: f.t, lm: f.lm, w };
  });
}
let n2 = 0;
for (const [f, hp, , , k] of rows) {
  const kind = KIND[Number(k)], hand = mhand(f);
  for (const yaw of [0, 90, 180, 270]) {
    const clean = toFrames(getMo(f), { yaw, every: 2 });
    const h = bodyScale(clean);
    const close = clean.filter((x) => G.dist(x.w[15], x.w[16]) < 0.13 * h).length / clean.length;
    const label = kind === 'bh' ? (close > 0.35 ? 'bh2' : 'bh1') : kind;
    const sw = detectSwings(clean, { hand, backhand: label === 'bh2' ? '2h' : '1h' });       // 스윙 시각은 깨끗한 자료에서 잡는다
    const noisy = shake(clean);
    for (const s of sw) { put({ src: 'mocap', who: 'M' + who(f), label, cls: kind, det: true, rule: s.stroke, yaw, hp: Number(hp), x: r4(swingFeatures(noisy, clean[s.ip].t, hand, h)) }); n2++; }
  }
}
console.error(`모션캡처 ${n2}개(카메라 4방향)`);
out.end();

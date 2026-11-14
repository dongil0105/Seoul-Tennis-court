#!/usr/bin/env node
// 분류기 학습 자료 만들기: THETIS(영상 → 자세 인식)와 Tennis-MoCap(모션캡처)의 스윙마다 특징 벡터(js/classify.js 의 swingSequence)와 정답을 한 줄씩 적는다.
//   node tools/coach/build_stroke_features.mjs --thetis <자세 줄 폴더> --mocap <Tennis-MoCap 폴더> --out feats.jsonl
//   그다음: python3 tools/coach/train_strokes.py feats.jsonl --out app/static/coach/data/stroke_model.json
//
// 자료(이 저장소에 싣지 않는다):
//  · THETIS — https://github.com/THETIS-dataset/dataset 의 VIDEO_RGB/<종류>/<사람>_<종류>_s<회차>.avi 를 video_to_poses.mjs(--fps 17) 로 뽑아
//    <자세 줄 폴더>/<종류>__<파일 이름>.json 으로 둔다.
//  · Tennis-MoCap — https://github.com/jdpulgarin/Tennis-MoCap (CC BY-SA 3.0). labels.csv 와 data/*.bvh.
//
// 정답을 다룰 때 알아 둘 것(직접 확인한 것):
//  · THETIS 영상은 좌우가 거울처럼 뒤집혀 있다 → 치는 손은 사람별로 영상에서 정한다(thetis_util.mjs 의 inferHands).
//  · Tennis-MoCap 의 jsgiraldo_VDerecha.bvh 는 jsgiraldo_VReves.bvh 와 바이트까지 같은 파일이다(내용은 백핸드 발리) → 뺀다.
//  · 스윙을 못 찾은 영상(느리게 흉내만 낸 동작)은 학습에 넣지 않는다 — 앱에서도 분류기는 찾은 스윙에만 쓰인다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JS, THETIS_LABEL, listClips, loadClip, inferHands } from './thetis_util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = {};
{ const v = process.argv.slice(2); for (let i = 0; i < v.length; i += 2) arg[v[i].replace(/^--/, '')] = v[i + 1]; }
if (!arg.thetis || !arg.mocap || !arg.out) { console.error('usage: build_stroke_features.mjs --thetis <dir> --mocap <dir> --out feats.jsonl'); process.exit(2); }
const { cleanFrames } = await import(path.join(JS, 'clean.js'));
const { detectSwings, wristSpeed, bodyScale } = await import(path.join(JS, 'swing.js'));
const { swingSequence } = await import(path.join(JS, 'classify.js'));
const G = await import(path.join(JS, 'geom.js'));
const { loadBvh, toFrames } = await import(path.join(HERE, 'bvh_to_poses.mjs'));
const out = fs.createWriteStream(arg.out);
const put = (o) => out.write(JSON.stringify(o) + '\n');
const r4 = (a) => a.map((x) => Math.round(x * 1e4) / 1e4);
/** 찾은 스윙 가운데 하나를 고른다: 의심 없는 것 중 가장 빠른 것, 없으면 의심 있는 것 중 가장 빠른 것 */
const best = (all) => { const real = all.filter((s) => !s.suspect); return (real.length ? real : all).reduce((a, b) => (!a || b.peak > a.peak ? b : a), null); };

// ── THETIS: 영상 하나에 스윙 하나 ──
const clips = listClips(arg.thetis);
const hands = inferHands(clips, arg.thetis, { cleanFrames, wristSpeed, G });
let n1 = 0, none = 0;
for (const c of clips) {
  const fr = loadClip(c, arg.thetis, { cleanFrames, G });
  if (fr.length < 20 || !hands[c.who]) continue;
  const hand = hands[c.who].hand, h = bodyScale(fr);
  if (!Number.isFinite(h)) continue;
  const s = best(detectSwings(fr, { hand, backhand: c.cls === 'backhand2hands' ? '2h' : '1h' }));
  if (!s) { none++; continue; }
  put({ src: 'thetis', who: 'T' + c.who, label: THETIS_LABEL[c.cls], cls: c.cls, rule: s.stroke, sus: !!s.suspect, x: r4(swingSequence(fr, fr[s.ip].t, hand, h, s.sf, s._v)) });
  n1++;
}
console.error(`THETIS: 스윙 ${n1}개(스윙을 못 찾은 영상 ${none}개는 뺐다) · 영상 기준 왼손 ${Object.values(hands).filter((v) => v.hand === 'L').length}명 / 오른손 ${Object.values(hands).filter((v) => v.hand === 'R').length}명`);

// ── Tennis-MoCap: 파일 하나에 같은 스윙 여러 번. 카메라 네 방향 + 자세 인식처럼 흔들림을 넣는다 ──
const BAD = new Set(['jsgiraldo_VDerecha.bvh']);
const KIND = ['serve', 'smash', 'fh', 'fvolley', 'bh', 'bvolley'];
const rows = fs.readFileSync(path.join(arg.mocap, 'labels.csv'), 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(';'))
  .filter((r) => !BAD.has(r[0]) && fs.existsSync(path.join(arg.mocap, 'data', r[0])));
const who = (f) => f.split('_')[0].toLowerCase();
const mo = new Map();
const getMo = (f) => { if (!mo.has(f)) mo.set(f, loadBvh(path.join(arg.mocap, 'data', f))); return mo.get(f); };
// 치는 손(자료에 없다): 포핸드·서브·스매시·포핸드 발리 파일에서 더 빠른 손목으로 사람별 투표
const mvote = {};
for (const [f, , , , k] of rows) { if (!['0', '1', '2', '3'].includes(k)) continue; const fr = toFrames(getMo(f), { yaw: 90, every: 2 }); (mvote[who(f)] ||= []).push(Math.max(...wristSpeed(fr, 'R')) >= Math.max(...wristSpeed(fr, 'L')) ? 'R' : 'L'); }
const mhand = (f) => { const v = mvote[who(f)] || ['R']; return v.filter((x) => x === 'R').length >= v.length / 2 ? 'R' : 'L'; };
// 자세 인식의 흔들림 흉내: 화면 방향 1.5cm, 깊이 6cm (0.15초쯤 이어지는 느린 흔들림 + 프레임마다 작은 떨림). 가림·좌우 뒤바뀜·프레임 빠짐은 흉내 내지 않는다.
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
    const h0 = bodyScale(clean);
    const close = clean.filter((x) => G.dist(x.w[15], x.w[16]) < 0.13 * h0).length / clean.length;
    const label = kind === 'bh' ? (close > 0.35 ? 'bh2' : 'bh1') : kind;      // 백핸드 종류(자료에 없다): 두 손목이 내내 가까우면 양손
    // 앱과 같은 길로: 흔들린 자료 → 다듬기 → 스윙 찾기 → 특징
    const noisy = cleanFrames(shake(clean), 16 / 9), hn = bodyScale(noisy);
    for (const s of detectSwings(noisy, { hand, backhand: label === 'bh2' ? '2h' : '1h' })) {
      put({ src: 'mocap', who: 'M' + who(f), file: f, yaw, hp: Number(hp), label, cls: kind, rule: s.stroke, sus: !!s.suspect, x: r4(swingSequence(noisy, noisy[s.ip].t, hand, hn, s.sf, s._v)) });
      n2++;
    }
  }
}
console.error(`모션캡처: 스윙 ${n2}개(카메라 4방향, 파일 ${rows.length}개)`);
out.end();

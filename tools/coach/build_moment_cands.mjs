#!/usr/bin/env node
// '치는 순간' 학습 자료: 영상(파일)마다 손목 속도의 꼭대기를 모두 후보로 뽑아, 후보마다 특징을 적는다.
//   node tools/coach/build_moment_cands.mjs <THETIS 자세 줄 폴더> <Tennis-MoCap 폴더> out.jsonl
// THETIS: 영상 하나에 진짜 스윙은 하나(종류는 영상의 정답) — 어느 후보가 그 스윙인지는 모른다(학습에서 고른다).
// 모션캡처: 깨끗한 자료에서 엔진이 찾은 스윙 시각을 '진짜 치는 순간'으로 본다(실제로 공을 친 빠른 스윙이라 믿을 만하다).
//           그 근처(0.15초 안)의 후보는 스윙, 0.35초 넘게 떨어진 후보는 '스윙 아님'.
import fs from 'node:fs';
import path from 'node:path';
import { JS, THETIS_LABEL, listClips, loadClip, inferHands } from './thetis_util.mjs';
import { loadBvh, toFrames } from './bvh_to_poses.mjs';
import { candidates } from './moment.mjs';
const { cleanFrames } = await import(path.join(JS, 'clean.js'));
const { detectSwings, wristSpeed, bodyScale } = await import(path.join(JS, 'swing.js'));
const { swingSequence } = await import(path.join(JS, 'classify.js'));
const G = await import(path.join(JS, 'geom.js'));
const [,, thetisDir, mocapDir, outFile] = process.argv;
const out = fs.createWriteStream(outFile);
const put = (o) => out.write(JSON.stringify(o) + '\n');
const r4 = (a) => a.map((x) => Math.round(x * 1e4) / 1e4);
// ── THETIS ──
const clips = listClips(thetisDir);
const hands = inferHands(clips, thetisDir, { cleanFrames, wristSpeed, G });
let n1 = 0, k1 = 0;
for (const c of clips) {
  const fr = loadClip(c, thetisDir, { cleanFrames, G });
  if (fr.length < 20 || !hands[c.who]) continue;
  const hand = hands[c.who].hand, h = bodyScale(fr);
  if (!Number.isFinite(h)) continue;
  const v = wristSpeed(fr, hand);
  const eng = detectSwings(fr, { hand, backhand: c.cls === 'backhand2hands' ? '2h' : '1h' });
  const real = eng.filter((s) => !s.suspect);
  const pick = (real.length ? real : eng).reduce((a, b) => (!a || b.peak > a.peak ? b : a), null);
  const dur = fr[fr.length - 1].t - fr[0].t;
  k1++;
  for (const i of candidates(fr, v)) {
    put({ src: 'thetis', who: 'T' + c.who, clip: c.f.replace(/\.json$/, ''), label: THETIS_LABEL[c.cls], cls: c.cls, t: Math.round(fr[i].t * 100) / 100, dur: Math.round(dur * 100) / 100,
      v: Math.round(v[i] * 100) / 100, eng: !!pick && Math.abs(fr[pick.ip].t - fr[i].t) < 0.15, x: r4(swingSequence(fr, fr[i].t, hand, h, 1, v)) });
    n1++;
  }
}
console.error(`THETIS: 영상 ${k1}개 · 후보 ${n1}개(영상당 ${(n1 / k1).toFixed(1)}개)`);

// ── Tennis-MoCap ──
const BAD = new Set(['jsgiraldo_VDerecha.bvh']);
const KIND = ['serve', 'smash', 'fh', 'fvolley', 'bh', 'bvolley'];
const rows = fs.readFileSync(path.join(mocapDir, 'labels.csv'), 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(';')).filter((r) => !BAD.has(r[0]) && fs.existsSync(path.join(mocapDir, 'data', r[0])));
const whoM = (f) => f.split('_')[0].toLowerCase();
const mo = new Map();
const getMo = (f) => { if (!mo.has(f)) mo.set(f, loadBvh(path.join(mocapDir, 'data', f))); return mo.get(f); };
const mvote = {};
for (const [f, , , , k] of rows) { if (!['0', '1', '2', '3'].includes(k)) continue; const fr = toFrames(getMo(f), { yaw: 90, every: 2 }); (mvote[whoM(f)] ||= []).push(Math.max(...wristSpeed(fr, 'R')) >= Math.max(...wristSpeed(fr, 'L')) ? 'R' : 'L'); }
const mhand = (f) => { const v = mvote[whoM(f)] || ['R']; return v.filter((x) => x === 'R').length >= v.length / 2 ? 'R' : 'L'; };
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
let n2 = 0, p2 = 0;
for (const [f, , , , k] of rows) {
  const kind = KIND[Number(k)], hand = mhand(f);
  for (const yaw of [0, 90, 180, 270]) {
    const clean = toFrames(getMo(f), { yaw, every: 2 });
    const h0 = bodyScale(clean);
    const close = clean.filter((x) => G.dist(x.w[15], x.w[16]) < 0.13 * h0).length / clean.length;
    const label = kind === 'bh' ? (close > 0.35 ? 'bh2' : 'bh1') : kind;
    const hits = detectSwings(clean, { hand, backhand: label === 'bh2' ? '2h' : '1h' }).map((s) => clean[s.ip].t);     // 진짜 치는 순간(깨끗한 자료)
    const noisy = cleanFrames(shake(clean), 16 / 9), hn = bodyScale(noisy), v = wristSpeed(noisy, hand);
    for (const i of candidates(noisy, v)) {
      const d = Math.min(9, ...hits.map((t) => Math.abs(t - noisy[i].t)));
      const pos = d < 0.15 ? 1 : d > 0.35 ? 0 : -1;                // -1 = 애매(학습·시험에서 뺀다)
      if (pos < 0) continue;
      put({ src: 'mocap', who: 'M' + whoM(f), clip: `${f}@${yaw}`, label, cls: kind, t: Math.round(noisy[i].t * 100) / 100, v: Math.round(v[i] * 100) / 100, pos, x: r4(swingSequence(noisy, noisy[i].t, hand, hn, 1, v)) });
      n2++; p2 += pos;
    }
  }
}
console.error(`모션캡처: 후보 ${n2}개(스윙 ${p2}개 · 스윙 아님 ${n2 - p2}개)`);
out.end();

#!/usr/bin/env node
// 선수 사진에서 뽑은 자세(JSONL) → 앱이 쓰는 기준 자세 데이터(app/static/coach/data/reference.json).
// 앱과 똑같은 계산 모듈(geom·metrics)로 재므로 '선수'와 '내 영상'을 같은 자로 견주게 된다.
//
//   node tools/coach/build_reference.mjs --poses poses.jsonl --meta meta.json --out app/static/coach/data/reference.json
//        [--titles-out titles.txt]  ← 고른 표본의 파일 제목(출처를 읽어 올 목록)  [--perCell 70]
//   poses.jsonl: pose_extract.mjs 결과. meta 열 = "파일 제목 \t 스트로크 \t 분류 \t 받은 주소"
//   meta.json:   commons_meta.py 결과 { "File:...": { author, license, licenseUrl } } — 출처를 못 구한 사진은 대조군에서 뺀다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as G from '../../app/static/coach/js/geom.js';
import { poseMetrics, guessPhase } from '../../app/static/coach/js/metrics.js';
import { makeFinder, excluded } from './names.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const a = { perCell: '70', minVis: '0.55', minSize: '0.3' };
const v = process.argv.slice(2);
for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
if (!a.poses || !a.out) { console.error('usage: build_reference.mjs --poses poses.jsonl [--meta meta.json] --out reference.json'); process.exit(2); }

const players = JSON.parse(fs.readFileSync(path.join(HERE, 'players.json'), 'utf8'));
const findPlayer = makeFinder(players);

const meta = a.meta && fs.existsSync(a.meta) ? JSON.parse(fs.readFileSync(a.meta, 'utf8')) : {};
const KEYS = ['kneeHit', 'kneeOff', 'kneeAvg', 'elbowHit', 'elbowOff', 'armTrunk', 'shoulderTilt', 'trunkTilt', 'trunkLeanF', 'trunkLeanSide',
  'sep', 'wristUp', 'offWristUp', 'wristFront', 'wristSide', 'wristOverFoot', 'stance', 'reach'];
const r3 = (x) => Math.round(x * 1000) / 1000;

const rows = [];
let seen = 0, noPose = 0, small = 0, lowVis = 0, noPhase = 0, skipped = 0;
for (const line of fs.readFileSync(a.poses, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  seen++;
  const [title, stroke, , url] = (r.meta || '').split('\t');
  if (excluded(title)) { skipped++; continue; }                 // 옛 사진·어린이 사진은 기준에 넣지 않는다
  if (!r.lm || !r.lm.length) { noPose++; continue; }
  let best = 0, bh = -1;                                       // 가장 크게 나온 사람
  r.lm.forEach((p, j) => { const ys = p.map((k) => k[1]); const hh = Math.max(...ys) - Math.min(...ys); if (hh > bh) { bh = hh; best = j; } });
  if (bh < Number(a.minSize)) { small++; continue; }
  const raw = { t: 0, lm: r.lm[best], w: r.world[best] };
  if (!G.validPose(raw)) { noPose++; continue; }
  const mt0 = meta[title] || {};
  const pl = findPlayer(title) || (mt0.person ? findPlayer(mt0.person) : null);
  // 어느 손으로 치는지: 이름표에 있는 선수는 그 손으로만 본다. 모르는 선수는 오른손으로만 본다.
  // (반대 손으로 다시 맞춰 보면 '토스하는 팔'이나 '라켓을 안 든 팔'이 치는 팔로 둔갑한다.)
  let pick = null;
  for (const hand of [pl ? pl.hand : 'R']) {
    const pose = hand === 'L' ? G.mirrorPose(raw) : raw;
    const m = poseMetrics(pose, 'R');
    if (!m) continue;
    const phase = guessPhase(stroke, m);
    if (phase) { pick = { hand, pose, m, phase }; break; }
  }
  if (!pick) { noPhase++; continue; }
  // 윗몸(치는 팔·어깨·골반)이 잘 보이면 쓴다. 다리가 잘린 사진은 다리 수치만 비운다.
  const J = G.J, hitArm = pick.hand === 'L' ? [J.lWr, J.lEl] : [J.rWr, J.rEl];
  const upper = G.vis(raw, ...hitArm, J.lSh, J.rSh, J.lHip, J.rHip);
  if (upper < Number(a.minVis)) { lowVis++; continue; }
  pick.legs = G.vis(raw, J.lKnee, J.rKnee, J.lAnk, J.rAnk) >= 0.5;
  pick.m.vis = upper;
  pick.m.kneeAvg = (pick.m.kneeHit + pick.m.kneeOff) / 2;
  if (!pick.legs) for (const k of ['kneeHit', 'kneeOff', 'kneeAvg', 'stance', 'wristOverFoot']) pick.m[k] = NaN;
  rows.push({ title, stroke, url, w: r.w, h: r.h, player: pl ? pl.name : mt0.person || null, sex: pl ? pl.sex : mt0.sex || 'U', ...pick });
}

// 분포: 스트로크·순간별로 전체 / 남 / 여
const stats = {};
for (const row of rows) {
  const cell = ((stats[row.stroke] ||= {})[row.phase] ||= { _rows: [] });
  cell._rows.push(row);
}
for (const st of Object.values(stats)) {
  for (const cell of Object.values(st)) {
    for (const grp of ['all', 'M', 'F']) {
      const sub = cell._rows.filter((r) => grp === 'all' || r.sex === grp);
      if (grp !== 'all' && sub.length < 8) continue;
      cell[grp] = { n: sub.length };
      for (const k of KEYS) { const s = G.robust(sub.map((r) => r.m[k])); cell[grp][k] = { n: s.n, mean: r3(s.mean), sd: r3(s.sd), p10: r3(s.p10), p90: r3(s.p90) }; }
    }
  }
}

// 대조군 표본: 출처를 구한 사진만, 분포 한가운데에 가까운(따라 하기 쉬운) 것부터
const samples = [], pickedTitles = [];
for (const [stroke, st] of Object.entries(stats)) {
  for (const [phase, cell] of Object.entries(st)) {
    const core = ['kneeAvg', 'elbowHit', 'armTrunk', 'trunkTilt', 'wristFront', 'wristSide', 'wristUp'];
    for (const r of cell._rows) {
      const zs = core.map((k) => Math.abs(r.m[k] - cell.all[k].mean) / (cell.all[k].sd || 1)).filter(Number.isFinite);
      r.extreme = zs.reduce((s, z) => s + Math.min(z, 4), 0) / (zs.length || 1);
    }
    const usable = cell._rows.filter((r) => !a.meta || meta[r.title]);
    const kept = [];                                              // 거의 같은 자세(원본과 잘라낸 판 등 중복)는 하나만
    usable.sort((p, q) => (p.extreme - 0.6 * p.m.vis - (p.legs ? 0.3 : 0)) - (q.extreme - 0.6 * q.m.vis - (q.legs ? 0.3 : 0)));
    const perPlayer = {};
    for (const r of usable) {
      if (samples.filter((s) => s.stroke === stroke && s.phase === phase).length >= Number(a.perCell)) break;
      const feat = G.poseFeature(r.pose);
      if (kept.some((f) => G.featureDistance(f, feat, r.legs) < 0.012)) continue;
      const key = r.player || r.title;
      if ((perPlayer[key] = (perPlayer[key] || 0) + 1) > 3) continue;       // 한 선수가 대조군을 독차지하지 않게
      kept.push(feat);
      const mt = meta[r.title] || {};
      pickedTitles.push(r.title);
      const mm = {};
      for (const k of KEYS) if (Number.isFinite(r.m[k])) mm[k] = r3(r.m[k]);
      samples.push({
        id: `${stroke}-${phase}-${samples.length}`, stroke, phase, player: r.player, sex: r.sex, hand: r.hand, mirrored: r.hand === 'L',
        title: r.title.replace(/^File:/, '').replace(/_/g, ' ').replace(/\.[a-zA-Z]+$/, ''),
        page: `https://commons.wikimedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
        thumb: (r.url || '').replace(/\/\d+px-/, '/500px-'),      // 공용 페이지가 쓰는 썸네일 주소 그대로(표준 크기 500px)
        author: mt.author || null, license: mt.license || null, licenseUrl: mt.licenseUrl || null,
        ar: r3(r.w / r.h), extreme: r3(r.extreme), legs: r.legs, ...(stroke === 'backhand' ? { twoHanded: r.m.hands < 0.13 } : {}), m: mm, feat: G.poseFeature(r.pose).map(r3),
        lm: r.pose.lm.map((k) => [r3(k[0]), r3(k[1])]), w: r.pose.w.map((k) => [r3(k[0]), r3(k[1]), r3(k[2])]),
      });
    }
    delete cell._rows;
  }
}

const out = { version: 1, built: new Date().toISOString().slice(0, 10), source: 'Wikimedia Commons 사진에서 MediaPipe Pose(heavy)로 뽑은 자세', photos: seen, used: rows.length, stats, samples };
if (a['titles-out']) fs.writeFileSync(a['titles-out'], pickedTitles.join('\n') + '\n');
fs.mkdirSync(path.dirname(a.out), { recursive: true });
fs.writeFileSync(a.out, JSON.stringify(out));
const count = {};
for (const r of rows) count[`${r.stroke}/${r.phase}`] = (count[`${r.stroke}/${r.phase}`] || 0) + 1;
console.error(`사진 ${seen} · 옛 사진·어린이 ${skipped} · 사람 없음 ${noPose} · 너무 작음 ${small} · 순간 불명 ${noPhase} · 잘 안 보임 ${lowVis} → 사용 ${rows.length}`);
console.error('성별:', JSON.stringify(rows.reduce((c, r) => { c[r.sex] = (c[r.sex] || 0) + 1; return c; }, {})));
console.error('순간별:', JSON.stringify(count));
console.error(`대조군 표본 ${samples.length}개 · 이름 알아본 선수 ${new Set(rows.map((r) => r.player).filter(Boolean)).size}명 · ${(fs.statSync(a.out).size / 1024).toFixed(0)}KB → ${a.out}`);

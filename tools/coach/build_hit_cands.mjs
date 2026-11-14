#!/usr/bin/env node
// 친 순간을 사람이 표시한 영상 → '치는 순간' 학습 자료(후보마다 특징 + 스윙인지 아닌지).
//   node tools/coach/build_hit_cands.mjs <자세 줄 폴더> <친 순간 표시.json> out.jsonl [--src 이름]
// 표시 파일: { clips: [{ seq, hand, hits: [[초, 종류, 세부]], visible?: [[t0, t1]], maybe?: [초](쳤는지 확실하지 않은 순간), group? }] } (eval_hits_*.json 과 같은 모양)
// 후보(손목 속도의 꼭대기)마다: 표시한 친 순간에서 0.3초 안이면 스윙(가장 가까운 후보 하나만), 0.5초 넘게 떨어져 있고 선수가 보이는 구간이면 '스윙 아님',
// 그 사이는 애매하다(pos = -1: 학습에는 쓰지 않고, 끝까지 재는 데만 쓴다).
import fs from 'node:fs';
import path from 'node:path';
import { JS } from './thetis_util.mjs';
import { candidates } from './moment.mjs';
const { cleanFrames } = await import(path.join(JS, 'clean.js'));
const { wristSpeed, bodyScale } = await import(path.join(JS, 'swing.js'));
const { swingSequence } = await import(path.join(JS, 'classify.js'));
const G = await import(path.join(JS, 'geom.js'));

const [,, dir, labFile, outFile, ...rest] = process.argv;
if (!dir || !labFile || !outFile) { console.error('usage: build_hit_cands.mjs <seq dir> <hits.json> out.jsonl [--src name]'); process.exit(2); }
const src = rest[0] === '--src' ? rest[1] : 'hits';
const j = JSON.parse(fs.readFileSync(labFile, 'utf8'));
const clips = Array.isArray(j) ? j : j.clips;
const out = fs.createWriteStream(outFile);
const r4 = (a) => a.map((x) => Math.round(x * 1e4) / 1e4);
const NEAR = 0.3, FAR = 0.5;
const LABEL = (stroke, sub) => (stroke === 'serve' ? 'overhead' : sub === 'volley' ? (stroke === 'forehand' ? 'fvolley' : 'bvolley') : stroke);
let nPos = 0, nNeg = 0, nHit = 0, nNoCand = 0, nClip = 0;
for (const c of clips) {
  const f = path.join(dir, c.seq + '.json');
  if (!fs.existsSync(f) || c.hand === '?' || !c.hand) continue;
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const fr = cleanFrames(d.frames.filter(G.validPose), d.width / d.height);
  if (fr.length < 20) continue;
  const h = bodyScale(fr);
  if (!Number.isFinite(h)) continue;
  nClip++;
  const v = wristSpeed(fr, c.hand);
  const cand = candidates(fr, v);
  const visible = (t) => !c.visible || c.visible.some(([a, b]) => t >= a - 0.05 && t <= b + 0.05);
  // 친 순간마다 가장 가까운 후보 하나를 스윙으로
  const posOf = new Map();
  for (const [t, stroke, sub] of c.hits) {
    nHit++;
    let best = -1;
    for (const i of cand) if (Math.abs(fr[i].t - t) <= NEAR && !posOf.has(i) && (best < 0 || Math.abs(fr[i].t - t) < Math.abs(fr[best].t - t))) best = i;
    if (best < 0) { nNoCand++; continue; }
    posOf.set(best, LABEL(stroke, sub));
  }
  for (const i of cand) {
    const t = fr[i].t;
    let pos = -1, label = 'forehand';
    if (posOf.has(i)) { pos = 1; label = posOf.get(i); }
    else if (visible(t) && c.hits.every(([th]) => Math.abs(th - t) > FAR) && (c.maybe || []).every((tm) => Math.abs(tm - t) > FAR)) pos = 0;
    out.write(JSON.stringify({ src, who: c.group || c.seq, clip: c.seq, label, t: Math.round(t * 100) / 100, v: Math.round(v[i] * 100) / 100, pos, x: r4(swingSequence(fr, t, c.hand, h, 1, v)) }) + '\n');
    if (pos > 0) nPos++; else if (pos === 0) nNeg++;
  }
}
out.end();
console.error(`${src}: 영상 ${nClip}개 · 표시한 친 순간 ${nHit}개 중 후보가 있는 것 ${nHit - nNoCand}개 → 스윙 ${nPos} · 스윙 아님 ${nNeg}`);

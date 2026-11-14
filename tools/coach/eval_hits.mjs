#!/usr/bin/env node
// '치는 순간'까지 배운 모델로: 실제 공 시범 영상(친 순간을 눈으로 표시)에서 찾기 + 종류를 잰다.
//   node tools/coach/eval_hits.mjs <자세 줄 폴더> <친 순간 표시.json> <moment_model.json> [문턱 0.5] [--v]
// 친 순간 표시: tools/coach/eval_hits_commons.json (위키미디어 공용 'con pelota' 시범 영상 7개, 친 순간 30개를 프레임을 보고 표시)
import fs from 'node:fs';
import path from 'node:path';
import { detectLearned, scoreCandidates } from './moment.mjs';
import { JS } from './thetis_util.mjs';
const { cleanFrames } = await import(path.join(JS, 'clean.js'));
const G = await import(path.join(JS, 'geom.js'));
const [,, dir, labFile, modelFile, thrArg, verbose] = process.argv;
const thr = Number(thrArg || 0.5);
const labels = (() => { const j = JSON.parse(fs.readFileSync(labFile, "utf8")); return Array.isArray(j) ? j : j.clips; })();
const model = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
const TOL = 0.4;
const tot = { hits: 0, found: 0, right: 0, extra: 0, sub: 0, subOk: 0 };
const byView = {};
for (const c of labels) {
  const f = path.join(dir, c.seq + '.json');
  if (!fs.existsSync(f)) { console.log(`${c.title}: 자세 없음`); continue; }
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const fr = cleanFrames(d.frames.filter(G.validPose), d.width / d.height);
  const sw = detectLearned(fr, c.hand, model, { thr });
  const all = verbose ? scoreCandidates(fr, c.hand, model) : [];
  const used = new Set();
  let found = 0, right = 0;
  const notes = [];
  for (const [t, want, sub] of c.hits) {
    let best = -1;
    sw.forEach((x, i) => { if (!used.has(i) && Math.abs(x.t - t) <= TOL && (best < 0 || Math.abs(x.t - t) < Math.abs(sw[best].t - t))) best = i; });
    if (best < 0) {
      const near = all.filter((x) => Math.abs(x.t - t) <= TOL).sort((p, q) => q.s - p.s)[0];
      notes.push(`${t}초 놓침${near ? `(후보 ${near.t.toFixed(2)}초 스윙확률 ${near.s.toFixed(2)} ${near.stroke})` : verbose ? '(후보 없음)' : ''}`); continue;
    }
    used.add(best); found++;
    const g = sw[best];
    if (g.stroke === want) right++; else notes.push(`${t}초 ${want}→${g.stroke}(스윙확률 ${g.s.toFixed(2)})`);
    if (sub === 'volley' || (!sub && want !== 'serve')) { tot.sub++; if ((g.sub || null) === (sub || null)) tot.subOk++; else if (verbose) notes.push(`${t}초 세부 ${sub || '스트로크'}→${g.sub || '스트로크'}`); }
  }
  const extra = sw.filter((_, i) => !used.has(i));
  for (const x of extra) notes.push(`${x.t.toFixed(1)}초 없는 스윙(${x.stroke} ${x.s.toFixed(2)})`);
  tot.hits += c.hits.length; tot.found += found; tot.right += right; tot.extra += extra.length;
  const bv = (byView[c.view] ||= { hits: 0, right: 0, extra: 0 }); bv.hits += c.hits.length; bv.right += right; bv.extra += extra.length;
  console.log(`${c.title}: 친 것 ${c.hits.length}개 중 찾음 ${found} · 종류 맞음 ${right} · 없는 스윙 ${extra.length}${notes.length ? '\n    ' + notes.join(' · ') : ''}`);
}
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '—');
console.log(`\n모두(문턱 ${thr}): 친 것 ${tot.hits}개 → 찾음 ${tot.found} (${pct(tot.found, tot.hits)}) · 찾은 것 중 종류 맞음 ${tot.right} (${pct(tot.right, tot.found)}) · 없는 스윙 ${tot.extra}개 (부른 것 ${tot.found + tot.extra}개 중 ${pct(tot.extra, tot.found + tot.extra)}) · 끝까지 맞음 ${pct(tot.right, tot.hits)} · 발리/스트로크 구분 ${tot.subOk}/${tot.sub}`);
console.log('방향별: ' + Object.entries(byView).map(([k, v]) => `${k} ${v.right}/${v.hits}(없는 스윙 ${v.extra})`).join(' · '));

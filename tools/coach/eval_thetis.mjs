#!/usr/bin/env node
// THETIS(실제 영상 → 자세 인식)로 '앱이 실제로 판단하는 방식 그대로' 잰다. 영상 하나에 스윙 하나가 들어 있다.
//   node tools/coach/eval_thetis.mjs --seq <자세 줄 폴더> --folds <겹별 모델 폴더>
// 겹별 모델은 train_strokes.py --folds-out 으로 만든다: 영상마다 '그 사람을 보지 않고 배운' 모델로 판단한다(사람 단위 검증).
// 규칙만 쓴 결과와 분류기를 쓴 결과를 같은 스윙 후보에서 나란히 센다.
import fs from 'node:fs';
import path from 'node:path';
import { JS, THETIS_WANT, listClips, loadClip, inferHands } from './thetis_util.mjs';

const { cleanFrames } = await import(path.join(JS, 'clean.js'));
const { detectSwings, wristSpeed } = await import(path.join(JS, 'swing.js'));
const G = await import(path.join(JS, 'geom.js'));
const a = {};
{ const v = process.argv.slice(2); for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1]; }
if (!a.seq || !a.folds) { console.error('usage: eval_thetis.mjs --seq <dir> --folds <dir>'); process.exit(2); }

const foldOf = JSON.parse(fs.readFileSync(path.join(a.folds, 'folds.json'), 'utf8'));
const models = {};
const modelFor = (who) => { const k = foldOf['T' + who]; if (k === undefined) return null; return (models[k] ||= JSON.parse(fs.readFileSync(path.join(a.folds, `fold${k}.json`), 'utf8'))); };
const clips = listClips(a.seq);
const hands = inferHands(clips, a.seq, { cleanFrames, wristSpeed, G });
const pickOne = (all) => { const real = all.filter((s) => !s.suspect); return (real.length ? real : all).reduce((x, y) => (!x || y.peak > x.peak ? y : x), null); };

const T = {};
const tot = { n: 0, found: 0, rule: 0, model: 0, sus: 0 };
const vol = { tp: 0, fp: 0, fn: 0 }, volEx = { tp: 0, fp: 0, fn: 0 };
for (const c of clips) {
  const model = modelFor(c.who);
  if (!model || !hands[c.who]) continue;
  const fr = loadClip(c, a.seq, { cleanFrames, G }), [kind, sub] = THETIS_WANT[c.cls];
  const t = (T[c.cls] ||= { n: 0, found: 0, rule: 0, model: 0 });
  t.n++; tot.n++;
  if (fr.length < 20) continue;
  const opts = { hand: hands[c.who].hand, backhand: c.cls === 'backhand2hands' ? '2h' : '1h' };
  const r = pickOne(detectSwings(fr, opts)), m = pickOne(detectSwings(fr, { ...opts, model }));
  if (!m) { if (sub === 'volley') { vol.fn++; if (Number(c.who.slice(1)) >= 32) volEx.fn++; } continue; }
  t.found++; tot.found++;
  if (m.suspect) tot.sus++;
  if (r && r.stroke === kind) { t.rule++; tot.rule++; }
  if (m.stroke === kind) { t.model++; tot.model++; }
  for (const s of Number(c.who.slice(1)) >= 32 ? [vol, volEx] : [vol]) { if (m.sub === 'volley' && sub === 'volley') s.tp++; else if (m.sub === 'volley') s.fp++; else if (sub === 'volley') s.fn++; }
}
const pct = (x, n) => (n ? `${(100 * x / n).toFixed(1)}%` : '—');
console.log(`영상 ${tot.n}개 · 사람 ${new Set(clips.map((c) => c.who)).size}명 · 스윙을 찾은 영상 ${tot.found}개 (${pct(tot.found, tot.n)})`);
console.log('종류                  영상  스윙찾음   찾은 것 중: 규칙 맞음  분류기 맞음');
for (const cls of Object.keys(THETIS_WANT)) { const t = T[cls]; if (t) console.log(`${cls.padEnd(20)} ${String(t.n).padStart(4)}  ${pct(t.found, t.n).padStart(7)}             ${pct(t.rule, t.found).padStart(7)}     ${pct(t.model, t.found).padStart(7)}`); }
console.log(`\n포핸드/백핸드/머리 위 — 찾은 스윙 ${tot.found}개 가운데: 규칙 ${pct(tot.rule, tot.found)} → 분류기 ${pct(tot.model, tot.found)}`);
console.log(`못 찾은 영상까지 틀린 것으로 치면: 규칙 ${pct(tot.rule, tot.n)} → 분류기 ${pct(tot.model, tot.n)}`);
const line = (s) => `맞게 ${s.tp} · 잘못 ${s.fp} · 놓침 ${s.fn} (부른 것 중 맞은 비율 ${pct(s.tp, s.tp + s.fp)}, 실제 발리 중 찾은 비율 ${pct(s.tp, s.tp + s.fn)})`;
console.log(`발리로 부른 것: ${line(vol)}`);
console.log(`  그중 숙련자(p32~p55) 영상만: ${line(volEx)}`);

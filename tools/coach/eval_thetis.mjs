#!/usr/bin/env node
// THETIS(실제 영상 → 자세 인식)로 '앱이 실제로 판단하는 방식 그대로' 잰다. 영상 하나에 스윙 하나가 들어 있다.
//   node tools/coach/eval_thetis.mjs --seq <자세 줄 폴더> --folds <겹별 모델 폴더>
// 겹별 모델은 train_strokes.py --folds-out 으로 만든다: 영상마다 '그 사람을 보지 않고 배운' 모델로 판단한다(사람 단위 검증).
// 규칙만 쓴 결과와 분류기를 쓴 결과를 같은 스윙 후보에서 나란히 센다. 스윙을 못 찾은 영상은 양쪽 모두 틀린 것으로 친다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.join(HERE, '..', '..', 'app', 'static', 'coach', 'js');
const { cleanFrames } = await import(path.join(JS, 'clean.js'));
const { detectSwings } = await import(path.join(JS, 'swing.js'));
const G = await import(path.join(JS, 'geom.js'));
const a = {};
{ const v = process.argv.slice(2); for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1]; }
if (!a.seq || !a.folds) { console.error('usage: eval_thetis.mjs --seq <dir> --folds <dir>'); process.exit(2); }

const WANT = { backhand: ['backhand', null], backhand2hands: ['backhand', null], backhand_slice: ['backhand', null], backhand_volley: ['backhand', 'volley'],
  forehand_flat: ['forehand', null], forehand_openstands: ['forehand', null], forehand_slice: ['forehand', null], forehand_volley: ['forehand', 'volley'],
  flat_service: ['serve', null], kick_service: ['serve', null], slice_service: ['serve', null], smash: ['serve', 'smash'] };
const foldOf = JSON.parse(fs.readFileSync(path.join(a.folds, 'folds.json'), 'utf8'));
const models = {};
const modelFor = (who) => { const k = foldOf['T' + who]; if (k === undefined) return null; return (models[k] ||= JSON.parse(fs.readFileSync(path.join(a.folds, `fold${k}.json`), 'utf8'))); };

const clips = fs.readdirSync(a.seq).filter((f) => f.endsWith('.json')).map((f) => { const [cls, name] = f.replace(/\.json$/, '').split('__'); return { f, cls, who: name.split('_')[0] }; }).filter((c) => WANT[c.cls]);
const load = (c) => { if (!c.frames) { const d = JSON.parse(fs.readFileSync(path.join(a.seq, c.f), 'utf8')); c.frames = cleanFrames(d.frames.filter(G.validPose), d.width / d.height); } return c.frames; };
// 치는 손(영상이 거울처럼 뒤집혀 있어 자료에 없다): 한 손으로 치는 영상들에서 화면에서 더 많이 움직인 손목으로 사람별 투표
const vote = {};
for (const c of clips) {
  if (c.cls === 'backhand2hands') continue;
  const fr = load(c); if (fr.length < 10) continue;
  const mv = [0, 0];
  for (let i = 1; i < fr.length; i++) for (const [k, j] of [[0, 15], [1, 16]]) mv[k] += Math.hypot(fr[i].lm[j][0] - fr[i - 1].lm[j][0], fr[i].lm[j][1] - fr[i - 1].lm[j][1]);
  if (Math.max(...mv) > 1.25 * Math.min(...mv)) (vote[c.who] ||= []).push(mv[1] >= mv[0] ? 'R' : 'L');
}
const handOf = (w) => { const v = vote[w]; if (!v) return 'R'; return v.filter((x) => x === 'R').length >= v.length / 2 ? 'R' : 'L'; };

const pickOne = (all) => { const real = all.filter((s) => !s.suspect); return real.length ? real.reduce((x, y) => (y.peak > x.peak ? y : x)) : null; };
const T = {};
const tot = { n: 0, found: 0, rule: 0, model: 0, ruleFound: 0, modelFound: 0, skipped: 0 };
const subStat = { volley: { tp: 0, fp: 0, fn: 0 }, smash: { tp: 0, fp: 0, fn: 0 } };
for (const c of clips) {
  const model = modelFor(c.who);
  if (!model) { tot.skipped++; continue; }
  const fr = load(c), [kind, sub] = WANT[c.cls];
  const t = (T[c.cls] ||= { n: 0, found: 0, rule: 0, model: 0 });
  t.n++; tot.n++;
  if (fr.length < 10) continue;
  const opts = { hand: handOf(c.who), backhand: c.cls === 'backhand2hands' ? '2h' : '1h' };
  const r = pickOne(detectSwings(fr, opts)), m = pickOne(detectSwings(fr, { ...opts, model }));
  if (r && r.stroke === kind) { t.rule++; tot.rule++; }
  if (m && m.stroke === kind) { t.model++; tot.model++; }
  if (m) { t.found++; tot.found++; for (const k of ['volley', 'smash']) { if (m.sub === k && sub === k) subStat[k].tp++; else if (m.sub === k) subStat[k].fp++; else if (sub === k) subStat[k].fn++; } }
  else for (const k of ['volley', 'smash']) if (sub === k) subStat[k].fn++;
}
const pct = (x, n) => (n ? `${Math.round((100 * x) / n)}%` : '—');
console.log(`영상 ${tot.n}개(겹에 없는 사람의 영상 ${tot.skipped}개 제외) · 사람 ${new Set(clips.map((c) => c.who)).size}명`);
console.log('종류                  영상  스윙찾음  규칙맞음  분류기맞음');
for (const cls of Object.keys(WANT)) { const t = T[cls]; if (t) console.log(`${cls.padEnd(20)} ${String(t.n).padStart(4)}  ${pct(t.found, t.n).padStart(6)}  ${pct(t.rule, t.n).padStart(6)}  ${pct(t.model, t.n).padStart(8)}`); }
console.log(`\n스윙을 찾은 영상: ${tot.found}/${tot.n} (${pct(tot.found, tot.n)})`);
console.log(`포핸드/백핸드/서브 맞음(못 찾은 것은 틀린 것으로): 규칙 ${pct(tot.rule, tot.n)} → 분류기 ${pct(tot.model, tot.n)}`);
console.log(`찾은 스윙만 보면: 분류기 ${pct(tot.model, tot.found)}`);
for (const k of ['volley', 'smash']) { const s = subStat[k]; console.log(`${k === 'volley' ? '발리' : '스매시'}로 부른 것: 맞게 ${s.tp} · 잘못 ${s.fp} · 놓침 ${s.fn} (부른 것 중 맞은 비율 ${pct(s.tp, s.tp + s.fp)}, 실제 중 찾은 비율 ${pct(s.tp, s.tp + s.fn)})`); }

#!/usr/bin/env node
// 스트로크 구분 정확도 재기: 종류를 아는 영상(자세 줄 JSON)에 지금 엔진을 돌려, 찾은 스윙 중 몇 개를 맞게 불렀는지 센다.
//   node tools/coach/eval_strokes.mjs --seq <자세 줄 폴더> [--labels tools/coach/eval_labels.json]
// 자세 줄은 video_to_poses.mjs 로 만든다(<폴더>/<이름>.json). 라벨 파일의 각 줄: { seq, title, stroke, hand, backhand }.
// 주의: 시범 영상에는 준비 동작·되돌아오는 동작도 섞여 있어서, 이 숫자는 '찾은 스윙 가운데 영상의 종류로 부른 비율'이다
// (스윙 하나하나의 정답을 사람이 찍은 것이 아니다).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.join(HERE, '..', '..', 'app', 'static', 'coach', 'js');
const { cleanFrames } = await import(path.join(JS, 'clean.js'));
const { detectSwings } = await import(path.join(JS, 'swing.js'));
const G = await import(path.join(JS, 'geom.js'));

const a = { labels: path.join(HERE, 'eval_labels.json') };
const v = process.argv.slice(2);
for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
if (!a.seq) { console.error('usage: eval_strokes.mjs --seq <dir> [--labels file]'); process.exit(2); }

const labels = JSON.parse(fs.readFileSync(a.labels, 'utf8')).clips;
const total = {};
for (const c of labels) {
  const file = path.join(a.seq, c.seq + '.json');
  if (!fs.existsSync(file)) { console.log(`${c.title}: 자세 줄이 없어 건너뜀`); continue; }
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const frames = cleanFrames(d.frames.filter(G.validPose), d.width / d.height);
  const sw = detectSwings(frames, { hand: c.hand, backhand: c.backhand }).filter((s) => !s.suspect);
  const ok = sw.filter((s) => s.stroke === c.stroke);
  const key = c.stroke + (c.backhand && c.stroke === 'backhand' ? `(${c.backhand})` : '');
  total[key] = total[key] || { n: 0, ok: 0 };
  total[key].n += sw.length; total[key].ok += ok.length;
  const wrong = sw.filter((s) => s.stroke !== c.stroke).map((s) => `${s.tc.toFixed(1)}초→${s.stroke}`);
  console.log(`${c.title} [${key}] 찾은 스윙 ${sw.length}개 중 ${ok.length}개 맞음${wrong.length ? ' · 틀림: ' + wrong.join(', ') : ''}`);
}
console.log('── 종류별 ──');
let N = 0, OK = 0;
for (const [k, t] of Object.entries(total)) { N += t.n; OK += t.ok; console.log(`${k}: ${t.ok}/${t.n} (${t.n ? Math.round((100 * t.ok) / t.n) : 0}%)`); }
console.log(`모두: ${OK}/${N} (${N ? Math.round((100 * OK) / N) : 0}%)`);

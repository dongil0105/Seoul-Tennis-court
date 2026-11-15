#!/usr/bin/env node
// 사용자가 보낸 '진단 파일'(swing-coach-diag-*.json)을 학습·재기에 쓰는 모양으로 푼다.
//   node tools/coach/diag_ingest.mjs <진단 파일 폴더> <나갈 폴더>
// 나오는 것:
//   <나갈 폴더>/seq/<파일>__t<번호>.json   자세 줄(영상의 프레임 줄 하나). build_hit_cands.mjs · eval_hits.mjs 가 읽는 모양
//   <나갈 폴더>/hits.json                   표시 파일: 앱이 찾은 샷의 시각·종류(사용자가 바로잡았으면 바로잡은 종류 = 정답)
// 진단 파일에는 영상이 없고 관절 좌표만 있다. 짧은 영상은 영상 전체의 자세가 들어 있어서 앱이 놓친 스윙도 여기서 다시 찾을 수 있다.
// 사용자가 적은 말(note)에 '포핸드만', '서브만'처럼 영상의 종류가 적혀 있으면 영상 단위 정답으로 쓸 수 있게 hint 에 옮겨 둔다.
import fs from 'node:fs';
import path from 'node:path';
import { JS } from './thetis_util.mjs';
const { unpackFrames } = await import(path.join(JS, 'diag.js'));

const [,, inDir, outDir] = process.argv;
if (!inDir || !outDir) { console.error('usage: diag_ingest.mjs <diag dir> <out dir>'); process.exit(2); }
fs.mkdirSync(path.join(outDir, 'seq'), { recursive: true });
const HINTS = [[/포핸드\s*발리|forehand\s*volley/i, ['forehand', 'volley']], [/백핸드\s*발리|backhand\s*volley/i, ['backhand', 'volley']], [/발리|volley/i, [null, 'volley']],
  [/스매시|smash|overhead/i, ['serve', 'smash']], [/서브|serve/i, ['serve', null]], [/포핸드|forehand/i, ['forehand', null]], [/백핸드|backhand|슬라이스|slice/i, ['backhand', null]]];
const VIEWS = [[/뒤|후면|behind|back\s*view|rear/i, '뒤'], [/옆|측면|side/i, '옆'], [/정면|앞|front/i, '정면']];
const clips = [];
let nShot = 0, nFixed = 0;
for (const f of fs.readdirSync(inDir).filter((x) => x.endsWith('.json')).sort()) {
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(inDir, f), 'utf8')); } catch (e) { console.error(`${f}: 읽지 못함(${e.message})`); continue; }
  if (d.kind !== 'swing-coach-diag' || !Array.isArray(d.tracks)) { console.error(`${f}: 진단 파일이 아님`); continue; }
  const base = f.replace(/\.json$/, '');
  const note = String(d.note || '');
  const only = /만|only/i.test(note) ? (HINTS.find(([re]) => re.test(note)) || [])[1] || null : null;   // '포핸드만'처럼 한 종류뿐이라고 적었을 때
  const view = (VIEWS.find(([re]) => re.test(note)) || [])[1] || null;
  d.tracks.forEach((tr, k) => {
    const frames = unpackFrames(tr);
    const shots = (d.shots || []).filter((s) => s.track === k);
    const vid = d.videos && d.videos[(shots[0] || {}).vid ?? 0] || { width: 16, height: 9 };
    const seq = `${base}__t${k}`;
    const dt = frames.length > 1 ? (frames[frames.length - 1].t - frames[0].t) / (frames.length - 1) : 1 / 30;
    fs.writeFileSync(path.join(outDir, 'seq', seq + '.json'), JSON.stringify({ video: seq, width: vid.width, height: vid.height, fps: Math.round(1 / dt), cleaned: true, frames }));
    const hits = shots.filter((s) => !s.suspect && s.stroke).map((s) => {
      const t = Number.isFinite(s.tc) ? s.tc : (frames[s.ip] || frames[0]).t;
      nShot++; if (s.fixed) nFixed++;
      return [Math.round(t * 100) / 100, s.stroke, null, s.twoHanded ? 2 : null, false, s.fixed ? 3 : 2];     // 확신: 사용자가 바로잡은 것 3, 앱이 부른 그대로 2
    });
    clips.push({ seq, title: `${base} · ${note.slice(0, 60)}`, hand: (d.profile || {}).hand || 'R', backhand: (d.profile || {}).backhand || '2h', view, group: base,
      only, note, auto: shots.map((s) => [s.auto, s.stroke, !!s.fixed, s.by || null]), hits });
  });
  console.log(`${f}: 프레임 줄 ${d.tracks.length}개 · 샷 ${(d.shots || []).length}개(바로잡은 것 ${(d.shots || []).filter((s) => s.fixed).length}) · 적은 말: ${note.slice(0, 50) || '없음'}${only ? ' → 영상 종류 ' + only.filter(Boolean).join(' ') : ''}${view ? ' · 방향 ' + view : ''}`);
}
fs.writeFileSync(path.join(outDir, 'hits.json'), JSON.stringify({ note: '진단 파일에서 푼 것. hits 의 종류는 앱이 부른 것(사용자가 바로잡았으면 바로잡은 것). 앱이 놓친 스윙은 들어 있지 않다.', clips }, null, 1));
console.log(`모두: 프레임 줄 ${clips.length}개 · 샷 ${nShot}개(사용자가 바로잡은 것 ${nFixed}) → ${path.join(outDir, 'hits.json')}`);

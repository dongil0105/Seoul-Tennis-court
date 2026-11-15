#!/usr/bin/env node
// '화면 보고 학습'에서 가져온 묶음(learn_pull.py 가 받은 폴더)을 학습·재기에 쓰는 모양으로 푼다.
//   node tools/coach/watch_ingest.mjs <받은 폴더> <나갈 폴더>
// 나오는 것:
//   <나갈 폴더>/cands.jsonl      후보마다 한 줄(특징 660개 + 정답으로 쓸지). train_moment.py --extra 가 읽는다
//   <나갈 폴더>/seq/<보기>.json   자세 줄 전체를 보낸 구간(처음 10분 등) — eval_hits.mjs 가 읽는 모양
//   <나갈 폴더>/hits.json         보면서 누른 표시(F·B·S·V·M)가 있는 보기의 정답 표시
// 정답을 정하는 법(확실한 순서):
//   ① 보면서 누른 표시가 있으면: 누른 때보다 조금 앞(반응 시간)의 후보가 그 종류의 스윙, 표시에서 먼 후보는 '스윙 아님'           → gold
//   ② '○○만 나오는 영상'이라고 골랐으면: 모델이 스윙이라고 본 후보는 그 종류로, 스윙이 아니라고 본 후보는 '스윙 아님'으로       → weak
//   ③ 아무 표시도 없으면: 모델이 아주 확신한 것만(스윙 0.9 이상·종류 0.9 이상 / 스윙 아님 0.97 이상) 모델이 부른 대로            → pseudo
//   그 사이의 애매한 후보는 학습에 쓰지 않는다(pos = -1).
// '○○만'은 묶음마다 다를 수 있다(영상마다 바꿔 가며 볼 때). 그리고 '포핸드만'이라는데 모델이 대부분 백핸드 쪽으로 보면
// 치는 손을 반대로 골랐거나(왼손잡이) 설정이 영상과 안 맞는 것이므로, 그 구간의 스윙은 학습에 쓰지 않고 알려 준다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { JS } from './thetis_util.mjs';
const { joinChunks } = await import(path.join(JS, 'watchcore.js'));
const { pickSwings } = await import(path.join(JS, 'moment.js'));

const [,, inDir, outDir] = process.argv;
if (!inDir || !outDir) { console.error('usage: watch_ingest.mjs <pulled dir> <out dir>'); process.exit(2); }
fs.mkdirSync(path.join(outDir, 'seq'), { recursive: true });
const bySession = new Map();
for (const f of fs.readdirSync(inDir).filter((x) => x.endsWith('.json') || x.endsWith('.json.gz')).sort()) {     // .json.gz = '파일로도 저장'한 조각(메일로 받은 것)
  let c;
  try { const raw = fs.readFileSync(path.join(inDir, f)); c = JSON.parse((raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw).toString('utf8')); } catch (e) { console.error(`${f}: 읽지 못함(${e.message})`); continue; }
  for (const one of Array.isArray(c) ? c : [c]) {            // '파일로도 저장'한 것은 묶음들의 배열이다
    if (!one || one.kind !== 'swing-coach-watch') continue;
    if (!bySession.has(one.session)) bySession.set(one.session, new Map());
    bySession.get(one.session).set(one.seq, one);            // 같은 묶음이 두 번 와도 한 번만
  }
}
const FAMILY = { forehand: ['forehand', 'fvolley'], backhand: ['backhand', 'bvolley'], serve: ['overhead'], smash: ['overhead'], volley: ['fvolley', 'bvolley'] };
const KIND = { forehand: 'forehand', fvolley: 'forehand', backhand: 'backhand', bvolley: 'backhand', overhead: 'serve' };
const REACT = 0.3;                                           // 보고 누르기까지 걸리는 시간(초)
const r4 = (a) => a.map((x) => Math.round(x * 1e4) / 1e4);
const out = fs.createWriteStream(path.join(outDir, 'cands.jsonl'));
const hits = [];
const tot = { sessions: 0, sec: 0, cands: 0, gold: 0, weak: 0, pseudo: 0, neg: 0 };
const warn = [];
for (const [session, map] of bySession) {
  const J = joinChunks([...map.values()]);
  const meta = J.meta || {}, hand = (J.profile || {}).hand || 'R';
  const scored = J.cands.map((c) => {
    const pf = c.P.forehand + c.P.fvolley, pb = c.P.backhand + c.P.bvolley, po = c.P.overhead, s = 1 - c.P.none, top = Math.max(pf, pb, po);
    const best = Object.entries(c.P).filter(([k]) => k !== 'none').sort((a, b) => b[1] - a[1])[0];
    return { ...c, s, conf: s > 0 ? top / s : 0, cls: best[0], stroke: po === top ? 'serve' : pf === top ? 'forehand' : 'backhand' };
  });
  const sec = scored.length ? scored[scored.length - 1].t - scored[0].t : 0;
  const mode = J.taps.length ? 'gold' : scored.some((c) => c.only) ? 'weak' : 'pseudo';
  const count = { forehand: 0, backhand: 0, serve: 0 };
  for (const s of pickSwings(scored)) count[s.stroke]++;
  const used = new Set();
  if (mode === 'gold') {                                     // 표시마다 가장 그럴듯한 후보 하나
    for (const tap of J.taps) {
      const near = scored.filter((c) => !used.has(c) && Math.abs(c.t - (tap.t - REACT)) <= 0.7).sort((a, b) => b.s - a.s)[0];
      if (!near) continue;
      used.add(near);
      const fam = FAMILY[tap.k] || [near.cls];
      near.pos = 1; near.label = tap.k === 'volley' ? (near.P.fvolley + near.P.forehand >= near.P.bvolley + near.P.backhand ? 'fvolley' : 'bvolley') : fam[0];
    }
  }
  // '○○만' 구간이 영상과 맞는지: 모델이 스윙이라고 본 것 가운데 그 종류 쪽이 아닌 것이 60% 넘으면 믿지 않는다
  const distrust = new Set();
  if (mode !== 'gold') {
    for (const only of new Set(scored.map((c) => c.only).filter(Boolean))) {
      const fam = FAMILY[only] || [];
      const sw = scored.filter((c) => c.only === only && c.s >= 0.5);
      const off = sw.filter((c) => !fam.includes(c.cls) && !(only === 'volley')).length;
      if (fam.length && sw.length >= 6 && off / sw.length > 0.6) { distrust.add(only); warn.push(`${session}: '${only}만'이라는데 스윙 ${sw.length}개 중 ${off}개를 다른 종류로 봄 → 이 구간의 스윙은 학습에서 뺌(치는 손이 반대이거나 설정이 영상과 안 맞음)`); }
    }
  }
  for (const c of scored) {
    let how = mode;
    if (c.pos === 1) { tot.gold++; }
    else if (mode === 'gold') { c.pos = J.taps.every((x) => Math.abs(c.t - (x.t - REACT)) > 1.0) ? 0 : -1; }
    else if (c.only) {
      how = 'weak';
      const fam = FAMILY[c.only] || [];
      if (distrust.has(c.only)) c.pos = c.s <= 0.03 ? 0 : -1;
      else if (c.s >= 0.5 && fam.length) { c.pos = 1; c.label = fam.length === 1 ? fam[0] : [...fam].sort((a, b) => c.P[b] - c.P[a])[0]; tot.weak++; }
      else c.pos = c.s <= 0.1 ? 0 : -1;
    } else if (c.s >= 0.9 && c.conf >= 0.9) { how = 'pseudo'; c.pos = 1; c.label = c.cls; tot.pseudo++; }
    else { how = 'pseudo'; c.pos = c.s <= 0.03 ? 0 : -1; }
    if (c.pos === 0) tot.neg++;
    out.write(JSON.stringify({ src: 'watch', who: session, clip: session, mode: how, only: c.only || null, device: meta.device || null, label: c.label || 'forehand', t: c.t, v: c.v, pos: c.pos, s: Math.round(c.s * 1000) / 1000, x: r4(c.x) }) + '\n');
  }
  if (J.frames.length > 30) {
    fs.writeFileSync(path.join(outDir, 'seq', session + '.json'), JSON.stringify({ video: session, width: meta.width || 16, height: meta.height || 9, fps: Math.round(meta.fps || 30), cleaned: false, frames: J.frames }));
    if (mode === 'gold') {
      const t1 = J.frames[J.frames.length - 1].t;
      hits.push({ seq: session, title: `${session} · ${String(meta.note || '').slice(0, 50)}`, hand, backhand: (J.profile || {}).backhand || '2h', view: meta.view, group: session, visible: [[J.frames[0].t, t1]],
        hits: J.taps.filter((x) => x.t - REACT <= t1).map((x) => [Math.round((x.t - REACT) * 100) / 100, x.k === 'volley' ? 'forehand' : x.k === 'smash' ? 'serve' : x.k, x.k === 'volley' || x.k === 'smash' ? x.k : null]) });
    }
  }
  tot.sessions++; tot.sec += sec; tot.cands += scored.length;
  const onlys = [...new Set(scored.map((c) => c.only).filter(Boolean))];
  console.log(`${session} [${mode}${onlys.length ? ' ' + onlys.map((o) => o + '만').join('·') : ''}]${meta.device ? ' ' + meta.device : ''} ${Math.round(sec / 60)}분 · 초당 ${meta.fps || '?'}장 · 선수 찾음 ${meta.found ?? '?'} · 후보 ${scored.length} · 스윙 포핸드 ${count.forehand} 백핸드 ${count.backhand} 서브 ${count.serve} · 표시 ${J.taps.length} · 자세 줄 ${J.frames.length}프레임 · ${String(meta.note || '').slice(0, 40)}`);
}
out.end();
fs.writeFileSync(path.join(outDir, 'hits.json'), JSON.stringify({ note: '화면 보고 학습에서 보면서 누른 표시. 시각은 누른 때에서 반응 시간 0.3초를 뺀 것(±0.4초로 견준다).', clips: hits }, null, 1));
for (const w of warn) console.log('주의: ' + w);
console.log(`모두: 보기 ${tot.sessions}번 · ${Math.round(tot.sec / 60)}분 · 후보 ${tot.cands}개 → 스윙으로 쓸 것: 표시한 것 ${tot.gold} · '○○만' ${tot.weak} · 모델이 확신한 것 ${tot.pseudo} · 스윙 아님 ${tot.neg}`);

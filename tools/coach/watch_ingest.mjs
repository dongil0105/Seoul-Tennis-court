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
// '○○만'은 영상 묶음에 붙인 표시라 5분 단위로 모델의 판단과 견줘 믿을지 정한다(아래). 초당 12장보다 느리게 뽑힌 묶음은 쓰지 않는다.
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
const tot = { sessions: 0, sec: 0, cands: 0, gold: 0, weak: 0, fixed: 0, pseudo: 0, neg: 0, slow: 0 };
const MIN_FPS = 12;                                          // 이보다 느리게 뽑힌 묶음은 학습에 쓰지 않는다
const seg = {};
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
  // '○○만'은 영상 묶음에 붙인 표시라 영상마다 맞는 정도가 다르다(설명하는 영상, 왼손잡이, 코치가 공을 던져 주는 장면 …).
  // 그래서 5분 단위로 '모델이 스윙이라고 본 것 가운데 그 종류로 부른 비율'을 보고 나눈다:
  //   85% 이상 → 믿는 구간: 스윙을 모두 그 종류로(모델이 틀린 15%를 바로잡는다)   15% 이하 → 반대로 보는 구간(손이 반대 등): 쓰지 않는다
  //   그 사이 → 섞인 구간: 모델도 그 종류라고 아주 확신한 것만 쓴다
  const WIN = 300, trust = new Map();
  if (mode !== 'gold') {
    const bins = new Map();
    for (const c of scored) {
      if (!c.only || c.s < 0.5) continue;
      const key = `${c.only}:${Math.floor(c.t / WIN)}`, fam = FAMILY[c.only] || [];
      const b = bins.get(key) || { n: 0, ok: 0 }; b.n++; if (fam.includes(c.cls)) b.ok++; bins.set(key, b);
    }
    for (const [key, b] of bins) { const a = b.ok / b.n; trust.set(key, b.n >= 5 && a >= 0.85 ? 'yes' : b.n >= 5 && a <= 0.15 ? 'opposite' : 'mixed'); seg[trust.get(key)] = (seg[trust.get(key)] || 0) + b.n; }
  }
  for (const c of scored) {
    let how = mode;
    if (c.fps && c.fps < MIN_FPS) { c.pos = -1; tot.slow++; how = 'slow'; }           // 초당 장수가 모자란 묶음은 움직임이 뭉개져 쓰지 않는다
    else if (c.pos === 1) { tot.gold++; }
    else if (mode === 'gold') { c.pos = J.taps.every((x) => Math.abs(c.t - (x.t - REACT)) > 1.0) ? 0 : -1; }
    else if (c.only) {
      how = 'weak';
      const fam = FAMILY[c.only] || [], tr = trust.get(`${c.only}:${Math.floor(c.t / WIN)}`) || 'mixed';
      if (c.s <= 0.03) c.pos = 0;
      else if (c.s < 0.5 || !fam.length || tr === 'opposite') c.pos = -1;
      else if (tr === 'yes') { c.pos = 1; c.label = fam.includes(c.cls) ? c.cls : fam.length === 1 ? fam[0] : [...fam].sort((a, b) => c.P[b] - c.P[a])[0]; tot.weak++; if (!fam.includes(c.cls)) tot.fixed++; }
      else if (fam.includes(c.cls) && c.s >= 0.9 && c.conf >= 0.9) { c.pos = 1; c.label = c.cls; tot.pseudo++; how = 'pseudo'; }
      else c.pos = -1;
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
console.log(`'○○만' 구간의 스윙(5분 단위로 나눠): 믿는 구간 ${seg.yes || 0} · 섞인 구간 ${seg.mixed || 0} · 반대로 보는 구간 ${seg.opposite || 0}`);
console.log(`모두: 보기 ${tot.sessions}번 · ${Math.round(tot.sec / 60)}분 · 후보 ${tot.cands}개 → 스윙으로 쓸 것: 표시한 것 ${tot.gold} · '○○만' 믿는 구간 ${tot.weak}(그중 모델과 달라 바로잡은 것 ${tot.fixed}) · 모델이 확신한 것 ${tot.pseudo} · 스윙 아님 ${tot.neg} · 느려서 뺀 후보 ${tot.slow}`);

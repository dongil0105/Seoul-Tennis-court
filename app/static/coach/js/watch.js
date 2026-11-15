// 스윙 코치 — 화면 보고 학습. 컴퓨터 브라우저에서 다른 탭(유튜브 등)을 '화면 공유'로 받아, 재생되는 영상에서 관절 좌표를 뽑는다.
// 영상은 저장하지도 보내지도 않는다. 2분쯤마다 '스윙 후보의 움직임 특징'을 묶어 내 서버의 중계함(/coach/learn)으로 보내고,
// 같은 묶음을 이 브라우저 안에도 보관한다(서버가 비워지면 다시 보낸다). 학습은 그 묶음을 가져가는 쪽에서 한다.
import * as G from './geom.js';
import { getPose, detect, usedDelegate } from './pose.js';
import { cleanFrames } from './clean.js';
import { scoreCandidates, pickSwings, validMomentModel } from './moment.js';
import * as Draw from './draw.js';
import { CHUNK_SEC, OVERLAP, TAIL, DETAIL_SEC, TAP_KEYS, personBox, pickPerson, follow, needZoom, zoomRect, toFull, buildChunk, metaHeader } from './watchcore.js';

const $ = (s) => document.querySelector(s);
const video = $('#view'), overlay = $('#overlay'), octx = overlay.getContext('2d');
const crop = document.createElement('canvas'); crop.width = crop.height = 512;
const cctx = crop.getContext('2d', { willReadFrequently: false });
const NAME = { forehand: '포핸드', backhand: '백핸드', serve: '서브·스매시', volley: '발리', smash: '스매시' };

const S = {
  stream: null, running: false, model: null, pl2: null, pl1: null, busy: false,
  target: null, lost: 0, frames: [], taps: [], t0: 0, chunkStart: 0, lastCand: -1, session: '', seq: 0,
  n: 0, found: 0, zoom: 0, fpsT: 0, fpsN: 0, fps: 0, shots: [], counts: {}, sent: 0, pulled: 0, local: 0, err: '',
};

// ── 설정 ──
const q = new URLSearchParams(location.search);
const CHUNK = Math.max(8, Number(q.get('chunk')) || CHUNK_SEC);      // 묶음 길이(초). 시험할 때만 주소로 줄인다
for (const id of ['hand', 'backhand', 'dir', 'level', 'only']) { const v = q.get(id); if (v && [...$('#' + id).options].some((o) => o.value === v)) $('#' + id).value = v; }
if (q.get('note')) $('#note').value = q.get('note').slice(0, 300);
const settings = () => ({ profile: { hand: $('#hand').value, backhand: $('#backhand').value },
  meta: { note: $('#note').value, view: $('#dir').value || null, level: $('#level').value || null, only: $('#only').value || null } });

// ── 브라우저 안 보관(IndexedDB) ──
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const rq = indexedDB.open('coach-watch', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('chunks', { keyPath: 'id' });
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
  return dbp;
}
const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('chunks', mode); const out = fn(t.objectStore('chunks')); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); }); };
const idbPut = (rec) => tx('readwrite', (st) => st.put(rec));
const idbAll = () => tx('readonly', (st) => st.getAll());

async function gzip(text) {
  if (typeof CompressionStream !== 'function') return new Blob([text], { type: 'application/json' });
  const st = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(st).arrayBuffer()], { type: 'application/gzip' });
}

let syncing = false;
/** 보관한 묶음을 서버와 맞춘다: 아직 안 보낸 것은 보내고, 서버에서 사라진 것(서버가 다시 켜짐)은 다시 보내고, 가져갔다고 표시된 것은 내용을 비운다 */
async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    const recs = await idbAll();
    let on = null, acked = null;
    try {
      const r = await fetch('/coach/learn', { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 403) { S.err = '이 브라우저에 열쇠가 없어 보낼 수 없어요. 잠금 해제 링크를 먼저 열어 주세요.'; return; }
      if (r.ok) { const j = await r.json(); on = new Set(j.items.map((m) => m.id)); acked = new Set(j.acked || []); }
    } catch (_) { /* 서버에 닿지 않으면 다음에 다시 */ }
    if (on) {
      for (const rec of recs) {
        if (rec.state === 'sent' && acked.has(rec.serverId)) { rec.state = 'pulled'; rec.blob = null; await idbPut(rec); }
        else if (rec.state === 'sent' && !on.has(rec.serverId)) { rec.state = 'local'; await idbPut(rec); }
      }
      for (const rec of recs.filter((x) => x.state === 'local' && x.blob).sort((a, b) => (a.at < b.at ? -1 : 1))) {
        try {
          const r = await fetch('/coach/learn', { method: 'POST', credentials: 'same-origin', body: rec.blob, headers: { 'Content-Type': rec.blob.type || 'application/gzip', 'X-Coach-Meta': rec.head } });
          if (!r.ok) { S.err = r.status === 413 ? '묶음이 너무 커서 보내지 못했어요.' : `보내기 실패(${r.status})`; if (r.status === 413) { rec.state = 'toobig'; await idbPut(rec); } continue; }
          rec.state = 'sent'; rec.serverId = (await r.json()).id; await idbPut(rec); S.err = '';
        } catch (_) { S.err = '서버에 닿지 않아요. 연결되면 다시 보냅니다.'; break; }
      }
    }
    const all = await idbAll();
    S.sent = all.filter((x) => x.state === 'sent').length; S.pulled = all.filter((x) => x.state === 'pulled').length; S.local = all.filter((x) => x.state === 'local').length;
  } finally { syncing = false; render(); }
}

// ── 영상 받기 ──
async function pick() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { say('이 브라우저는 화면 공유를 못 해요. 컴퓨터의 크롬·엣지·어사이드에서 열어 주세요.'); return; }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
    if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
    S.stream = stream; video.srcObject = stream;
    await video.play();
    stream.getVideoTracks()[0].addEventListener('ended', () => stop('공유가 끝났어요.'));
    say('영상이 보이면 "학습 시작"을 누르세요. 여러 사람이 나오면 볼 선수를 화면에서 한 번 눌러 주세요.');
    $('#start').disabled = false;
    if (!S.model) loadEngine();
    loop();
    if (q.get('auto') === '1') start();
  } catch (e) { say(e && e.name === 'NotAllowedError' ? '공유를 취소했어요. 다시 눌러 유튜브가 열린 탭을 골라 주세요.' : '화면을 받지 못했어요: ' + (e && e.message || e)); }
  render();
}

async function loadEngine() {
  try {
    const m = await (await fetch('/static/coach/data/moment_model.json?v=1', { cache: 'force-cache' })).json();
    if (validMomentModel(m)) S.model = m; else say('학습 모델 파일이 맞지 않아요.');
  } catch (_) { say('학습 모델을 받지 못했어요. 새로 고침해 주세요.'); }
  try {
    S.pl2 = await getPose({ model: 'full', poses: 2, probe: video });
    S.pl1 = await getPose({ model: 'full', poses: 1 });
  } catch (e) { say('자세 인식을 켜지 못했어요: ' + (e && e.message || e)); }
  render();
}

function start() {
  if (!S.stream || S.running) return;
  S.running = true; S.session = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); S.seq = 0;
  S.t0 = performance.now() / 1000; S.chunkStart = 0; S.lastCand = -1; S.frames = []; S.taps = []; S.shots = []; S.counts = {}; S.n = S.found = S.zoom = 0;
  say('보고 있어요. 이 화면을 보이는 채로 두세요(다른 탭으로 옮기면 느려집니다). 영상은 1배속으로 틀어 주세요.');
  render();
}

async function stop(msg) {
  if (S.running) { S.running = false; await flush(true); }
  if (S.stream) { S.stream.getTracks().forEach((t) => t.stop()); S.stream = null; video.srcObject = null; }
  $('#start').disabled = true;
  say((msg || '끝냈어요.') + ' 보낸 묶음은 아래에서 확인할 수 있어요.');
  render(); sync();
}

// ── 프레임마다 ──
// 화면 갱신 콜백(requestVideoFrameCallback·타이머)은 탭이나 창이 가려지면 거의 멈춘다. 그래서 작업자(Worker)의 타이머로 깨우고,
// 영상에 새 프레임이 들어왔을 때만 자세를 뽑는다(같은 프레임을 두 번 세면 속도 계산이 틀어진다).
let ticker = null, lastFrame = -1, nextAt = 0;
function loop() {
  if (ticker || !S.stream) return;
  ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),16)'], { type: 'text/javascript' })));
  ticker.onmessage = () => {
    if (!S.stream) { ticker.terminate(); ticker = null; return; }
    if (S.busy || performance.now() < nextAt) return;
    const q2 = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality().totalVideoFrames : -2;
    if (q2 === lastFrame) return;
    lastFrame = q2;
    const a = performance.now();
    step();
    nextAt = performance.now() + Math.max(6, 0.4 * (performance.now() - a));     // 화면이 굳지 않게 숨 돌릴 틈을 둔다(느린 컴퓨터)
  };
}
document.addEventListener('visibilitychange', render);

function step() {
  const W = video.videoWidth, H = video.videoHeight;
  if (!S.stream || !W || !H || !S.pl2 || S.busy) return;
  S.busy = true;
  const began = performance.now();
  try {
    const t = began / 1000 - S.t0;
    let person = null, rect = null;
    if (needZoom(S.target) && S.lost < 8 && S.pl1) {           // 멀리 작게 찍힌 선수: 그 둘레만 잘라 크게 보고 자세를 뽑는다
      rect = zoomRect(S.target, W, H);
      cctx.drawImage(video, rect.x, rect.y, rect.s, rect.s, 0, 0, crop.width, crop.height);
      const ps = detect(S.pl1, crop);
      if (ps.length) person = { lm: toFull(ps[0].lm, rect, W, H), w: ps[0].w };
      else rect = null;
    }
    if (!person) {
      const ps = detect(S.pl2, video);
      if (S.lost > 90) S.target = null;                        // 3초 넘게 놓쳤으면 가장 크게 나온 사람부터 다시
      const k = pickPerson(ps.map((p) => personBox(p.lm)), S.target);
      if (k >= 0) person = ps[k];
    }
    if (person) { S.target = follow(S.target, personBox(person.lm)); S.lost = 0; } else S.lost++;
    if (S.running) {
      S.n++; if (person) { S.found++; if (rect) S.zoom++; S.frames.push({ t, lm: person.lm, w: person.w }); }
      if (t - S.chunkStart >= CHUNK) flush(false);
    }
    S.fpsN++; const now = performance.now();
    if (now - S.fpsT > 1000) { S.fps = Math.round((S.fpsN * 1000) / (now - S.fpsT)); S.fpsT = now; S.fpsN = 0; render(); }
    paint(person, rect, W, H);
  } catch (e) { S.err = '자세 인식 오류: ' + (e && e.message || e); }
  S.stepMs = 0.8 * (S.stepMs || 0) + 0.2 * (performance.now() - began);
  S.busy = false;
}

function paint(person, rect, W, H) {
  if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; }
  octx.clearRect(0, 0, W, H);
  if (rect) { octx.strokeStyle = 'rgba(215,242,75,.7)'; octx.lineWidth = Math.max(2, W / 480); octx.strokeRect(rect.x, rect.y, rect.s, rect.s); }
  if (person) Draw.skeleton(octx, person.lm, W, H, { hand: $('#hand').value, width: Math.max(2, W / 400) });
}

// 볼 선수 고르기: 화면을 누른 자리에서 가장 가까운 사람
overlay.addEventListener('click', (e) => {
  const b = overlay.getBoundingClientRect();
  S.target = { cx: (e.clientX - b.left) / b.width, cy: (e.clientY - b.top) / b.height, h: 0.5 }; S.lost = 99;
  say('누른 자리의 선수를 따라갑니다.');
});

// 보면서 표시하기(하고 싶을 때만): F 포핸드 · B 백핸드 · S 서브 · V 발리 · M 스매시
document.addEventListener('keydown', (e) => {
  if (!S.running || e.target.matches('input, textarea, select') || e.repeat) return;
  const k = TAP_KEYS[e.code];
  if (!k) return;
  S.taps.push({ t: performance.now() / 1000 - S.t0, k });
  $('#tap').textContent = `표시: ${NAME[k]}`; clearTimeout(tapTimer); tapTimer = setTimeout(() => { $('#tap').textContent = ''; }, 900);
});
let tapTimer = 0;

// ── 묶음 만들어 보내기 ──
async function flush(final) {
  const frames = S.frames, tEnd = frames.length ? frames[frames.length - 1].t : S.chunkStart;
  const { profile, meta } = settings();
  const taps = S.taps; S.taps = [];
  S.frames = final ? [] : frames.filter((f) => f.t >= tEnd - OVERLAP);   // 다음 묶음은 마지막 2초부터 이어서
  S.chunkStart = tEnd;
  const valid = frames.filter(G.validPose);
  if (valid.length < 30) return;
  const W = video.videoWidth || 16, H = video.videoHeight || 9;
  let cands = [];
  if (S.model) {
    try {
      const clean = cleanFrames(valid, W / H);
      cands = scoreCandidates(clean, profile.hand, S.model, { keepX: true })
        .filter((c) => c.t > S.lastCand + 0.05 && (final || c.t <= tEnd - TAIL));     // 앞 묶음에서 이미 다룬 것·아직 뒤쪽 동작이 없는 것은 뺀다
    } catch (e) { S.err = '스윙 찾기 오류: ' + (e && e.message || e); }
  }
  if (cands.length) S.lastCand = cands[cands.length - 1].t;
  const shots = pickSwings(cands);
  for (const s of shots) { const name = s.sub === 'volley' ? '발리' : NAME[s.stroke]; S.counts[name] = (S.counts[name] || 0) + 1; S.shots.push({ t: s.t, name, s: s.s }); }
  S.shots = S.shots.slice(-12);
  const chunk = buildChunk({ session: S.session, seq: S.seq++, profile, final, frames: valid, cands, shots, taps,
    meta: { ...meta, width: W, height: H, zoomed: S.found ? S.zoom / S.found : 0, found: S.n ? S.found / S.n : 0 }, detail: tEnd <= DETAIL_SEC || $('#detail').checked });
  try {
    const blob = await gzip(JSON.stringify(chunk));
    await idbPut({ id: `${chunk.session}-${chunk.seq}`, at: chunk.made, state: 'local', head: metaHeader(chunk), blob, serverId: null });
  } catch (e) { S.err = '브라우저 안에 보관하지 못했어요: ' + (e && e.message || e); }
  render(); sync();
}

// ── 화면 ──
let line = '';
function say(t) { line = t; render(); }
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function render() {
  $('#msg').textContent = line;
  $('#err').textContent = S.err;
  $('#pick').textContent = S.stream ? '다른 탭으로 바꾸기' : '① 볼 탭 고르기 (유튜브가 열린 탭)';
  $('#start').hidden = S.running; $('#stop').hidden = !S.stream;
  const el = S.running ? performance.now() / 1000 - S.t0 : 0;
  $('#stat').textContent = S.stream
    ? `${S.running ? '보는 중 ' + mmss(el) : '대기'} · 초당 ${S.fps}장${S.fps && S.fps < 15 ? ' (느려요 — 다른 프로그램을 닫아 주세요)' : ''} · 선수 찾은 비율 ${S.n ? Math.round((100 * S.found) / S.n) : 0}%${S.zoom ? ' · 확대해서 봄 ' + Math.round((100 * S.zoom) / Math.max(1, S.found)) + '%' : ''}${usedDelegate() ? ' · ' + usedDelegate() : ''}${document.hidden ? ' · (탭이 가려져 느리게 도는 중)' : ''}`
    : '아직 고른 탭이 없어요.';
  $('#tally').textContent = Object.keys(S.counts).length ? '찾은 스윙: ' + Object.entries(S.counts).map(([k, v]) => `${k} ${v}`).join(' · ') : '';
  $('#shots').innerHTML = S.shots.slice().reverse().map((s) => `<li>${mmss(s.t)} · ${s.name} <span>${Math.round(s.s * 100)}%</span></li>`).join('');
  $('#box').textContent = `묶음: 서버에 맡긴 것 ${S.sent} · 학습 쪽이 가져간 것 ${S.pulled} · 아직 못 보낸 것 ${S.local}`;
}

$('#pick').addEventListener('click', pick);
$('#start').addEventListener('click', start);
$('#stop').addEventListener('click', () => stop());
$('#resend').addEventListener('click', () => { say('보관한 묶음을 다시 맞춰 보냅니다.'); sync(); });
$('#save').addEventListener('click', async () => {
  const recs = (await idbAll()).filter((x) => x.blob);
  if (!recs.length) { say('보관한 묶음이 없어요.'); return; }
  const parts = [];
  for (const rec of recs) {
    const st = rec.blob.type === 'application/gzip' && typeof DecompressionStream === 'function' ? rec.blob.stream().pipeThrough(new DecompressionStream('gzip')) : rec.blob.stream();
    parts.push(await new Response(st).text());
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['[' + parts.join(',') + ']'], { type: 'application/json' }));
  a.download = `swing-coach-watch-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
window.addEventListener('beforeunload', (e) => { if (S.running) { e.preventDefault(); e.returnValue = ''; } });
setInterval(sync, 60000);
render(); sync();
window.__watch = S;                                            // 시험에서 상태를 들여다볼 때

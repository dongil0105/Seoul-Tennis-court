// 스윙 코치 — 화면 흐름: 영상 고르기(여러 개 가능) → 사람 찾기(여러 명이면 한 명 고르기) → 스윙 찾기 → 종합 판단 → 샷별 결과·선수 대조군·조언 → 공유.
// 영상은 기기 안에서만 다룬다. 서버로 보내는 것은 없다.
import * as Pose from './pose.js';
import * as Track from './track.js';
import * as Draw from './draw.js';
import * as G from './geom.js';
import { cleanFrames } from './clean.js';
import { detectSwings, mainSwing, withContact, withStroke, wristSpeed } from './swing.js';
import { swingMetrics } from './metrics.js';
import { advise, matchReference } from './advice.js';
import * as Reach from './reach.js';
import { summarize, countText, spreadText, baseTitle, dropServePrep } from './summary.js';
import { serveHeightCard, groundHeightCard, speedCard, renderPhysicsView } from './physview.js';
import { shotSpeed, speedSummary, calibration } from './speed.js';
import { adviceFigure } from './figures.js';
import { buildDiag } from './diag.js';
import { $, $$, esc, show, currentView, initNav, navState, setNavTag, onLeave, toast, sheet, seg, bindSegs, loadProfile, saveProfile, hasProfile, loadMyRefs, saveMyRefs, loadSpeedCal, saveSpeedCal } from './ui.js';

const video = $('#video');
const S = {
  profile: loadProfile(), ref: null, vids: [], cur: -1, meta: null, fps: 30,     // vids = 고른 영상들, cur = 지금 <video> 에 올라 있는 영상 번호
  gen: 0,                                                         // 영상 묶음 번호(영상을 새로 고를 때마다 +1). 옛 묶음의 화면·작업을 가려낸다
  opt: { serveType: 'flat', speed: 'auto' },
  abort: null, job: 0, shot: null, session: null, from: 'home', afterBack: null,
};
const STROKE = { serve: '서브', forehand: '포핸드', backhand: '백핸드' };
const strokeName = (m) => (m.sub === 'smash' ? '스매시' : m.sub === 'volley' ? `${STROKE[m.stroke]} 발리` : m.stroke === 'backhand' ? (m.twoHanded ? '투핸드 백핸드' : '원핸드 백핸드') : STROKE[m.stroke]);
const MOMENTS = {
  serve: [['trophy', '트로피'], ['contact', '임팩트'], ['finish', '피니시'], ['load', '무릎 굽힘'], ['toss', '토스']],
  ground: [['backswing', '백스윙'], ['contact', '임팩트'], ['finish', '피니시'], ['ready', '준비']],
};
const REF_PHASE = { serve: { trophy: 'trophy', load: 'trophy', contact: 'contact' }, ground: { backswing: 'backswing', contact: 'contact', finish: 'finish' } };

// ── 시작 ────────────────────────────────────────────────────────
let jobSeq = 0;
const newJob = () => { S.job = ++jobSeq; return S.job; };
initNav((from, to, g) => {
  if (from === 'working') { newJob(); if (S.abort) S.abort.abort(); wakeOff(); }    // 진행 중에 뒤로 가면 그 작업은 버린다
  // 보여 줄 것이 남아 있지 않은 화면(다른 영상을 골라 지워진 결과 등)으로는 가지 않고 처음 화면으로
  const stale = g !== undefined && g !== S.gen && ['setup', 'people', 'result', 'session'].includes(to);   // 다른 영상을 고르기 전의 화면
  const gone = stale || to === 'working' || (to === 'result' && !S.shot) || (to === 'session' && !S.session) || ((to === 'setup' || to === 'people') && !S.vids.length);
  show(gone ? 'home' : to, { push: false });
  if (!gone && to === 'session') { renderSession(); thumbs(); }      // 샷 화면에서 임팩트·종류를 고쳤을 수 있으니 목록을 다시 그린다
  if (!gone && to === 'result') { const sh = S.shot; useVideo(sh.vid).then((ok) => { if (ok && S.shot === sh && currentView() === 'result') paintMoment(); }).catch(() => {}); }   // 그 샷의 영상이 올라 있게
  if (S.afterBack) { const f = S.afterBack; S.afterBack = null; f(); }
});

// 분석하는 동안 화면이 꺼지지 않게(지원하는 브라우저에서만)
let wake = null;
async function wakeOn() { try { if ('wakeLock' in navigator && !wake) wake = await navigator.wakeLock.request('screen'); } catch (_) { wake = null; } }
function wakeOff() { try { if (wake) wake.release(); } catch (_) { /* 무시 */ } wake = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && currentView() === 'working') wakeOn(); });
onLeave((from) => { if (from === 'result') video.pause(); });
fetch('/static/coach/data/stroke_model.json').then((r) => (r.ok ? r.json() : null)).then((mdl) => { if (mdl && Array.isArray(mdl.W) && mdl.n_feat === mdl.mean.length) S.model = mdl; }).catch(() => {});
fetch('/static/coach/data/reference.json').then((r) => (r.ok ? r.json() : null)).then((ref) => {
  S.ref = ref;
  if (ref) $('#refInfo').textContent = `선수 사진 ${ref.used}장의 자세를 기준으로 견줍니다(위키미디어 공용, 자유 이용 허가 사진).`;
}).catch(() => {});

$('#fileAny').addEventListener('change', (e) => pickFiles(e.target));
for (const b of $$('[data-go]')) b.addEventListener('click', () => { if (b.dataset.go === 'physics') renderPhysicsView($('#v-physics'), S.profile); show(b.dataset.go); });
$('#profileBtn').addEventListener('click', () => profileSheet());
$('#cancel').addEventListener('click', () => { if (S.abort) S.abort.abort(); });   // 작업 번호는 그대로 — 작업 쪽에서 앞 화면으로 돌아간다
$('#shareApp').addEventListener('click', async () => {
  const data = { title: '스윙 코치', text: '테니스 스윙 영상을 넣으면 선수 자세와 나란히 보고 고칠 점을 알려 줘요.', url: `${location.origin}/coach` };
  try { if (navigator.share) await navigator.share(data); else { await navigator.clipboard.writeText(data.url); toast('주소를 복사했어요'); } } catch (_) { /* 취소 */ }
});

/** 내 정보의 일부를 바꾸고 이 휴대폰에 저장한다 */
const setProfile = (patch) => { S.profile = { ...S.profile, ...patch }; saveProfile(S.profile); };

function profileSheet(after) {
  const p = { ...S.profile };
  sheet(`<h2>내 정보</h2><p class="small muted">비교 기준과 cm 환산에만 씁니다. 이 휴대폰에만 저장됩니다.</p>
    <div class="field"><div class="label">치는 손</div>${seg('hand', [['R', '오른손'], ['L', '왼손']], p.hand)}</div>
    <div class="field"><div class="label">백핸드</div>${seg('backhand', [['2h', '양손'], ['1h', '한손']], p.backhand)}</div>
    <div class="field"><div class="label">서브 자세</div>${seg('stance', [['platform', '플랫폼'], ['pinpoint', '핀포인트']], p.stance)}</div>
    <div class="field"><div class="label">비교할 선수</div>${seg('sex', [['M', '남자 선수'], ['F', '여자 선수'], ['U', '상관없음']], p.sex)}
      <p class="small muted" style="margin-top:6px">동호인의 공 속도는 여자 선수 쪽에 더 가깝습니다.</p></div>
    <div class="field"><label for="pfH">키 (cm)</label><input class="input num" id="pfH" type="number" inputmode="numeric" min="120" max="220" value="${p.heightCm}"></div>
    <div class="field"><div class="label">수준</div>${seg('level', [['beg', '입문'], ['mid', '중급'], ['adv', '상급']], p.level)}</div>
    <div class="btns"><button class="btn" id="pfSave">저장</button></div>`, (el, close) => {
    bindSegs(el, (k, v) => { p[k] = v; });
    $('#pfSave', el).addEventListener('click', () => {
      const h = Number($('#pfH', el).value);
      p.heightCm = h >= 120 && h <= 220 ? h : 170;
      S.profile = p; saveProfile(p); close();
      if (after) after(); else toast('저장했어요');
    });
  });
}

// ── 영상 고르기 ─────────────────────────────────────────────────
// 영상은 한 개든 여러 개든 한 번에 고른다. 스윙 한 번짜리인지 경기 전체인지는 묻지 않고 알아서 본다.
const MAX_VIDS = 8, SHORT_SEC = 25, MAX_SHOTS = 60;                // 샷마다 자세 프레임을 들고 있으므로 휴대폰 메모리를 위해 개수를 막는다
async function pickFiles(input) {
  const picked = [...(input.files || [])];
  input.value = '';
  if (!picked.length) return;
  const files = picked.slice(0, MAX_VIDS);
  const job = newJob();
  if (S.abort) S.abort.abort();
  thumbSeq++;
  const vids = [], bad = [];
  let loaded = -1;                                                // 지금 <video> 에 올라 있는 새 영상의 번호(마지막으로 연 파일이 실패했으면 -1)
  // 영상 열기는 한 번에 하나씩(샷 사진 그리기 등 다른 열기와 겹치지 않게 같은 줄에 선다)
  const opening = vidChain.then(async () => {
    S.cur = -1;                                                   // 이제부터 <video> 에는 새로 고른 파일이 올라간다
    for (const file of files) {
      loaded = -1;
      let meta;
      try { meta = await Pose.openVideo(video, file); } catch (e) { if (isAbort(e)) return false; bad.push(file.name); continue; }
      if (job !== S.job) { URL.revokeObjectURL(meta.url); return false; }
      if (!(meta.duration > 0.3) || !meta.width) { URL.revokeObjectURL(meta.url); bad.push(file.name); continue; }
      vids.push({ file, url: meta.url, meta, t0: 0, t1: meta.duration, people: [], person: null, single: true, pick: 0 });
      loaded = vids.length - 1;
    }
    return true;
  });
  vidChain = opening.catch(() => false);
  let ok = false;
  try { ok = await opening; } catch (_) { ok = false; }
  if (!ok || job !== S.job) { for (const v of vids) URL.revokeObjectURL(v.url); return; }
  if (!vids.length) { toast('영상을 열 수 없어요. 다른 영상으로 해 보세요.', 4000); return; }   // 앞서 본 결과는 그대로 둔다
  const old = S.vids;
  S.shot = null; S.session = null;
  S.vids = vids; S.gen++; setNavTag(S.gen);
  S.cur = loaded; S.meta = vids[Math.max(0, loaded)].meta;
  for (const v of old) URL.revokeObjectURL(v.url);
  S.opt = { serveType: 'flat', speed: 'auto' };
  if (loaded < 0) { try { await useVideo(0); } catch (_) { /* 미리보기만 비게 된다. 분석할 때 다시 연다 */ } }
  if (job !== S.job) return;
  if (bad.length) toast(`열 수 없는 영상 ${bad.length}개는 뺐어요`, 3500);
  else if (picked.length > MAX_VIDS) toast(`한 번에 ${MAX_VIDS}개까지 봅니다`, 3500);
  const go = () => renderSetup();
  if (!hasProfile()) profileSheet(go); else go();
}

/**
 * i 번째 영상을 <video> 에 올린다(이미 올라 있으면 그대로). 화면 여러 곳이 같은 <video> 를 쓰므로 한 번에 하나씩만 바꾼다.
 * 기다리는 사이 다른 영상 묶음을 골랐으면 아무것도 하지 않고 false 를 돌려준다 — 부른 쪽은 false 면 그만둔다.
 */
let vidChain = Promise.resolve();
function useVideo(i, gen = S.gen) {
  const run = vidChain.then(async () => {
    const v = S.vids[i];
    if (gen !== S.gen || !v) return false;
    if (S.cur !== i) { S.cur = -1; await Pose.openVideo(video, v.url); if (gen !== S.gen) return false; S.cur = i; }
    S.meta = v.meta;
    small.height = Math.round(320 * v.meta.height / v.meta.width);
    return true;
  });
  vidChain = run.catch(() => false);
  return run;
}

function renderSetup() {
  const el = $('#v-setup'), vids = S.vids, one = vids.length === 1 ? vids[0] : null;
  const total = () => vids.reduce((s, v) => s + (v.t1 - v.t0), 0);
  const trim = one && one.meta.duration > 60, d = one ? one.meta.duration : 0;
  el.innerHTML = `<p class="eyebrow">영상 ${vids.length}개 · 모두 ${fmtTime(vids.reduce((s, v) => s + v.meta.duration, 0))}</p>
    <h2 style="margin-top:4px">이 영상을 분석할게요</h2>
    <div class="stage"><canvas id="preview"></canvas><span class="tag num">${vids.length > 1 ? `영상 ${S.cur + 1} · ` : ''}${fmtTime(S.meta.duration)} · ${S.meta.width}×${S.meta.height}</span></div>
    ${vids.length > 1 ? `<ol class="vlist">${vids.map((v, i) => `<li><b>영상 ${i + 1}</b><span class="num">${fmtTime(v.meta.duration)}</span></li>`).join('')}</ol>` : ''}
    <div class="sec" style="margin-top:20px"><h3>누구의 스윙인가요</h3>
      <p class="small muted" style="margin-top:4px">알려 주신 대로 봅니다(영상에서 추측하지 않아요).</p>
      <div class="field"><div class="label">치는 손</div>${seg('hand', [['R', '오른손'], ['L', '왼손']], S.profile.hand)}</div>
      <div class="field"><div class="label">백핸드</div>${seg('backhand', [['2h', '양손'], ['1h', '한손']], S.profile.backhand)}</div>
      <div class="field"><div class="label">서브 자세</div>${seg('stance', [['platform', '플랫폼'], ['pinpoint', '핀포인트']], S.profile.stance)}
        <p class="small muted" style="margin-top:6px">플랫폼: 두 발을 벌린 채 그대로 뛰어오름 · 핀포인트: 뒷발을 앞발 옆으로 끌어 모은 뒤 뛰어오름</p></div>
      <div class="field"><label for="suH">키 (cm)</label><input class="input num" id="suH" type="number" inputmode="numeric" min="120" max="220" value="${S.profile.heightCm}"></div>
    </div>
    <ol class="steps" style="margin-top:20px">
      <li>스윙을 알아서 찾습니다<span>서브·포핸드·백핸드를 가려내고, 스윙 한 번짜리 영상도 그대로 됩니다.</span></li>
      <li>여러 사람이 나오면 한 명을 고릅니다<span>단식·복식 영상에서는 누구를 볼지 물어보고, 그 사람만 끝까지 따라갑니다.</span></li>
      <li>모두 모아 종합해서 알려 드립니다<span>${vids.length > 1 ? `영상 ${vids.length}개에서 찾은 스윙을 한데 모아` : '찾은 스윙을 모아'} 되풀이되는 것부터 짚습니다.</span></li>
    </ol>
    ${trim ? `<div class="field"><div class="label">시작 <b class="num" id="t0v">${fmtTime(0)}</b></div><input type="range" id="t0" min="0" max="${d}" step="${d > 30 ? 0.5 : 0.1}" value="0" aria-label="시작 시각"></div>
      <div class="field"><div class="label">끝 <b class="num" id="t1v">${fmtTime(d)}</b></div><input type="range" id="t1" min="0" max="${d}" step="${d > 30 ? 0.5 : 0.1}" value="${d}" aria-label="끝 시각"></div>` : ''}
    <p class="small muted" style="margin-top:12px" id="spanNote"></p>
    <details class="more"><summary>슬로모션으로 찍은 영상인가요?</summary>
      <div style="margin-top:10px">${seg('speed', [['auto', '알아서'], ['1', '일반'], ['4', '슬로 4배'], ['8', '슬로 8배']], S.opt.speed)}</div>
      <p class="small muted" style="margin-top:8px">${SHORT_SEC}초보다 짧은 영상에만 적용됩니다. 보통은 '알아서'로 두면 됩니다. 휴대폰 슬로모션은 보통 4배(초당 120장)나 8배(초당 240장)입니다. 공 속도를 보려면 배수를 직접 골라 주세요.</p></details>
    <div class="btns"><button class="btn" id="go">분석 시작</button></div>
    <p class="small muted" style="margin-top:12px"><button id="editPf" style="text-decoration:underline">비교할 선수·수준 바꾸기</button></p>`;
  show('setup');
  bindSegs(el, (k, v) => { if (k === 'speed') S.opt.speed = v; else setProfile({ [k]: v }); });
  const suH = $('#suH', el);
  suH.addEventListener('change', () => { const h = Number(suH.value); if (h >= 120 && h <= 220) setProfile({ heightCm: Math.round(h) }); else suH.value = S.profile.heightCm; });
  $('#editPf', el).addEventListener('click', () => profileSheet(() => renderSetup()));
  $('#go', el).addEventListener('click', () => runAll());
  const note = () => {
    const span = total();
    $('#spanNote', el).textContent = span > 600 ? `${fmtTime(span)} 분량입니다. 10분이 넘으면 오래 걸려요(휴대폰에서 영상 길이의 절반쯤). 화면을 켜 둔 채 기다려 주세요.`
      : span > SHORT_SEC ? `${fmtTime(span)} 분량을 봅니다. 긴 영상은 먼저 빠르게 훑어 스윙을 찾은 뒤 그 장면만 자세히 봅니다.` : '';
  };
  if (trim) {
    const minSpan = Math.min(2, d);                              // 짧은 영상에서도 0 ≤ 시작 < 끝 ≤ 길이
    $('#t0', el).addEventListener('input', (e) => { one.t0 = G.clamp(Number(e.target.value), 0, Math.max(0, one.t1 - minSpan)); e.target.value = one.t0; $('#t0v', el).textContent = fmtTime(one.t0); note(); drawPreview(one.t0); });
    $('#t1', el).addEventListener('input', (e) => { one.t1 = G.clamp(Number(e.target.value), Math.min(d, one.t0 + minSpan), d); e.target.value = one.t1; $('#t1v', el).textContent = fmtTime(one.t1); note(); drawPreview(one.t1); });
  }
  note();
  drawPreview(Math.min(S.meta.duration / 2, 1));
}
let previewBusy = false;
async function drawPreview(t) {
  if (previewBusy) return;
  previewBusy = true;
  try {
    await Pose.seek(video, t);
    const c = $('#preview');
    if (c) { c.width = Math.min(960, S.meta.width); c.height = Math.round(c.width * S.meta.height / S.meta.width); c.getContext('2d').drawImage(video, 0, 0, c.width, c.height); }
  } finally { previewBusy = false; }
}
const fmtTime = (s) => (s >= 60 ? `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초` : `${s.toFixed(1)}초`);

// ── 진행 표시 ───────────────────────────────────────────────────
function working(title, sub) {
  $('#workTitle').textContent = title; $('#workSub').textContent = sub || '';
  progress(0);
  if (currentView() !== 'working') show('working');
  newJob();
  S.abort = new AbortController();
  wakeOn();
  return S.abort.signal;
}
const setWork = (title, sub = '') => { $('#workTitle').textContent = title; $('#workSub').textContent = sub; };
/** 진행 화면에서 다른 화면으로(뒤로 가기 기록을 그 화면으로 바꾼다). 이미 다른 작업·화면으로 넘어갔으면 아무것도 하지 않는다. */
function leaveWorking(job, view) {
  if (job !== S.job || currentView() !== 'working') return false;
  wakeOff();
  show(view, { push: false });
  history.replaceState(navState(view), '', view === 'home' ? location.pathname : `#${view}`);
  return true;
}
function progress(p) {
  const v = Math.max(0, Math.min(1, p));
  $('#prog').setAttribute('stroke-dashoffset', (358.1 * (1 - v)).toFixed(1));
  $('#progText').textContent = `${Math.round(v * 100)}%`;
}
/** 취소·실패: 진행 화면을 기록에서 빼고 앞 화면으로 돌아간다(뒤로 가기가 헛돌지 않게). */
function backFromWorking(job) {
  if (job !== S.job || currentView() !== 'working') return false;
  history.back();
  return true;
}
function fail(job, msg) {
  if (job !== S.job || currentView() !== 'working') return;
  S.afterBack = () => sheet(`<h2>분석하지 못했어요</h2><p class="lead" style="font-size:15px">${esc(msg)}</p>
    <ol class="steps"><li>몸 전체가 나오게<span>머리부터 발끝까지 화면에 들어와야 합니다.</span></li><li>사람이 크게<span>화면 높이의 절반 이상이면 좋아요.</span></li><li>밝은 곳에서<span>역광이나 어두운 실내는 잘 안 잡힙니다.</span></li></ol>
    <div class="btns"><button class="btn" id="okFail">확인</button></div>`, (el, close) => $('#okFail', el).addEventListener('click', close));
  history.back();
}
const isAbort = (e) => e && e.name === 'AbortError';
const sfOpt = () => (S.opt.speed === 'auto' ? undefined : Number(S.opt.speed));
const vidTag = (i) => (S.vids.length > 1 ? `영상 ${i + 1}` : '');

// ── 분석: 사람 찾기 → (여러 명이면 고르기) → 영상마다 스윙 찾기 → 종합 ─────────
const small = document.createElement('canvas');
small.width = 320;
const smallCtx = small.getContext('2d', { willReadFrequently: true });

async function runAll() {
  const signal = working('영상 속 사람을 찾는 중', '여러 장면을 살펴봅니다.');
  const job = S.job, vids = S.vids;
  try {
    for (let i = 0; i < vids.length; i++) {
      if (job !== S.job) return;
      if (!(await useVideo(i))) return;
      if (vids.length > 1) setWork(`영상 속 사람을 찾는 중 (${i + 1}/${vids.length})`, '여러 장면을 살펴봅니다.');
      const found = await findPeopleIn(vids[i], signal, (p) => { if (job === S.job) progress((i + p) / vids.length); });
      if (job !== S.job) return;
      Object.assign(vids[i], { people: found.people, single: found.single, person: found.people[0] || null, pick: 0 });
    }
    if (!vids.some((v) => v.person)) { fail(job, '영상에서 사람을 찾지 못했어요.'); return; }
    if (vids.some((v) => !v.single)) { renderPeople(); leaveWorking(job, 'people'); return; }     // 여러 명이 나오는 영상이 있으면 누구를 볼지 묻는다
    await analyzeAll(job, signal);
  } catch (e) {
    if (isAbort(e)) { backFromWorking(job); return; }
    console.error(e);
    fail(job, '분석 중 문제가 생겼어요. 다른 브라우저(크롬·사파리 최신판)로 다시 해 보세요.');
  }
}

/** 영상 한 편에서 사람을 찾는다: 12군데를 살펴 같은 사람끼리 묶고, 고를 수 있는 사람과 '한 사람 영상인지'를 돌려준다 */
async function findPeopleIn(v, signal, onProgress) {
  await Pose.seek(video, (v.t0 + v.t1) / 2);
  const pl = await Pose.getPose({ model: 'lite', poses: 4, probe: video });
  const obs = [], n = 12;
  let seen = 0;
  for (let i = 0; i < n; i++) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const t = v.t0 + (v.t1 - v.t0) * (i + 0.5) / n;
    if (await Pose.seek(video, t)) {
      const poses = Pose.detect(pl, video);
      const colors = Track.readColors(smallCtx, video, poses);
      let any = false;
      poses.forEach((p, j) => { if (colors[j]) { obs.push({ t, lm: p.lm, color: colors[j], vis: Track.poseVis(p.lm), ratio: Track.bodyRatio(p.lm, v.meta.width / v.meta.height) }); any = true; } });
      if (any) seen++;
    }
    onProgress((i + 1) / n);
  }
  const groups = Track.groupPeople(obs);
  console.debug('[coach] 사람 후보:', groups.map((g) => `${g.name} ${g.count}번 크기 ${g.size.toFixed(2)} 또렷함 ${g.vis.toFixed(2)} 다리÷몸통 ${g.ratio.toFixed(2)}`).join(' · '));
  const found = Track.mainPeople(groups, seen);
  if (!found.single) {                                            // 고르는 화면에 쓸 사진은 이 영상이 올라 있는 지금 만들어 둔다
    for (const p of found.people) {
      const ok = await Pose.seek(video, p.sample.t);
      p.thumb = document.createElement('canvas');
      cropPerson(p.thumb, ok ? video : null, p.sample.lm, v.meta.width, v.meta.height, { hand: null, color: Draw.COLORS.me });
    }
  }
  return found;
}

function renderPeople() {
  const el = $('#v-people'), vids = S.vids;
  const ask = vids.map((v, i) => ({ v, i })).filter(({ v }) => !v.single);
  let prev = null;                                                // 앞 영상에서 고른 사람과 옷 색이 가장 가까운 사람을 미리 골라 둔다
  for (const { v } of ask) {
    v.pick = 0;
    if (prev) { let bd = Infinity; v.people.forEach((p, j) => { const dd = Track.colorDist(p.color, prev); if (dd < bd) { bd = dd; v.pick = j; } }); }
    prev = v.people[v.pick].color;
  }
  const alike = (v) => v.people.some((p, i) => v.people.some((q, j) => j > i && Track.colorDist(p.color, q.color) < 0.3));
  el.innerHTML = `<p class="eyebrow">여러 사람이 나오는 영상</p><h2 style="margin-top:4px">누구를 볼까요?</h2>
    <p class="lead" style="font-size:15px">고른 한 사람만 웃옷 색으로 끝까지 따라가며 봅니다.</p>
    ${ask.map(({ v, i }) => `<div class="pgroup">${vids.length > 1 ? `<h3>영상 ${i + 1} <span class="muted num" style="font-weight:500">${fmtTime(v.meta.duration)}</span></h3>` : ''}
      ${alike(v) ? '<div class="callout">옷 색이 비슷한 사람이 있어요. 두 사람이 섞여 분석될 수 있으니, 결과의 샷 사진을 확인해 주세요.</div>' : ''}
      <div class="people">${v.people.map((p, j) => `<button class="person" data-v="${i}" data-p="${j}" aria-pressed="${j === v.pick}"><canvas></canvas><span><i style="background:rgb(${p.color.map(Math.round).join(',')})"></i>${esc(p.name)} 옷</span></button>`).join('')}</div></div>`).join('')}
    <div class="btns"><button class="btn" id="goAll">이 사람 분석</button></div>`;
  for (const b of $$('.person', el)) {
    const v = vids[Number(b.dataset.v)], p = v.people[Number(b.dataset.p)], c = $('canvas', b);
    if (p.thumb) { c.width = p.thumb.width; c.height = p.thumb.height; c.getContext('2d').drawImage(p.thumb, 0, 0); }
    b.addEventListener('click', () => { v.pick = Number(b.dataset.p); for (const x of $$(`.person[data-v="${b.dataset.v}"]`, el)) x.setAttribute('aria-pressed', String(x === b)); });
  }
  $('#goAll', el).addEventListener('click', async () => {
    for (const { v } of ask) v.person = v.people[v.pick];
    const signal = working('영상을 읽는 중', '휴대폰 안에서만 분석합니다.');
    const job = S.job;
    try { await analyzeAll(job, signal); } catch (e) {
      if (isAbort(e)) { backFromWorking(job); return; }
      console.error(e); fail(job, '분석 중 문제가 생겼어요.');
    }
  });
}

/** 샷 하나: 잰 값과 조언까지 붙여 둔다 */
function makeShot(frames, swing, step, vid, extra = {}) {
  const meta = S.vids[vid].meta;
  const shot = { frames, swing, step, vid, moment: 'contact', refIdx: 0, overlay: false, ...extra };
  shot.m = swingMetrics(frames, swing, meta.width, meta.height);
  shot.a = advise(shot.m, ctxFor(shot));
  return shot;
}

async function analyzeAll(job, signal) {
  const vids = S.vids, shots = [], notes = [];
  const total = vids.reduce((s, v) => s + (v.person ? v.t1 - v.t0 : 0), 0) || 1;
  let done = 0;
  setWork('자세 인식 엔진을 불러오는 중', '처음 한 번은 조금 걸립니다(약 25MB).');
  for (let i = 0; i < vids.length; i++) {
    if (job !== S.job) return;
    const v = vids[i], span = v.t1 - v.t0, tag = vidTag(i), head = tag ? `${tag}: ` : '';
    if (!v.person) { notes.push(`${head}사람을 찾지 못했어요.`); continue; }
    if (!(await useVideo(i))) return;
    const o = { signal, job, label: tag ? `${tag}/${vids.length} · ` : '', onP: (p) => { if (job === S.job) progress((done + span * Math.min(1, p)) / total); } };
    const got = span <= SHORT_SEC ? await analyzeShort(v, i, o) : await analyzeLong(v, i, o);
    if (job !== S.job) return;
    if (!got.shots.length) notes.push(`${head}${got.why || '스윙 장면을 찾지 못했어요.'}`);
    if (got.partial != null) notes.push(`${head}영상을 끝까지 읽지 못하고 ${fmtTime(got.partial)} 지점까지만 봤어요(화면이 꺼졌거나 재생이 멈춘 경우). 화면을 켜 둔 채 다시 해 보세요.`);
    shots.push(...dropServePrep(got.shots));                  // 서브 준비 동작이 스트로크로 잡힌 것은 뺀다
    done += span;
    if (shots.length >= MAX_SHOTS) {
      shots.length = MAX_SHOTS;
      if (i < vids.length - 1) notes.push(`스윙이 많아 앞의 ${MAX_SHOTS}개까지만 봤어요. 나머지 영상은 따로 올려 주세요.`);
      break;
    }
  }
  if (job !== S.job) return;
  progress(1);
  if (!shots.length) { fail(job, (notes[0] || '스윙 동작을 찾지 못했어요.').replace(/^영상 \d+: /, '')); return; }
  const chosen = vids.find((v) => !v.single && v.person);
  if (shots.length === 1) {                                       // 스윙이 하나뿐이면 그 스윙을 바로 자세히 보여 준다
    if (!(await useVideo(shots[0].vid)) || job !== S.job) return;
    S.session = null; S.shot = shots[0]; S.shot.extra = notes; S.from = 'setup';
    renderResult();
    leaveWorking(job, 'result');
    return;
  }
  S.session = { shots, notes, who: chosen ? `${chosen.person.name} 옷` : null };
  renderSession();
  if (leaveWorking(job, 'session')) thumbs();
}

/** 짧은 영상(25초 이하): 모든 장면을 한 장씩 읽어 스윙을 찾는다. 슬로모션도 여기서 알아본다. */
async function analyzeShort(v, i, { signal, job, label, onP }) {
  await Pose.seek(video, (v.t0 + v.t1) / 2);
  const pl = await Pose.getPose({ model: 'full', poses: v.single ? 3 : 4, probe: video });
  if (job !== S.job) return { shots: [] };
  setWork(`${label}영상을 한 장씩 읽는 중`, '휴대폰 안에서만 분석합니다.');
  S.fps = await Pose.measureFps(video);
  const d = Math.min(v.t1 - v.t0, 40);
  const step = Math.max(1 / S.fps, d / 700);
  const st = { color: v.person.color.slice(), sizeRef: v.person.size };
  // 찾아 둔 그 사람의 옷 색·크기에서 따라가기를 시작한다. 한 사람 영상은 색을 못 읽은 화면에서도 방금 있던 자리의 사람을 이어서 본다.
  const follow = v.single ? Track.pickSingle : Track.pickTarget;
  const pick = (poses, t) => follow(poses, Track.readColors(smallCtx, video, poses), st, t);
  const raw = await Pose.extract(video, pl, { t0: v.t0, t1: v.t0 + d, step, signal, pick, onProgress: (p) => onP(p * 0.97) });
  if (job !== S.job) return { shots: [] };
  const frames = cleanFrames(raw.filter(G.validPose), v.meta.width / v.meta.height);
  if (frames.length < 10) return { shots: [], why: '영상에서 사람을 찾지 못했어요.' };
  const opts = { hand: S.profile.hand, sf: sfOpt(), backhand: S.profile.backhand, model: S.model };
  const all = detectSwings(frames, opts);
  console.debug(`[coach] ${label}짧은 영상: 스윙 후보 ${all.length}개`, all.map((x) => `${x.tc.toFixed(1)}초 ${x.stroke} 속도 ${x.peak.toFixed(1)}${x.suspect ? ' (준비 동작)' : ''}${x.uncertain ? ' (종류 불확실)' : ''}`).join(' · '));
  let swings = all.filter((s) => !s.suspect);
  if (!swings.length) { const one = mainSwing(frames, opts); if (one) swings = [one]; }
  if (!swings.length) return { shots: [], why: '스윙 동작을 찾지 못했어요. 휘두르는 장면 앞뒤로 1~2초씩 여유 있게 찍힌 영상이 좋아요.' };
  // 치는 손 설정이 반대인지: 반대 손목이 훨씬 빨리 움직였으면 알려 준다(투핸드는 두 손이 같이 움직이니 제외)
  const other = S.profile.hand === 'L' ? 'R' : 'L';
  const handWarn = swings.length === 1 && !swings[0].twoHanded && Math.max(...wristSpeed(frames, other)) > 1.4 * Math.max(...wristSpeed(frames, S.profile.hand));
  return { shots: swings.map((sw) => makeShot(frames, sw, step, i, { handWarn, sfGiven: sfOpt() > 0 })) };
}

/** 긴 영상: 먼저 가벼운 모델로 빠르게 훑어 스윙 시각을 찾고, 그 장면만 정밀 모델로 다시 읽는다. */
async function analyzeLong(v, i, { signal, job, label, onP }) {
  const aspect = v.meta.width / v.meta.height, person = v.person;
  setWork(`${label}영상 전체를 훑는 중`, '스윙하는 장면을 찾고 있어요.');
  const lite = await Pose.getPose({ model: 'lite', poses: 4 });
  if (job !== S.job) return { shots: [] };
  const st = { color: person.color.slice(), sizeRef: person.size };
  const follow = v.single ? Track.pickSingle : Track.pickTarget;
  const pick = (poses, t) => follow(poses, Track.readColors(smallCtx, video, poses), st, t);
  // 긴 영상에서도 메모리가 늘지 않게: 30초쯤 모이면 그 구간에서 스윙 시각만 뽑고 프레임은 버린다(끝 3초는 다음 구간과 겹친다)
  let buf = [];
  const cands = [];
  const flush = (final) => {
    if (buf.length < 10) { if (final) buf = []; return; }
    const end = buf[buf.length - 1].t;
    const found = detectSwings(cleanFrames(buf.filter(G.validPose), aspect), { hand: S.profile.hand, sf: 1, backhand: S.profile.backhand });
    for (const c of found) {
      if (c.suspect) continue;                                    // 테이크백만 한 동작은 샷으로 치지 않는다
      if (!final && c.tc > end - 2) continue;                     // 구간 끝에 걸친 스윙은 다음 구간에서 온전히 본다
      if (!cands.some((x) => Math.abs(x.tc - c.tc) < 0.6)) cands.push({ tc: c.tc, peak: c.peak });
    }
    buf = final ? [] : buf.filter((f) => f.t > end - 3);
  };
  const reached = await Pose.scan(video, lite, { t0: v.t0, t1: v.t1, rate: 2, pick, signal,
    sink: (f) => { buf.push(f); if (f.t - buf[0].t > 30) flush(false); },
    onProgress: (p) => onP(p * 0.55) });
  if (job !== S.job) return { shots: [] };
  flush(true);
  console.debug(`[coach] ${label}훑기 끝: 스윙 후보 ${cands.length}개`, cands.map((c) => c.tc.toFixed(1)).join(' '));
  const partial = reached < v.t1 - 3 ? reached : null;
  if (!cands.length) return { shots: [], partial, why: '스윙 장면을 찾지 못했어요. 고른 사람이 화면에 작게 나오면 잘 안 잡힙니다.' };
  cands.sort((a, b) => b.peak - a.peak);
  const top = cands.slice(0, 18).sort((a, b) => a.tc - b.tc);
  setWork(`${label}스윙 ${top.length}개를 자세히 보는 중`, cands.length > top.length ? `찾은 ${cands.length}개 중 가장 빠른 ${top.length}개를 봅니다.` : '');
  S.fps = await Pose.measureFps(video);
  const full = await Pose.getPose({ model: 'full', poses: 3 });
  const shots = [];
  for (let k = 0; k < top.length; k++) {
    if (job !== S.job) return { shots: [] };
    const c = top[k], st2 = { color: person.color.slice(), sizeRef: person.size };   // 처음 고른 색에서 다시 시작(훑는 동안 색이 딴 사람 쪽으로 흘렀을 수 있다)
    const step = 1 / Math.min(S.fps, 60);
    const raw = await Pose.extract(video, full, { t0: Math.max(v.t0, c.tc - 1.5), t1: Math.min(v.t1, c.tc + 0.8), step, signal,
      pick: (poses, t) => follow(poses, Track.readColors(smallCtx, video, poses), st2, t),
      onProgress: (p) => onP(0.55 + 0.45 * (k + p) / top.length) });
    const fr = cleanFrames(raw.filter(G.validPose), aspect);
    const sw = fr.length >= 10 ? mainSwing(fr, { hand: S.profile.hand, sf: 1, backhand: S.profile.backhand, model: S.model }) : null;
    console.debug(`[coach] ${c.tc.toFixed(1)}초: 읽은 프레임 ${raw.length} → 다듬은 뒤 ${fr.length} → ${sw ? sw.stroke : '스윙 못 찾음'}`);
    if (!sw || sw.suspect) continue;
    shots.push(makeShot(fr, sw, step, i, { sfGiven: sfOpt() === 1, sfIgnored: sfOpt() > 1 }));   // 긴 영상은 일반 속도로 보고 분석한다(공 속도 예측이 이 표시를 본다)
  }
  return { shots, partial, why: shots.length ? null : '스윙을 자세히 읽지 못했어요.' };
}

// ── 결과 화면 ───────────────────────────────────────────────────
function ctxFor(shot) {
  return { ref: S.ref, sex: S.profile.sex, heightCm: S.profile.heightCm, level: S.profile.level, serveType: shot.serveType || S.opt.serveType, result: shot.result || null };
}
function refsFor(shot, m, moment) {
  const family = m.stroke === 'serve' ? 'serve' : 'ground';
  const phase = REF_PHASE[family][moment];
  if (!phase) return [];
  const pose = G.poseAt(shot.frames, shot.swing.keys[moment]);
  const mine = { samples: loadMyRefs() };
  const o = { hand: S.profile.hand, sex: S.profile.sex, twoHanded: m.stroke === 'backhand' ? m.twoHanded : undefined };
  const a = matchReference(mine, m.stroke, phase, pose, { ...o, top: 1 });
  const b = matchReference(S.ref, m.stroke, phase, pose, { ...o, top: 3 });
  return [...a, ...b];
}

function renderResult() {
  const shot = S.shot, el = $('#v-result');
  const vm = (S.vids[shot.vid] || {}).meta || S.meta;
  const m = swingMetrics(shot.frames, shot.swing, vm.width, vm.height);
  const a = advise(m, ctxFor(shot));
  shot.m = m; shot.a = a;
  shot.speed = shotSpeed(shot, { heightCm: S.profile.heightCm, serveType: shot.serveType || S.opt.serveType, cal: loadSpeedCal() });   // '잰 값' 목록에 쓰려고 먼저 계산
  const stype = shot.serveType || S.opt.serveType;
  const family = m.stroke === 'serve' ? 'serve' : 'ground';
  const moments = MOMENTS[family].filter(([k]) => shot.swing.keys[k] != null);
  if (!moments.some(([k]) => k === shot.moment)) shot.moment = 'contact';
  const first = a.items[0], rest = a.items.slice(1);
  const errCm = Math.round(m.posErr * S.profile.heightCm);
  el.innerHTML = `
    <p class="eyebrow">${esc(strokeName(m))}${m.stroke === 'serve' && m.stanceType && m.stanceType !== 'unknown' ? ` · ${m.stanceType === 'pinpoint' ? '핀포인트 스탠스' : '플랫폼 스탠스'}` : ''}</p>
    <div class="stage"><canvas id="stage"></canvas>
      <div class="legend"><span><i style="background:${Draw.COLORS.me}"></i>나</span><span id="lgPro" hidden><i style="background:${Draw.COLORS.pro}"></i>선수</span></div></div>
    <div class="moments" role="group" aria-label="순간 고르기">${moments.map(([k, label]) => `<button data-m="${k}" aria-pressed="${k === shot.moment}">${label}</button>`).join('')}</div>
    <div class="nudge" id="nudge"><span>임팩트 순간이 어긋나 보이면 한 장씩 옮기세요 <span class="muted num">(영상 간격만으로도 ±${errCm}cm)</span></span>
      <div><button data-n="-1" aria-label="한 장 앞으로">‹</button><button data-n="1" aria-label="한 장 뒤로">›</button></div></div>
    <div id="cmp"></div>

    ${a.score == null
      ? `<div class="callout" style="margin-top:24px"><b>이 영상으로는 점수를 매기기 어려워요.</b><br>${esc(a.unratedWhy || '')}</div>`
      : `<div class="score">${Draw.ring(a.score)}<div><div class="grade">${esc(a.grade)}</div><p>${m.vis < 0.6 ? '화면이 흐려 참고용 점수입니다' : '선수 사진에서 뽑은 자세 분포와 견준 점수 (실력 점수가 아니에요)'}</p></div></div>`}
    ${a.score == null ? '' : first ? `<div class="first"><div class="k">가장 먼저 이것 하나</div><h3>${esc(first.title)}</h3>${figBox(first, m)}<p class="cue">${esc(first.cue)}</p><p class="why">${esc(first.why)}</p></div>`
      : '<div class="first"><div class="k">좋아요</div><h3>크게 고칠 곳이 보이지 않아요</h3><p class="cue">지금 자세를 유지하면서 같은 타점에서 반복해 보세요.</p></div>'}
    ${(a.score == null ? [] : rest).map((it) => `<details class="adv"><summary><span class="dot"></span><span><span class="t">${esc(it.title)}</span><span class="m">${esc(it.label)}${it.you ? ` · 지금 ${esc(it.you)}` : ''}</span></span></summary>
      <div class="body">${figBox(it, m)}<b>이렇게 해 보세요</b>${esc(it.cue)}<br><br><b>왜 중요한가요</b>${esc(it.why)}</div></details>`).join('')}
    ${a.score != null && a.good.length ? `<div class="sec"><h3>잘하고 있는 것</h3><div class="chips">${[...new Set(a.good.map((g) => g.label))].map((l) => `<span class="chip good">${esc(l)}</span>`).join('')}</div></div>` : ''}
    ${shot.handWarn ? `<div class="callout">반대쪽 손이 더 빠르게 움직였어요. 치는 손이 ${S.profile.hand === 'L' ? '오른손' : '왼손'}이라면 처음 화면의 <b>내 정보</b>에서 바꾸고 다시 분석해 주세요.</div>` : ''}
    ${a.notes.map((n) => `<div class="callout info">${esc(n)}</div>`).join('')}
    ${(shot.extra || []).map((n) => `<div class="callout">${esc(n)}</div>`).join('')}

    <div class="sec"><h3>이 공은 어떻게 됐나요?</h3><p class="small muted" style="margin:4px 0 10px">알려 주시면 라켓 면까지 묶어서 말씀드려요.</p>
      ${seg('result', [['good', '잘 들어감'], ['net', '네트'], ['long', '길게 아웃'], ...(family === 'ground' ? [['wide', '옆으로'], ['short', '짧음']] : [])], shot.result || '')}
      <div id="resultNote">${a.resultNote ? `<div class="callout">${esc(a.resultNote)}</div>` : ''}</div></div>

    <div class="sec"><h3>잰 값</h3><dl class="kv">${measures(m).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>
    <div class="sec"><h3>종류가 다르게 잡혔나요?</h3><p class="small muted" style="margin:4px 0 10px">바꾸면 그 종류로 다시 봅니다.</p>
      ${seg('kind', [['serve', '서브'], ['serve:smash', '스매시'], ['forehand', '포핸드'], ['forehand:volley', '포핸드 발리'], ['backhand', '백핸드'], ['backhand:volley', '백핸드 발리']], m.stroke + (m.sub ? `:${m.sub}` : ''))}</div>
    ${m.stroke === 'serve' ? `<div class="sec"><h3>어떤 서브였나요?</h3><p class="small muted" style="margin:4px 0 10px">종류에 따라 맞는 타점 높이와 자리가 다릅니다.</p>
      ${seg('stype', [['flat', '플랫'], ['slice', '슬라이스'], ['kick', '킥(스핀)']], stype)}</div>
      <div class="sec"><h2>공 속도 <span class="muted" style="font-size:15px;font-weight:600">예측</span></h2><div id="speedHere"></div></div>
      <div class="sec"><h2>내 타점 높이</h2><div id="physHere"></div></div>${serveStyle(m)}` : ''}
    ${m.stroke !== 'serve' ? '<div class="sec"><h2>공 속도 <span class="muted" style="font-size:15px;font-weight:600">예측</span></h2><div id="speedHere"></div></div><div class="sec"><h2>내 타점</h2><div id="physHere"></div></div>' : ''}
    <div class="btns">
      <button class="btn" id="shareShot" ${a.score == null ? 'disabled' : ''}>결과 공유</button>
      <button class="btn ghost sm" id="saveRef">이 스윙을 내 기준 자세로 저장</button>
      ${S.session ? '' : '<button class="btn ghost sm" id="another">다른 영상 분석</button>'}
      <button class="btn ghost sm" id="diagShot">분석이 틀렸나요? 진단 파일 저장</button>
    </div>`;
  for (const b of $$('.moments button', el)) b.addEventListener('click', () => { shot.moment = b.dataset.m; shot.refIdx = 0; for (const x of $$('.moments button', el)) x.setAttribute('aria-pressed', String(x === b)); paintMoment(); });
  for (const b of $$('#nudge button', el)) b.addEventListener('click', () => {
    const fr = shot.frames, tcNow = shot.swing.keys.contact;
    let k = shot.swing.i0;                                       // 지금 임팩트에 가장 가까운 실제 프레임
    for (let i = shot.swing.i0; i <= shot.swing.i1; i++) if (Math.abs(fr[i].t - tcNow) < Math.abs(fr[k].t - tcNow)) k = i;
    k = G.clamp(k + Number(b.dataset.n), shot.swing.i0 + 2, shot.swing.i1 - 1);
    shot.swing = withContact(fr, shot.swing, fr[k].t); shot.moment = 'contact';
    renderResult();
  });
  bindSegs(el, (k, v) => {
    if (k === 'stype') { shot.serveType = v; const y = window.scrollY; renderResult(); window.scrollTo(0, y); return; }   // 서브 종류를 바꾸면 그 종류의 기준으로 다시 본다
    if (k === 'kind') {                                        // 종류를 바로잡으면 그 종류로 다시 분석
      const [kind, sub = null] = v.split(':');
      if (kind === shot.swing.stroke && sub === (shot.swing.sub || null)) return;
      const again = withStroke(shot.frames, shot.swing, kind, sub);
      if (again) { shot.swing = again; shot.moment = 'contact'; shot.refIdx = 0; shot.result = null; renderResult(); window.scrollTo(0, 0); }
      return;
    }
    if (k !== 'result') return; shot.result = v; const r = advise(m, ctxFor(shot)); $('#resultNote', el).innerHTML = r.resultNote ? `<div class="callout">${esc(r.resultNote)}</div>` : (v === 'good' ? '<div class="callout info">좋아요. 이 스윙의 느낌을 기억해 두세요.</div>' : ''); });
  $('#shareShot', el).addEventListener('click', () => shareShot());
  $('#saveRef', el).addEventListener('click', () => saveAsRef());
  $('#diagShot', el).addEventListener('click', () => diagSheet(S.session ? S.session.shots : [shot]));
  const again = $('#another', el);
  if (again) again.addEventListener('click', () => { show('home', { push: false }); history.replaceState(navState('home'), '', location.pathname); });
  const sp = shot.speed;                                          // 손목 속도로 예측한 공 속도(위에서 계산)
  speedCard($('#speedHere', el), sp, m.stroke, { onCal: sp.ok ? () => calSheet(sp, m.stroke) : null,
    onClear: !sp.ok && loadSpeedCal()[m.stroke] !== 1 ? () => setCal(m.stroke, 1, '맞춘 값을 지웠어요') : null });   // 맞춘 값 때문에 숫자가 안 나올 때도 지울 수 있게
  if (m.sub) {
    $('#physHere', el).innerHTML = `<div class="callout info">${m.sub === 'smash' ? '스매시' : '발리'}의 타점 기준은 아직 만드는 중이에요.</div>`;
  } else if (m.stroke === 'serve') {
    serveHeightCard($('#physHere', el), { heightCm: S.profile.heightCm, wristRatio: m.wristHeightGround > 0 ? m.wristHeightGround : null, jump: m.jump, type: stype, hand: S.profile.hand, level: S.profile.level, speed: sp.ok ? sp.kmh : NaN });
  } else {
    groundHeightCard($('#physHere', el), { heightCm: S.profile.heightCm, wristRatio: m.wristHeightGround, front: m.view === 'side' ? m.contactFront : NaN,
      kind: m.stroke === 'forehand' ? 'forehand' : m.twoHanded ? 'backhand2' : 'backhand1', level: S.profile.level, speed: sp.ok ? sp.kmh : NaN });
  }
  paintMoment();
}

/** 서브: 내 스탠스와 같은 방식을 쓰는 선수 */
function serveStyle(m) {
  const stance = {
    platform: ['플랫폼 스탠스', '뒷발을 그대로 둔 채 치는 방식입니다. 균형 잡기 쉽고 풋폴트가 적어 동호인에게 권하는 방식이에요.', '같은 방식: 페더러 · 조코비치 · 샘프러스'],
    pinpoint: ['핀포인트 스탠스', '뒷발을 앞발 옆으로 끌어와 위로 솟는 방식입니다. 높이 뛰기 좋지만 타이밍과 균형이 더 어렵습니다. 끌어온 뒷발이 앞발을 지나치지 않게 하세요.', '같은 방식: 즈베레프 · 알카라스 · 메드베데프 · 세레나 윌리엄스 · 시비옹테크 · 시너(2023년 말부터)'],
  }[m.stanceType];
  return stance ? `<div class="sec"><h3>서브 방식</h3><div class="pattern"><b>${stance[0]}로 보입니다</b><span>${stance[1]}</span><span style="margin-top:6px">${stance[2]}</span></div></div>` : '';
}

/** 맞춘 비율을 이 휴대폰에 저장하고 지금 결과를 다시 그린다. 저장하지 못하면 false */
function setCal(stroke, value, msg) {
  const cal = loadSpeedCal();
  cal[stroke] = value;
  if (!saveSpeedCal(cal)) { toast('저장하지 못했어요(저장 공간이 막혀 있어요)', 3500); return false; }
  const y = window.scrollY; renderResult(); window.scrollTo(0, y);
  toast(msg);
  return true;
}

/** 공 속도 보정: 스피드건이나 다른 앱으로 잰 실제 속도를 알려 주면, 그 비율을 이 휴대폰에 저장해 같은 스트로크의 속도에 곱한다 */
function calSheet(est, stroke) {
  const what = STROKE[stroke] || '이 스트로크';
  sheet(`<h2>공 속도 맞추기</h2><p class="small muted">이 스윙의 실제 공 속도를 알고 있다면(스피드건·다른 앱으로 잰 값) 넣어 주세요. 그 비율로 ${what} 속도를 맞춥니다. 한 번 맞춘다고 정확해지는 것은 아니고, 내 영상에 더 가깝게 옮기는 것입니다. 이 휴대폰에만 저장됩니다.</p>
    <div class="field"><label for="calV">이 스윙의 실제 속도 (km/h)</label><input class="input num" id="calV" type="number" inputmode="numeric" min="25" max="230" placeholder="${est.kmh}"></div>
    <div class="btns"><button class="btn" id="calSave">맞추기</button>${loadSpeedCal()[stroke] !== 1 ? '<button class="btn ghost sm" id="calClear">맞춘 값 지우기</button>' : ''}</div>`, (el, close) => {
    $('#calSave', el).addEventListener('click', () => {
      const f = calibration(est, Number($('#calV', el).value));
      if (!f) { toast(`${what}에서 나올 수 있는 속도이면서, 예측값의 절반~2배 사이여야 해요`, 4000); return; }
      if (setCal(stroke, f, '지금 결과와 다음 분석에 적용했어요')) close();
    });
    const clr = $('#calClear', el);
    if (clr) clr.addEventListener('click', () => { if (setCal(stroke, 1, '맞춘 값을 지웠어요')) close(); });
  });
}

/** 조언에 붙이는 그림 한 칸(맞는 그림이 없으면 빈 문자열) */
function figBox(it, m) {
  const svg = adviceFigure(it, m, { hand: S.profile.hand });
  return svg ? `<div class="fig">${svg}</div>` : '';
}

function measures(m) {
  const h = S.profile.heightCm, c = m.phases.contact || {}, out = [];
  const cmv = (x) => `${Math.round(x * h)}cm`;
  const ahead = (x) => `${Math.abs(Math.round(x * h))}cm ${x >= 0 ? '앞' : '뒤'}`;
  if (Number.isFinite(m.contactFront)) out.push(['타점 — 골반보다', ahead(m.contactFront)]);
  if (m.stroke === 'serve' && Number.isFinite(m.contactFrontFoot)) out.push(['타점 — 앞발보다', ahead(m.contactFrontFoot)]);
  if (Number.isFinite(m.wristHeightGround) && m.wristHeightGround > 0) {
    if (m.stroke === 'serve') {                                   // 서브: 리치와 견줘서
      const sc = Reach.serveContact(m.wristHeightGround, h);
      out.push(['내 리치', `약 ${sc.reach}cm (키 ${h}cm)`]);
      if (sc.ball >= 0.85 * sc.reach && sc.ball <= sc.reach + 45) out.push(['타점 높이(손목으로 예측)', `약 ${sc.ball}cm · ${sc.text}`]);
    } else out.push(['타점 높이(손목으로 예측)', `${Reach.bodyLevel(m.wristHeightGround)} · 약 ${cmv(m.wristHeightGround)}`]);   // 스트로크: 몸의 어느 높이인지
  }
  if (Number.isFinite(m.kneeBend)) out.push(['무릎 굽힘(가장 깊을 때)', `${Math.round(m.kneeBend)}°`]);
  if (Number.isFinite(c.elbowHit)) out.push(['임팩트 때 팔꿈치', `${Math.round(c.elbowHit)}°`]);
  if (m.stroke === 'serve') {
    if (Number.isFinite(c.armTrunk)) out.push(['팔–몸통 각', `${Math.round(c.armTrunk)}°`]);
    if (Number.isFinite(m.jump)) out.push(['점프 높이', cmv(m.jump)]);
  } else {
    if (Number.isFinite(m.chestAtBackswing)) out.push(['백스윙 때 어깨 턴', `${Math.round(m.chestAtBackswing)}°`]);
    if (Number.isFinite(m.chestAtContact)) out.push(['임팩트 때 가슴 방향', `${Math.round(m.chestAtContact)}° (0 = 정면)`]);
  }
  if (S.shot && S.shot.speed && S.shot.speed.ok) out.unshift(['공 속도(손목 속도로 예측)', `약 ${S.shot.speed.kmh}km/h (${S.shot.speed.lo}~${S.shot.speed.hi})`]);
  out.push(['찍은 방향', { side: '옆', behind: '뒤', front: '앞', unknown: '알 수 없음' }[m.view]]);
  if (m.sf > 1.5) out.push(['영상 속도', `슬로모션 약 ${Math.round(m.sf)}배${m.sfAuto ? '(예측)' : ''}`]);
  return out;
}

let paintSeq = 0;
async function paintMoment() {
  const shot = S.shot, seq = ++paintSeq, el = $('#v-result');
  const t = shot.swing.keys[shot.moment];
  const pose = G.poseAt(shot.frames, t);
  const ready = await Pose.seek(video, t);
  if (seq !== paintSeq || shot !== S.shot || currentView() !== 'result') return;
  const stage = $('#stage', el);
  if (!stage) return;
  const W = Math.min(1080, S.meta.width), H = Math.round(W * S.meta.height / S.meta.width);
  stage.width = W; stage.height = H;
  const x = stage.getContext('2d');
  if (ready) x.drawImage(video, 0, 0, W, H);
  else { x.fillStyle = '#050807'; x.fillRect(0, 0, W, H); }      // 그 장면을 못 불러오면 다른 순간의 화면을 깔지 않는다
  const lw = Math.max(3, W / 240);
  const refs = refsFor(shot, shot.m, shot.moment);
  const ref = refs[Math.min(shot.refIdx, refs.length - 1)];
  $('#lgPro', el).hidden = !(shot.overlay && ref);
  if (shot.overlay && ref) Draw.ghost(x, pose, ref.sample, W, H, { hand: S.profile.hand, width: lw });
  Draw.skeleton(x, pose.lm, W, H, { hand: S.profile.hand, width: lw });
  $('#nudge', el).hidden = shot.moment !== 'contact';
  paintCompare(refs, pose, ready);
}

function paintCompare(refs, pose, ready = true) {
  const shot = S.shot, host = $('#cmp');
  if (!host) return;
  if (!refs.length) { host.innerHTML = S.ref ? '' : '<div class="callout info">선수 기준 자세를 불러오지 못했어요. 연결을 확인하고 다시 열어 보세요.</div>'; return; }
  const idx = Math.min(shot.refIdx, refs.length - 1), r = refs[idx].sample;
  const who = (s, i) => (s.mine ? `내 기준 · ${s.title}` : s.player || `선수 사진 ${i + 1}`);
  host.innerHTML = `<div class="sec" style="margin-top:20px"><h3>나와 가장 닮은 선수 자세</h3>
    <p class="small muted" style="margin:4px 0 0">${S.ref ? `선수 사진 ${S.ref.used}장에서 자동으로 고른 자세입니다. 같은 순간이 아닐 수 있으니 참고로 보세요.` : ''}</p>
    <div class="refs">${refs.map((q, i) => `<button data-r="${i}" aria-pressed="${i === idx}">${esc(who(q.sample, i))}</button>`).join('')}</div>
    <div class="pair"><figure><canvas id="cmpMe"></canvas><figcaption>나</figcaption></figure><figure><canvas id="cmpPro"></canvas><figcaption>${esc(r.mine ? '내 기준' : r.player || '선수 사진')}</figcaption></figure></div>
    <label class="toggle"><input type="checkbox" id="ov" ${shot.overlay ? 'checked' : ''}> 위 화면에 선수 자세를 겹쳐 보기</label>
    <p class="credit">${r.mine ? '직접 저장한 기준 자세입니다.' : `사진: ${esc(r.author || '위키미디어 공용 기여자')} · ${r.licenseUrl ? `<a href="${esc(r.licenseUrl)}" target="_blank" rel="noopener">${esc(r.license)}</a>` : esc(r.license || '')} · <a href="${esc(r.page)}" target="_blank" rel="noopener">원본 보기</a> · 사람 주변만 잘라 뼈대를 덧그렸습니다${r.mirrored !== (S.profile.hand === 'L') ? ' · 치는 손을 맞추려고 좌우를 뒤집어 보여 줍니다' : ''}`}</p></div>`;
  for (const b of $$('.refs button', host)) b.addEventListener('click', () => { shot.refIdx = Number(b.dataset.r); paintMoment(); });
  $('#ov', host).addEventListener('change', (e) => { shot.overlay = e.target.checked; paintMoment(); });
  cropPerson($('#cmpMe', host), ready ? video : null, pose.lm, S.meta.width, S.meta.height, { hand: S.profile.hand, color: Draw.COLORS.me });
  drawRef($('#cmpPro', host), r, $('.credit', host));
}

/** 사람 주변만 잘라 3:4 캔버스에 그리고 뼈대를 얹는다 */
function cropPerson(canvas, source, lm, sw, sh, { hand, color, mirror = false }) {
  const cw = 360, ch = 480;
  canvas.width = cw; canvas.height = ch;
  const x = canvas.getContext('2d');
  let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  for (const k of lm) { if (k[3] !== undefined && k[3] < 0.2) continue; x0 = Math.min(x0, k[0]); x1 = Math.max(x1, k[0]); y0 = Math.min(y0, k[1]); y1 = Math.max(y1, k[1]); }
  const cx = (x0 + x1) / 2 * sw, cy = (y0 + y1) / 2 * sh;
  let bh = Math.max((y1 - y0) * sh * 1.3, (x1 - x0) * sw * 1.3 * (ch / cw)), bw = bh * cw / ch;
  if (!(bh > 10)) { bh = sh; bw = bh * cw / ch; }
  const sx = cx - bw / 2, sy = cy - bh / 2;
  x.fillStyle = '#050807'; x.fillRect(0, 0, cw, ch);
  x.save();
  if (mirror) { x.translate(cw, 0); x.scale(-1, 1); }
  if (source) { try { x.drawImage(source, sx, sy, bw, bh, 0, 0, cw, ch); } catch (_) { /* 원본을 못 그리면 뼈대만 */ } }
  x.restore();
  const pts = lm.map((k) => [((mirror ? sw - k[0] * sw : k[0] * sw) - (mirror ? sw - sx - bw : sx)) / bw, (k[1] * sh - sy) / bh, 0, k[3] ?? 1]);
  Draw.skeleton(x, pts, cw, ch, { hand, color, width: 4 });
}

function drawRef(canvas, r, creditEl) {
  const flip = S.profile.hand === 'L';                          // 표본(선수 사진·내 기준 모두)은 오른손 기준으로 저장돼 있다
  const lm = r.lm.map((k) => [k[0], k[1], 0, 1]);
  const paint = (img) => {
    const iw = img ? img.naturalWidth : 300 * (r.ar || 0.75), ih = img ? img.naturalHeight : 300;
    // 표본 좌표는 '오른손 기준으로 맞춘' 것이라, 왼손잡이 선수 사진은 사진도 뒤집어야 좌표와 맞는다
    const photoMirror = !!r.mirrored;
    const tmp = document.createElement('canvas');
    tmp.width = iw; tmp.height = ih;
    const tx = tmp.getContext('2d');
    if (img) { tx.save(); if (photoMirror) { tx.translate(iw, 0); tx.scale(-1, 1); } tx.drawImage(img, 0, 0, iw, ih); tx.restore(); }
    else { tx.fillStyle = '#0B1512'; tx.fillRect(0, 0, iw, ih); }
    cropPerson(canvas, tmp, lm, iw, ih, { hand: 'R', color: Draw.COLORS.pro, mirror: flip });
  };
  paint(null);
  if (!r.thumb) return;
  const img = new Image();
  img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer';
  img.onload = () => { if (canvas.isConnected) paint(img); };
  // 공용의 사진 주소는 두 군데(thumb / upload)다. 한쪽이 막히면 다른 쪽으로 한 번 더 해 보고, 그래도 안 되면 뼈대만 보여 준다.
  let retried = false;
  img.onerror = () => {
    if (!retried) { retried = true; img.src = r.thumb.includes('thumb.wikimedia.org') ? r.thumb.replace('thumb.wikimedia.org', 'upload.wikimedia.org') : r.thumb.replace('upload.wikimedia.org', 'thumb.wikimedia.org'); return; }
    if (creditEl && creditEl.isConnected) creditEl.insertAdjacentHTML('beforeend', ' · 사진을 불러오지 못해 뼈대만 보여 줍니다');
  };
  img.src = r.thumb;
}

/**
 * 진단 파일: 분석이 틀렸을 때, 뼈대 숫자와 설정만 담은 파일을 이 휴대폰에 저장(또는 공유)한다.
 * 영상·얼굴·파일 이름은 담지 않고, 서버로 보내지도 않는다. 사용자가 그 파일을 직접 건네줄 때만 밖으로 나간다.
 */
function diagSheet(shots) {
  sheet(`<h2>진단 파일 저장</h2>
    <p class="small muted">분석이 틀렸을 때 원인을 찾는 데 씁니다. 찾은 스윙 ${shots.length}개의 <b>뼈대 숫자</b>와 고른 설정만 담습니다. 영상·얼굴·파일 이름은 들어가지 않고, 서버로 보내지 않습니다.</p>
    <p class="small muted" style="margin-top:8px">종류가 틀리게 잡힌 샷은 그 샷 화면에서 먼저 바로잡아 주세요. 바로잡은 종류가 정답으로 함께 담깁니다.</p>
    <div class="field"><label for="diagNote">무엇이 틀렸나요? (선택)</label>
      <textarea class="input" id="diagNote" rows="3" maxlength="600" style="padding:12px 14px;min-height:88px" placeholder="예: 백핸드인데 포핸드로 나옴, 3번째 스윙을 못 찾음, 다른 사람을 따라감"></textarea></div>
    <div class="btns"><button class="btn" id="diagSave">파일 저장</button></div>`, (el, close) => {
    $('#diagSave', el).addEventListener('click', async () => {
      let text;
      try {
        text = JSON.stringify(buildDiag({ profile: S.profile, opt: S.opt, vids: S.vids, shots, note: $('#diagNote', el).value, app: 'v9' }));
      } catch (e) { console.error(e); toast('진단 파일을 만들지 못했어요'); return; }
      const d = new Date(), z = (n) => String(n).padStart(2, '0');
      const name = `swing-coach-diag-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.json`;
      const blob = new Blob([text], { type: 'application/json' });
      close();
      try {
        const file = new File([blob], name, { type: 'application/json' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: '스윙 코치 진단 파일' }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
        }
      } catch (_) { /* 파일 공유를 못 하는 브라우저 → 내려받기로 */ }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob); link.download = name;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
      toast(`진단 파일을 저장했어요 (${Math.max(1, Math.round(text.length / 1024))}KB)`, 3500);
    });
  });
}

function shareShot() {
  sheet(`<h2>결과 공유</h2><p class="small muted">이미지 한 장으로 공유합니다. 영상은 보내지 않습니다.</p>
    <div class="btns"><button class="btn" id="shPhoto">이 장면 사진과 함께</button><button class="btn ghost" id="shBones">뼈대만 (얼굴·배경 없이)</button></div>`, (el, close) => {
    $('#shPhoto', el).addEventListener('click', () => { close(); doShare(true); });
    $('#shBones', el).addEventListener('click', () => { close(); doShare(false); });
  });
}
async function doShare(withPhoto) {
  const shot = S.shot, first = shot.a.items[0];
  try {
    let frame = $('#stage');
    if (!withPhoto) {                                             // 어두운 바탕에 뼈대만
      const pose = G.poseAt(shot.frames, shot.swing.keys[shot.moment]);
      frame = document.createElement('canvas');
      frame.width = 720; frame.height = 960;
      cropPerson(frame, null, pose.lm, S.meta.width, S.meta.height, { hand: S.profile.hand, color: Draw.COLORS.me });
    }
    const card = Draw.shareCard({ frame, score: shot.a.score, grade: shot.a.grade, stroke: strokeName(shot.m),
      top: first ? first.title : '크게 고칠 곳이 보이지 않아요', cue: first ? first.cue : '', url: `${location.host}/coach` });
    const blob = await new Promise((r) => card.toBlob(r, 'image/png'));
    if (!blob) throw new Error('no image');
    const file = new File([blob], 'swing-coach.png', { type: 'image/png' });
    const data = { title: '스윙 코치', text: `내 ${strokeName(shot.m)} 자세 점수 ${shot.a.score}점`, url: `${location.origin}/coach` };
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ ...data, files: [file] }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = 'swing-coach.png';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    toast('결과 이미지를 저장했어요');
  } catch (e) {
    console.error(e);
    toast('공유 이미지를 만들지 못했어요. 화면을 캡처해서 보내 주세요.', 4000);
  }
}

function saveAsRef() {
  const shot = S.shot, m = shot.m;
  sheet(`<h2>내 기준 자세로 저장</h2><p class="small muted">선수나 코치님 영상을 분석한 뒤 저장해 두면, 다음부터 내 스윙을 이 자세와 나란히 보여 줍니다. 뼈대만 이 휴대폰에 저장합니다.</p>
    <div class="field"><label for="refName">이름</label><input class="input" id="refName" maxlength="20" placeholder="예: 코치님 포핸드"></div>
    <div class="btns"><button class="btn" id="refSave">저장</button></div>`, (el, close) => {
    $('#refSave', el).addEventListener('click', () => {
      const name = $('#refName', el).value.trim() || `${strokeName(m)} 기준`;
      const family = m.stroke === 'serve' ? 'serve' : 'ground';
      const list = loadMyRefs();
      for (const [moment, phase] of Object.entries(REF_PHASE[family])) {
        if (moment === 'load' || shot.swing.keys[moment] == null) continue;
        let pose = G.poseAt(shot.frames, shot.swing.keys[moment]);
        if (S.profile.hand === 'L') pose = G.mirrorPose(pose);       // 오른손 기준으로 맞춰 저장
        const r3 = (v) => Math.round(v * 1000) / 1000;
        list.push({ id: `mine-${Date.now()}-${phase}`, mine: true, stroke: m.stroke, phase, title: name, legs: true, mirrored: false,
          ar: r3(S.meta.width / S.meta.height), feat: G.poseFeature(pose).map(r3), lm: pose.lm.map((k) => [r3(k[0]), r3(k[1])]), w: pose.w.map((k) => [r3(k[0]), r3(k[1]), r3(k[2])]) });
      }
      close();
      toast(saveMyRefs(list) ? '저장했어요. 다음 분석부터 나란히 보여 드려요.' : '저장하지 못했어요(저장 공간).');
    });
  });
}

// ── 종합 판단: 찾은 스윙을 모두 모아(영상 여러 개 포함) 되풀이되는 것부터 짚는다 ─────────
function renderSession() {
  const el = $('#v-session'), { shots, notes, who } = S.session;
  const sum = summarize(shots), H = S.profile.heightCm;
  const when = (s) => `${vidTag(s.vid) ? `${vidTag(s.vid)} · ` : ''}${fmtTime(s.swing.tc)} 지점`;
  const row = (i, cls = '') => {
    const s = shots[i];
    return `<button class="shot ${cls}" data-i="${i}"><canvas width="144" height="108"></canvas>
      <span><b>${esc(s.a.items[0] ? baseTitle(s.a.items[0].title) : '자세가 안정적이에요')}</b><span class="num">${when(s)}${s.m.vis < 0.5 ? ' · 화면 흐림' : ''}</span></span><em>${s.a.score ?? '—'}</em></button>`;
  };
  const figFor = (p) => figBox(p.item, shots[p.shot].m);
  const first = sum.priorities[0], rest = sum.priorities.slice(1);
  // 속도 줄 끝에 붙이는 말: 몇 개 기준인지, 어떤 가정으로 계산했는지
  const spdNote = (x) => { const n = [x.n < x.of ? `${x.of}개 중 예측할 수 있었던 ${x.n}개` : '', x.assumed ? '일반 속도 영상으로 보고 계산' : ''].filter(Boolean); return n.length ? ` <span class="muted">(${n.join(' · ')})</span>` : ''; };
  const block = (b) => {
    const sp = spreadText(b, H);
    const spd = speedSummary(b.list.map((i) => shotSpeed(shots[i], { heightCm: H, cal: loadSpeedCal() })));
    return `<div class="sec"><h2>${b.label} <span class="muted num" style="font-size:15px;font-weight:600">${b.n}개${b.avg != null ? ` · 평균 ${b.avg}점` : ''}</span></h2>
      ${spd ? `<p class="small" style="margin-top:6px">공 속도(예측${spd.cal ? ' · 맞춤' : ''}) ${spd.n > 1 ? `평균 약 <b class="num">${spd.avg}km/h</b> · 가장 큰 값 약 <b class="num">${spd.max}km/h</b>` : `약 <b class="num">${spd.avg}km/h</b>`}${spdNote(spd)}</p>` : ''}
      ${sp ? `<p class="small muted" style="margin-top:6px">${esc(sp)}</p>` : ''}
      ${b.patterns.slice(0, 3).map((p) => `<div class="pattern"><b>${esc(p.title)}</b><span>${p.of > 1 ? `${p.of}개 중 ${p.n}개에서 · ` : ''}${esc(p.cue)}</span></div>`).join('')
        || `<div class="pattern"><b>되풀이되는 문제는 보이지 않아요</b><span>${b.n > 1 ? '샷마다 다른 점만 아래에서 확인하세요.' : '아래 샷을 눌러 자세히 보세요.'}</span></div>`}
      ${b.best.length ? `<h3 style="margin-top:18px">${b.worst.length ? '잘 친 샷' : '찾은 샷'}</h3><div class="shots">${b.best.map((i) => row(i, b.worst.length ? 'best' : '')).join('')}</div>` : ''}
      ${b.worst.length ? `<h3 style="margin-top:18px">아쉬운 샷</h3><div class="shots">${b.worst.map((i) => row(i, 'worst')).join('')}</div>` : ''}</div>`;
  };
  el.innerHTML = `<p class="eyebrow">${who ? `${esc(who)} · ` : ''}${sum.videos > 1 ? `영상 ${sum.videos}개 · ` : ''}스윙 ${shots.length}개</p><h1 style="margin-top:4px">종합 판단</h1>
    <p class="lead" style="font-size:15px">${esc(sum.kinds.map((b) => `${b.label} ${b.n}개`).join(' · '))}를 찾았어요. 한 번 나온 것보다 되풀이되는 것을 먼저 짚습니다.</p>
    ${sum.score == null ? '<div class="callout" style="margin-top:20px"><b>점수를 매기기 어려운 영상이에요.</b><br>팔다리가 또렷하게 보이지 않았습니다. 몸 전체가 크게, 밝게 나오게 찍어 보세요.</div>'
      : `<div class="score">${Draw.ring(sum.score)}<div><div class="grade">${esc(sum.grade)}</div><p>${sum.scored < shots.length ? `또렷하게 보인 스윙 ${sum.scored}개` : `스윙 ${sum.scored}개`}의 자세 점수 평균 (실력 점수가 아니에요)</p></div></div>`}
    ${first ? `<div class="first"><div class="k">가장 먼저 이것 하나 · ${esc(countText(first))}</div><h3>${esc(first.title)}</h3>${figFor(first)}<p class="cue">${esc(first.cue)}</p><p class="why">${esc(first.why)}</p></div>`
      : (sum.score != null ? '<div class="first"><div class="k">좋아요</div><h3>되풀이되는 문제가 보이지 않아요</h3><p class="cue">지금 자세를 유지하면서, 아래 아쉬운 샷만 한 번씩 확인해 보세요.</p></div>' : '')}
    ${rest.map((p) => `<details class="adv"><summary><span class="dot"></span><span><span class="t">${esc(p.title)}</span><span class="m">${esc(countText(p))}</span></span></summary>
      <div class="body">${figFor(p)}<b>이렇게 해 보세요</b>${esc(p.cue)}<br><br><b>왜 중요한가요</b>${esc(p.why)}</div></details>`).join('')}
    ${sum.strengths.length ? `<div class="sec"><h3>꾸준히 잘하고 있는 것</h3><div class="chips">${sum.strengths.slice(0, 8).map((g) => `<span class="chip good">${esc(sum.kinds.length > 1 ? `${g.kindLabel} · ` : '')}${esc(g.label)}</span>`).join('')}</div></div>` : ''}
    ${notes.map((n) => `<div class="callout">${esc(n)}</div>`).join('')}
    ${sum.kinds.map(block).join('')}
    <div class="sec"><h3>찾은 스윙 모두</h3><p class="small muted" style="margin:4px 0 0">공이 들어갔는지는 영상만으로 알 수 없어서 자세 점수로 봅니다. 샷을 누르면 자세히 봅니다.</p>
      <div class="shots">${shots.map((s, i) => `<button class="shot" data-i="${i}"><canvas width="144" height="108"></canvas><span><b>${esc(strokeName(s.m))}</b><span class="num">${when(s)}</span></span><em>${s.a.score ?? '—'}</em></button>`).join('')}</div></div>
    <div class="btns"><button class="btn ghost sm" id="another2">다른 영상 분석</button>
      <button class="btn ghost sm" id="diagAll">분석이 틀렸나요? 진단 파일 저장</button></div>`;
  for (const b of $$('.shot', el)) b.addEventListener('click', async () => {
    thumbSeq++;
    const sess = S.session, sh = shots[Number(b.dataset.i)];
    let ok = false;
    try { ok = await useVideo(sh.vid); } catch (_) { ok = false; }
    if (S.session !== sess || currentView() !== 'session') return;       // 기다리는 사이 다른 화면·다른 영상으로 넘어갔다
    if (!ok) { toast('영상을 다시 열지 못했어요'); return; }
    S.shot = sh; S.from = 'session'; renderResult(); show('result');
  });
  $('#another2', el).addEventListener('click', () => { show('home', { push: false }); history.replaceState(navState('home'), '', location.pathname); });
  $('#diagAll', el).addEventListener('click', () => diagSheet(shots));
}
let thumbSeq = 0;
/** 샷 목록의 작은 사진들. 종합 화면이 떠 있을 때만, 한 장씩 차례로 그린다(다른 화면으로 가면 멈추고, 돌아오면 다시 한다). */
async function thumbs() {
  if (!S.session) return;
  const seq = ++thumbSeq, shots = S.session.shots;
  const alive = () => seq === thumbSeq && currentView() === 'session';
  // 영상을 바꿔 여는 횟수를 줄이려고 영상별로 모아서 그린다
  const btns = $$('#v-session .shot').sort((a, b) => shots[Number(a.dataset.i)].vid - shots[Number(b.dataset.i)].vid);
  for (const b of btns) {
    if (!alive()) return;
    const sh = shots[Number(b.dataset.i)], c = $('canvas', b);
    if (c.dataset.done) continue;
    let opened = false;
    try { opened = await useVideo(sh.vid); } catch (_) { opened = false; }
    if (!alive()) return;
    if (!opened) continue;
    const ok = await Pose.seek(video, sh.swing.keys.contact);
    if (!alive()) return;
    const x = c.getContext('2d');
    if (ok) x.drawImage(video, 0, 0, c.width, c.height);
    Draw.skeleton(x, G.poseAt(sh.frames, sh.swing.keys.contact).lm, c.width, c.height, { width: 2, hand: S.profile.hand });
    c.dataset.done = '1';
  }
}

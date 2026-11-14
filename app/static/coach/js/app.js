// 스윙 코치 — 화면 흐름: 영상 고르기 → (전체 영상이면 사람 고르기) → 분석 → 결과·선수 대조군·조언 → 공유.
// 영상은 기기 안에서만 다룬다. 서버로 보내는 것은 없다.
import * as Pose from './pose.js';
import * as Track from './track.js';
import * as Draw from './draw.js';
import * as G from './geom.js';
import { cleanFrames } from './clean.js';
import { detectSwings, mainSwing, withContact } from './swing.js';
import { swingMetrics } from './metrics.js';
import { advise, matchReference } from './advice.js';
import * as Phys from './physics.js';
import { serveCalculator, renderPhysicsView } from './physview.js';
import { $, $$, esc, show, currentView, initNav, onLeave, toast, sheet, seg, bindSegs, loadProfile, saveProfile, hasProfile, loadMyRefs, saveMyRefs } from './ui.js';

const video = $('#video');
const S = {
  profile: loadProfile(), ref: null, mode: 'swing', file: null, meta: null, url: null, fps: 30,
  opt: { stroke: 'auto', serveType: 'flat', speed: 'auto', result: null, t0: 0, t1: 0 },
  abort: null, job: 0, shot: null, session: null, from: 'home',
};
const STROKE = { serve: '서브', forehand: '포핸드', backhand: '백핸드' };
const strokeName = (m) => (m.stroke === 'backhand' ? (m.twoHanded ? '투핸드 백핸드' : '원핸드 백핸드') : STROKE[m.stroke]);
const MOMENTS = {
  serve: [['trophy', '트로피'], ['contact', '임팩트'], ['finish', '피니시'], ['load', '무릎 굽힘'], ['toss', '토스']],
  ground: [['backswing', '백스윙'], ['contact', '임팩트'], ['finish', '피니시'], ['ready', '준비']],
};
const REF_PHASE = { serve: { trophy: 'trophy', load: 'trophy', contact: 'contact' }, ground: { backswing: 'backswing', contact: 'contact', finish: 'finish' } };

// ── 시작 ────────────────────────────────────────────────────────
let jobSeq = 0;
const newJob = () => { S.job = ++jobSeq; return S.job; };
initNav((from, to) => {
  if (from === 'working') { newJob(); if (S.abort) S.abort.abort(); }    // 진행 중에 뒤로 가면 그 작업은 버린다
  show(to === 'working' ? 'home' : to, { push: false });
  if (to === 'session' && S.session) thumbs();
});
onLeave((from) => { if (from === 'result') video.pause(); });
fetch('/static/coach/data/reference.json').then((r) => (r.ok ? r.json() : null)).then((ref) => {
  S.ref = ref;
  if (ref) $('#refInfo').textContent = `선수 사진 ${ref.used}장의 자세를 기준으로 견줍니다(위키미디어 공용, 자유 이용 허가 사진).`;
}).catch(() => {});

$('#fileSwing').addEventListener('change', (e) => pickFile('swing', e.target));
$('#fileFull').addEventListener('change', (e) => pickFile('full', e.target));
for (const b of $$('[data-go]')) b.addEventListener('click', () => { if (b.dataset.go === 'physics') renderPhysicsView($('#v-physics'), S.profile); show(b.dataset.go); });
$('#profileBtn').addEventListener('click', () => profileSheet());
$('#cancel').addEventListener('click', () => { if (S.abort) S.abort.abort(); });   // 작업 번호는 그대로 — 작업 쪽에서 앞 화면으로 돌아간다
$('#shareApp').addEventListener('click', async () => {
  const data = { title: '스윙 코치', text: '테니스 스윙 영상을 넣으면 선수 자세와 나란히 보고 고칠 점을 알려 줘요.', url: `${location.origin}/coach` };
  try { if (navigator.share) await navigator.share(data); else { await navigator.clipboard.writeText(data.url); toast('주소를 복사했어요'); } } catch (_) { /* 취소 */ }
});

function profileSheet(after) {
  const p = { ...S.profile };
  sheet(`<h2>내 정보</h2><p class="small muted">비교 기준과 cm 환산에만 씁니다. 이 휴대폰에만 저장됩니다.</p>
    <div class="field"><div class="label">치는 손</div>${seg('hand', [['R', '오른손'], ['L', '왼손']], p.hand)}</div>
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
async function pickFile(mode, input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const job = newJob();
  if (S.abort) S.abort.abort();
  const oldUrl = S.url;
  S.mode = mode; S.file = file; S.shot = null; S.session = null; thumbSeq++;
  let meta;
  try {
    meta = await Pose.openVideo(video, file);
  } catch (e) { if (!isAbort(e)) toast(e.message, 4000); return; }
  if (job !== S.job) { URL.revokeObjectURL(meta.url); return; }
  if (oldUrl) URL.revokeObjectURL(oldUrl);
  S.meta = meta; S.url = meta.url;
  if (!(S.meta.duration > 0.3) || !S.meta.width) { toast('영상 길이를 읽을 수 없어요. 다른 영상으로 해 보세요.', 4000); return; }
  S.opt = { stroke: 'auto', serveType: 'flat', speed: 'auto', result: null, t0: 0, t1: S.meta.duration };
  const go = () => renderSetup();
  if (!hasProfile()) profileSheet(go); else go();
}

async function renderSetup() {
  const d = S.meta.duration, el = $('#v-setup');
  const long = S.mode === 'swing' && d > 25;
  el.innerHTML = `<p class="eyebrow">${S.mode === 'swing' ? '스윙 영상' : '전체 영상'}</p>
    <h2 style="margin-top:4px">${S.mode === 'swing' ? '어떤 스윙인가요?' : '어디부터 어디까지 볼까요?'}</h2>
    <div class="stage"><canvas id="preview"></canvas><span class="tag num">${fmtTime(d)} · ${S.meta.width}×${S.meta.height}</span></div>
    ${S.mode === 'swing' ? `
      ${long ? `<div class="callout">영상이 길어요. 여러 번 치는 영상이면 처음 화면의 <b>전체 영상</b>으로 넣어 주세요. 여기서는 ${d > 40 ? '앞 40초 안에서 ' : ''}가장 빠른 스윙 하나만 봅니다.</div>` : ''}
      <div class="field"><div class="label">종류</div>${seg('stroke', [['auto', '알아서'], ['serve', '서브'], ['forehand', '포핸드'], ['backhand', '백핸드']], S.opt.stroke)}</div>
      <div class="field" id="fServe"><div class="label">서브라면 어떤 서브</div>${seg('serveType', [['flat', '플랫'], ['slice', '슬라이스'], ['kick', '킥(스핀)']], S.opt.serveType)}</div>
      <div class="field"><div class="label">영상 속도</div>${seg('speed', [['auto', '알아서'], ['1', '일반'], ['4', '슬로모션'], ['8', '아주 느린 슬로모션']], S.opt.speed)}</div>`
    : `<div class="field"><div class="label">시작 <b class="num" id="t0v">${fmtTime(0)}</b></div><input type="range" id="t0" min="0" max="${d}" step="${d > 30 ? 0.5 : 0.1}" value="0" aria-label="시작 시각"></div>
      <div class="field"><div class="label">끝 <b class="num" id="t1v">${fmtTime(d)}</b></div><input type="range" id="t1" min="0" max="${d}" step="${d > 30 ? 0.5 : 0.1}" value="${d}" aria-label="끝 시각"></div>
      <p class="small muted" style="margin-top:8px" id="spanNote"></p>`}
    <div class="btns"><button class="btn" id="go">${S.mode === 'swing' ? '분석 시작' : '사람 찾기'}</button></div>
    <p class="small muted" style="margin-top:12px">치는 손: ${S.profile.hand === 'L' ? '왼손' : '오른손'} · 키 ${S.profile.heightCm}cm · <button id="editPf" style="text-decoration:underline">바꾸기</button></p>`;
  show('setup');
  bindSegs(el, (k, v) => { S.opt[k] = v; if (k === 'stroke') $('#fServe', el).hidden = v === 'forehand' || v === 'backhand'; });
  $('#editPf', el).addEventListener('click', () => profileSheet(() => renderSetup()));
  $('#go', el).addEventListener('click', () => (S.mode === 'swing' ? runSwing() : findPeople()));
  if (S.mode === 'full') {
    const note = () => {
      const span = S.opt.t1 - S.opt.t0;
      $('#spanNote', el).textContent = span > 600 ? `${fmtTime(span)} 분량입니다. 10분이 넘으면 오래 걸려요(휴대폰에서 영상 길이의 절반쯤).` : `${fmtTime(span)} 분량을 봅니다.`;
    };
    const minSpan = Math.min(2, d);                              // 짧은 영상에서도 0 ≤ 시작 < 끝 ≤ 길이
    $('#t0', el).addEventListener('input', (e) => { S.opt.t0 = G.clamp(Number(e.target.value), 0, Math.max(0, S.opt.t1 - minSpan)); e.target.value = S.opt.t0; $('#t0v', el).textContent = fmtTime(S.opt.t0); note(); drawPreview(S.opt.t0); });
    $('#t1', el).addEventListener('input', (e) => { S.opt.t1 = G.clamp(Number(e.target.value), Math.min(d, S.opt.t0 + minSpan), d); e.target.value = S.opt.t1; $('#t1v', el).textContent = fmtTime(S.opt.t1); note(); drawPreview(S.opt.t1); });
    note();
  }
  drawPreview(Math.min(d / 2, 1));
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
  return S.abort.signal;
}
/** 진행 화면에서 다른 화면으로(뒤로 가기 기록을 그 화면으로 바꾼다). 이미 다른 작업·화면으로 넘어갔으면 아무것도 하지 않는다. */
function leaveWorking(job, view) {
  if (job !== S.job || currentView() !== 'working') return false;
  show(view, { push: false });
  history.replaceState({ v: view }, '', view === 'home' ? location.pathname : `#${view}`);
  return true;
}
function progress(p) {
  const v = Math.max(0, Math.min(1, p));
  $('#prog').setAttribute('stroke-dashoffset', (358.1 * (1 - v)).toFixed(1));
  $('#progText').textContent = `${Math.round(v * 100)}%`;
}
function fail(job, msg, back = 'setup') {
  if (!leaveWorking(job, back)) return;
  sheet(`<h2>분석하지 못했어요</h2><p class="lead" style="font-size:15px">${esc(msg)}</p>
    <ol class="steps"><li>몸 전체가 나오게<span>머리부터 발끝까지 화면에 들어와야 합니다.</span></li><li>사람이 크게<span>화면 높이의 절반 이상이면 좋아요.</span></li><li>밝은 곳에서<span>역광이나 어두운 실내는 잘 안 잡힙니다.</span></li></ol>
    <div class="btns"><button class="btn" id="okFail">확인</button></div>`, (el, close) => $('#okFail', el).addEventListener('click', close));
}
const isAbort = (e) => e && e.name === 'AbortError';
const sfOpt = () => (S.opt.speed === 'auto' ? undefined : Number(S.opt.speed));

// ── 스윙 영상 분석 ──────────────────────────────────────────────
async function runSwing() {
  const signal = working('자세 인식 엔진을 불러오는 중', '처음 한 번은 조금 걸립니다(약 25MB).');
  const job = S.job;
  try {
    await Pose.seek(video, S.meta.duration / 2);
    const pl = await Pose.getPose({ model: 'full', poses: 2, probe: video });
    if (job !== S.job) return;
    $('#workTitle').textContent = '영상을 한 장씩 읽는 중';
    $('#workSub').textContent = '휴대폰 안에서만 분석합니다.';
    S.fps = await Pose.measureFps(video);
    const d = Math.min(S.meta.duration, 40);
    const step = Math.max(1 / S.fps, d / 700);
    const raw = await Pose.extract(video, pl, { t0: 0, t1: d, step, signal, onProgress: (p) => { if (job === S.job) progress(p * 0.95); } });
    if (job !== S.job) return;
    const frames = cleanFrames(raw.filter(G.validPose), S.meta.width / S.meta.height);
    if (frames.length < 10) { fail(job, '영상에서 사람을 찾지 못했어요.'); return; }
    const swing = mainSwing(frames, { hand: S.profile.hand, stroke: S.opt.stroke === 'auto' ? undefined : S.opt.stroke, sf: sfOpt() });
    if (!swing) { fail(job, '스윙 동작을 찾지 못했어요. 휘두르는 장면 앞뒤로 1~2초씩 여유 있게 찍힌 영상이 좋아요.'); return; }
    progress(1);
    S.shot = { frames, swing, step, moment: 'contact', refIdx: 0, overlay: false };
    S.from = 'setup';
    renderResult();
    leaveWorking(job, 'result');
  } catch (e) {
    if (isAbort(e)) { leaveWorking(job, 'setup'); return; }
    console.error(e);
    fail(job, '분석 중 문제가 생겼어요. 다른 브라우저(크롬·사파리 최신판)로 다시 해 보세요.');
  }
}

// ── 결과 화면 ───────────────────────────────────────────────────
function ctxFor(shot) {
  return { ref: S.ref, sex: S.profile.sex, heightCm: S.profile.heightCm, level: S.profile.level, serveType: S.opt.serveType, result: shot.result || null };
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
  const m = swingMetrics(shot.frames, shot.swing, S.meta.width, S.meta.height);
  const a = advise(m, ctxFor(shot));
  shot.m = m; shot.a = a;
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
    ${a.score == null ? '' : first ? `<div class="first"><div class="k">가장 먼저 이것 하나</div><h3>${esc(first.title)}</h3><p class="cue">${esc(first.cue)}</p><p class="why">${esc(first.why)}</p></div>`
      : '<div class="first"><div class="k">좋아요</div><h3>크게 고칠 곳이 보이지 않아요</h3><p class="cue">지금 자세를 유지하면서 같은 타점에서 반복해 보세요.</p></div>'}
    ${rest.map((it) => `<details class="adv"><summary><span class="dot"></span><span><span class="t">${esc(it.title)}</span><span class="m">${esc(it.label)}${it.you ? ` · 지금 ${esc(it.you)}` : ''}</span></span></summary>
      <div class="body"><b>이렇게 해 보세요</b>${esc(it.cue)}<br><br><b>왜 중요한가요</b>${esc(it.why)}</div></details>`).join('')}
    ${a.good.length ? `<div class="sec"><h3>잘하고 있는 것</h3><div class="chips">${[...new Set(a.good.map((g) => g.label))].map((l) => `<span class="chip good">${esc(l)}</span>`).join('')}</div></div>` : ''}
    ${a.notes.map((n) => `<div class="callout info">${esc(n)}</div>`).join('')}

    <div class="sec"><h3>이 공은 어떻게 됐나요?</h3><p class="small muted" style="margin:4px 0 10px">알려 주시면 라켓 면까지 묶어서 말씀드려요.</p>
      ${seg('result', [['good', '잘 들어감'], ['net', '네트'], ['long', '길게 아웃'], ...(family === 'ground' ? [['wide', '옆으로'], ['short', '짧음']] : [])], shot.result || '')}
      <div id="resultNote">${a.resultNote ? `<div class="callout">${esc(a.resultNote)}</div>` : ''}</div></div>

    <div class="sec"><h3>잰 값</h3><dl class="kv">${measures(m).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>
    ${m.stroke === 'serve' ? `${serveStyle(m)}<div class="sec"><h2>내 타점에서 들어가는 각도</h2><div id="physHere"></div></div>` : ''}
    <div class="btns">
      <button class="btn" id="shareShot" ${a.score == null ? 'disabled' : ''}>결과 공유</button>
      <button class="btn ghost sm" id="saveRef">이 스윙을 내 기준 자세로 저장</button>
      ${S.session ? '' : '<button class="btn ghost sm" id="another">다른 영상 분석</button>'}
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
  bindSegs(el, (k, v) => { if (k !== 'result') return; shot.result = v; const r = advise(m, ctxFor(shot)); $('#resultNote', el).innerHTML = r.resultNote ? `<div class="callout">${esc(r.resultNote)}</div>` : (v === 'good' ? '<div class="callout info">좋아요. 이 스윙의 느낌을 기억해 두세요.</div>' : ''); });
  $('#shareShot', el).addEventListener('click', () => shareShot());
  $('#saveRef', el).addEventListener('click', () => saveAsRef());
  const again = $('#another', el);
  if (again) again.addEventListener('click', () => { show('home', { push: false }); history.replaceState({ v: 'home' }, '', location.pathname); });
  if (m.stroke === 'serve' && Number.isFinite(m.wristHeightGround)) {
    const ball = Phys.ballContactHeight({ wristHeightM: m.wristHeightGround * S.profile.heightCm / 100, stroke: 'serve' });
    serveCalculator($('#physHere', el), { height: Math.round(G.clamp(ball.mid, 2.0, 3.1) * 20) / 20, fixed: true, type: S.opt.serveType, hand: S.profile.hand,
      speed: S.profile.level === 'adv' ? 150 : S.profile.level === 'beg' ? 100 : 125 });
  }
  paintMoment();
}

/** 서브: 내 스탠스와 같은 방식을 쓰는 선수, 서브 종류별 토스·타점 요령 */
function serveStyle(m) {
  const lefty = S.profile.hand === 'L', R = lefty ? '왼쪽' : '오른쪽', L = lefty ? '오른쪽' : '왼쪽';
  const stance = {
    platform: ['플랫폼 스탠스', '뒷발을 그대로 둔 채 치는 방식입니다. 균형 잡기 쉽고 풋폴트가 적어 동호인에게 권하는 방식이에요.', '같은 방식: 페더러 · 조코비치 · 샘프러스'],
    pinpoint: ['핀포인트 스탠스', '뒷발을 앞발 옆으로 끌어와 위로 솟는 방식입니다. 높이 뛰기 좋지만 타이밍과 균형이 더 어렵습니다. 끌어온 뒷발이 앞발을 지나치지 않게 하세요.', '같은 방식: 즈베레프 · 알카라스 · 메드베데프 · 세레나 윌리엄스 · 시비옹테크 · 시너(2023년 말부터)'],
  }[m.stanceType];
  const type = {
    flat: ['플랫', `토스는 치는 어깨 앞, 시계로 12~1시 방향에 코트 안쪽으로. 세 가지 서브 중 가장 앞에서 맞습니다.`],
    slice: ['슬라이스', `토스를 플랫보다 조금 더 ${R}에 올리고, 공의 ${R} 옆면을 깎듯이 칩니다. 타점 높이는 플랫과 같습니다.`],
    kick: ['킥(스핀)', `토스를 머리 위에(플랫보다 20cm쯤 ${L}, 15~20cm 몸 쪽). 아래에서 위로 쓸어 올립니다. 타점 높이는 플랫과 같아도 됩니다.`],
  }[S.opt.serveType] || null;
  return `<div class="sec"><h3>서브 방식</h3>
    ${stance ? `<div class="pattern"><b>${stance[0]}로 보입니다</b><span>${stance[1]}</span><span style="margin-top:6px">${stance[2]}</span></div>` : ''}
    ${type ? `<div class="pattern"><b>${type[0]} 서브의 토스와 타점</b><span>${type[1]}</span></div>` : ''}</div>`;
}

function measures(m) {
  const h = S.profile.heightCm, c = m.phases.contact || {}, out = [];
  const cmv = (x) => `${Math.round(x * h)}cm`;
  if (Number.isFinite(m.contactFront)) out.push(['타점(손목) — 골반보다 앞', cmv(m.contactFront)]);
  if (m.stroke === 'serve' && Number.isFinite(m.contactFrontFoot)) out.push(['타점(손목) — 앞발보다 앞', cmv(m.contactFrontFoot)]);
  if (Number.isFinite(m.wristHeightGround)) out.push(['임팩트 때 손목 높이', cmv(m.wristHeightGround)]);
  if (Number.isFinite(m.kneeBend)) out.push(['무릎 굽힘(가장 깊을 때)', `${Math.round(m.kneeBend)}°`]);
  if (Number.isFinite(c.elbowHit)) out.push(['임팩트 때 팔꿈치', `${Math.round(c.elbowHit)}°`]);
  if (m.stroke === 'serve') {
    if (Number.isFinite(c.armTrunk)) out.push(['팔–몸통 각', `${Math.round(c.armTrunk)}°`]);
    if (Number.isFinite(m.jump)) out.push(['점프 높이', cmv(m.jump)]);
  } else {
    if (Number.isFinite(m.chestAtBackswing)) out.push(['백스윙 때 어깨 턴', `${Math.round(m.chestAtBackswing)}°`]);
    if (Number.isFinite(m.chestAtContact)) out.push(['임팩트 때 가슴 방향', `${Math.round(m.chestAtContact)}° (0 = 정면)`]);
  }
  out.push(['찍은 방향', { side: '옆', behind: '뒤', front: '앞', unknown: '알 수 없음' }[m.view]]);
  if (m.sf > 1.5) out.push(['영상 속도', `슬로모션 약 ${Math.round(m.sf)}배${m.sfAuto ? '(어림)' : ''}`]);
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
  const who = (s, i) => (s.mine ? `내 기준 · ${s.title}` : s.player || `프로 선수 ${i + 1}`);
  host.innerHTML = `<div class="sec" style="margin-top:20px"><h3>나와 가장 닮은 선수 자세</h3>
    <p class="small muted" style="margin:4px 0 0">${S.ref ? `선수 사진 ${S.ref.used}장에서 자동으로 고른 자세입니다. 같은 순간이 아닐 수 있으니 참고로 보세요.` : ''}</p>
    <div class="refs">${refs.map((q, i) => `<button data-r="${i}" aria-pressed="${i === idx}">${esc(who(q.sample, i))}</button>`).join('')}</div>
    <div class="pair"><figure><canvas id="cmpMe"></canvas><figcaption>나</figcaption></figure><figure><canvas id="cmpPro"></canvas><figcaption>${esc(r.mine ? '내 기준' : r.player || '프로 선수')}</figcaption></figure></div>
    <label class="toggle"><input type="checkbox" id="ov" ${shot.overlay ? 'checked' : ''}> 위 화면에 선수 자세를 겹쳐 보기</label>
    <p class="credit">${r.mine ? '직접 저장한 기준 자세입니다.' : `사진: ${esc(r.author || '위키미디어 공용 기여자')} · ${r.licenseUrl ? `<a href="${esc(r.licenseUrl)}" target="_blank" rel="noopener">${esc(r.license)}</a>` : esc(r.license || '')} · <a href="${esc(r.page)}" target="_blank" rel="noopener">원본 보기</a>${r.mirrored !== (S.profile.hand === 'L') ? ' · 치는 손을 맞추려고 좌우를 뒤집어 보여 줍니다' : ''}`}</p></div>`;
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
  img.onerror = () => { if (creditEl && creditEl.isConnected) creditEl.insertAdjacentHTML('beforeend', ' · 사진을 불러오지 못해 뼈대만 보여 줍니다'); };
  img.src = r.thumb;
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

// ── 전체 영상: 사람 고르기 ──────────────────────────────────────
const small = document.createElement('canvas');
small.width = 320;
const smallCtx = small.getContext('2d', { willReadFrequently: true });

async function findPeople() {
  const signal = working('영상 속 사람을 찾는 중', '여러 장면을 살펴봅니다.');
  const job = S.job;
  try {
    small.height = Math.round(320 * S.meta.height / S.meta.width);
    await Pose.seek(video, (S.opt.t0 + S.opt.t1) / 2);
    const pl = await Pose.getPose({ model: 'lite', poses: 4, probe: video });
    const obs = [], n = 12;
    for (let i = 0; i < n; i++) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (job !== S.job) return;
      const t = S.opt.t0 + (S.opt.t1 - S.opt.t0) * (i + 0.5) / n;
      if (!(await Pose.seek(video, t))) continue;
      const poses = Pose.detect(pl, video);
      const colors = Track.readColors(smallCtx, video, poses);
      poses.forEach((p, j) => { if (colors[j]) obs.push({ t, lm: p.lm, color: colors[j] }); });
      progress((i + 1) / n);
    }
    if (job !== S.job) return;
    const people = Track.groupPeople(obs).slice(0, 6);
    if (!people.length) { fail(job, '영상에서 사람을 찾지 못했어요.'); return; }
    await renderPeople(people, job);
    leaveWorking(job, 'people');
  } catch (e) {
    if (isAbort(e)) { leaveWorking(job, 'setup'); return; }
    console.error(e); fail(job, '사람을 찾는 중 문제가 생겼어요.');
  }
}

async function renderPeople(people, job) {
  const el = $('#v-people');
  let chosen = 0;
  // 옷 색이 비슷한 사람이 둘 이상이면 섞일 수 있다고 미리 알린다
  const alike = people.some((p, i) => people.some((q, j) => j > i && Track.colorDist(p.color, q.color) < 0.3));
  el.innerHTML = `<p class="eyebrow">전체 영상</p><h2 style="margin-top:4px">누구를 볼까요?</h2><p class="lead" style="font-size:15px">웃옷 색으로 그 사람만 끝까지 따라갑니다.</p>
    ${alike ? '<div class="callout">옷 색이 비슷한 사람이 있어요. 두 사람이 섞여 분석될 수 있으니, 결과의 샷 사진을 확인해 주세요.</div>' : ''}
    <div class="people">${people.map((p, i) => `<button class="person" data-p="${i}" aria-pressed="${i === 0}"><canvas></canvas><span><i style="background:rgb(${p.color.map(Math.round).join(',')})"></i>${esc(p.name)} 옷</span></button>`).join('')}</div>
    <div class="btns"><button class="btn" id="goFull">이 사람 분석</button></div>`;
  const cvs = $$('.person canvas', el);
  for (let i = 0; i < people.length; i++) {
    if (job !== S.job) return;
    const ok = await Pose.seek(video, people[i].sample.t);
    cropPerson(cvs[i], ok ? video : null, people[i].sample.lm, S.meta.width, S.meta.height, { hand: null, color: Draw.COLORS.me });
  }
  for (const b of $$('.person', el)) b.addEventListener('click', () => { chosen = Number(b.dataset.p); for (const x of $$('.person', el)) x.setAttribute('aria-pressed', String(x === b)); });
  $('#goFull', el).addEventListener('click', () => runFull(people[chosen]));
}

// ── 전체 영상 분석 ──────────────────────────────────────────────
async function runFull(person) {
  const signal = working('영상 전체를 훑는 중', '스윙하는 장면을 찾고 있어요.');
  const job = S.job;
  const aspect = S.meta.width / S.meta.height;
  try {
    const lite = await Pose.getPose({ model: 'lite', poses: 4 });
    if (job !== S.job) return;
    const st = { color: person.color.slice(), sizeRef: person.size };
    const pick = (poses, t) => Track.pickTarget(poses, Track.readColors(smallCtx, video, poses), st, t);
    // 긴 영상에서도 메모리가 늘지 않게: 30초쯤 모이면 그 구간에서 스윙 시각만 뽑고 프레임은 버린다(끝 3초는 다음 구간과 겹친다)
    let buf = [];
    const cands = [];
    const flush = (final) => {
      if (buf.length < 10) { if (final) buf = []; return; }
      const end = buf[buf.length - 1].t;
      const found = detectSwings(cleanFrames(buf.filter(G.validPose), aspect), { hand: S.profile.hand, sf: 1 });
      for (const c of found) {
        if (!final && c.tc > end - 2) continue;                   // 구간 끝에 걸친 스윙은 다음 구간에서 온전히 본다
        if (!cands.some((x) => Math.abs(x.tc - c.tc) < 0.6)) cands.push({ tc: c.tc, peak: c.peak });
      }
      buf = final ? [] : buf.filter((f) => f.t > end - 3);
    };
    await Pose.scan(video, lite, { t0: S.opt.t0, t1: S.opt.t1, rate: 2, pick, signal,
      sink: (f) => { buf.push(f); if (f.t - buf[0].t > 30) flush(false); },
      onProgress: (p) => { if (job === S.job) progress(p * 0.55); } });
    if (job !== S.job) return;
    flush(true);
    if (!cands.length) { fail(job, '스윙 장면을 찾지 못했어요. 고른 사람이 화면에 작게 나오면 잘 안 잡힙니다.', 'people'); return; }
    cands.sort((a, b) => b.peak - a.peak);
    const top = cands.slice(0, 18).sort((a, b) => a.tc - b.tc);
    $('#workTitle').textContent = `스윙 ${top.length}개를 자세히 보는 중`;
    $('#workSub').textContent = cands.length > top.length ? `찾은 ${cands.length}개 중 가장 빠른 ${top.length}개를 봅니다.` : '';
    S.fps = await Pose.measureFps(video);
    const full = await Pose.getPose({ model: 'full', poses: 3 });
    const shots = [];
    for (let i = 0; i < top.length; i++) {
      if (job !== S.job) return;
      const c = top[i], st2 = { color: st.color.slice(), sizeRef: person.size };
      const step = 1 / Math.min(S.fps, 60);
      const raw = await Pose.extract(video, full, { t0: Math.max(S.opt.t0, c.tc - 1.5), t1: Math.min(S.opt.t1, c.tc + 0.8), step, signal,
        pick: (poses, t) => Track.pickTarget(poses, Track.readColors(smallCtx, video, poses), st2, t),
        onProgress: (p) => { if (job === S.job) progress(0.55 + 0.45 * (i + p) / top.length); } });
      const fr = cleanFrames(raw.filter(G.validPose), aspect);
      const sw = fr.length >= 10 ? mainSwing(fr, { hand: S.profile.hand, sf: 1 }) : null;
      if (!sw) continue;
      const m = swingMetrics(fr, sw, S.meta.width, S.meta.height);
      const a = advise(m, ctxFor({}));
      shots.push({ frames: fr, swing: sw, step, m, a, moment: 'contact', refIdx: 0, overlay: false });
    }
    if (job !== S.job) return;
    if (!shots.length) { fail(job, '스윙을 자세히 읽지 못했어요.', 'people'); return; }
    S.session = { person, shots };
    renderSession();
    if (leaveWorking(job, 'session')) thumbs();
  } catch (e) {
    if (isAbort(e)) { leaveWorking(job, 'people'); return; }
    console.error(e); fail(job, '분석 중 문제가 생겼어요.', 'people');
  }
}

function renderSession() {
  const el = $('#v-session'), { shots, person } = S.session;
  const kinds = ['serve', 'forehand', 'backhand'].filter((k) => shots.some((s) => s.m.stroke === k));
  const block = (kind) => {
    const list = shots.filter((s) => s.m.stroke === kind);
    const rated = list.filter((s) => s.a.score != null);
    const clear = rated.filter((s) => s.m.vis >= 0.5);
    const ranked = (clear.length >= 2 ? clear : rated).slice().sort((a, b) => b.a.score - a.a.score);
    const best = ranked.slice(0, Math.min(2, Math.ceil(ranked.length / 2)));
    const worst = ranked.length > best.length ? ranked.slice(-Math.min(2, ranked.length - best.length)).reverse() : [];
    // 되풀이되는 문제: 같은 조언이 몇 개의 샷에서 나왔나
    const counts = {};
    for (const s of list) for (const it of s.a.items) (counts[it.id] ||= { n: 0, it }).n++;
    const patterns = Object.values(counts).filter((c) => c.n >= Math.max(2, Math.ceil(list.length * 0.4))).sort((a, b) => b.n - a.n).slice(0, 3);
    const row = (s, cls) => `<button class="shot ${cls}" data-i="${shots.indexOf(s)}"><canvas width="144" height="108"></canvas>
      <span><b>${esc(s.a.items[0] ? s.a.items[0].title : '자세가 안정적이에요')}</b><span class="num">${fmtTime(s.swing.tc)} 지점${s.m.vis < 0.5 ? ' · 화면 흐림' : ''}</span></span><em>${s.a.score ?? '—'}</em></button>`;
    return `<div class="sec"><h2>${STROKE[kind]} <span class="muted num" style="font-size:15px;font-weight:600">${list.length}개</span></h2>
      ${patterns.map((p) => `<div class="pattern"><b>${esc(p.it.title.replace(/ — .*/, ''))}</b><span>${list.length}개 중 ${p.n}개에서 · ${esc(p.it.cue)}</span></div>`).join('') || '<div class="pattern"><b>되풀이되는 문제는 보이지 않아요</b><span>샷마다 다른 점만 아래에서 확인하세요.</span></div>'}
      ${best.length ? `<h3 style="margin-top:18px">잘 친 샷</h3><div class="shots">${best.map((s) => row(s, 'best')).join('')}</div>` : ''}
      ${worst.length ? `<h3 style="margin-top:18px">아쉬운 샷</h3><div class="shots">${worst.map((s) => row(s, 'worst')).join('')}</div>` : ''}</div>`;
  };
  el.innerHTML = `<p class="eyebrow">${esc(person.name)} 옷 · 스윙 ${shots.length}개</p><h1 style="margin-top:4px">샷 모아 보기</h1>
    <p class="lead" style="font-size:15px">공이 들어갔는지는 영상만으로 알 수 없어서, 자세 점수로 고른 샷입니다. 샷을 누르면 자세히 봅니다.</p>
    ${kinds.map(block).join('')}
    <div class="sec"><h3>찾은 스윙 모두</h3><div class="shots">${shots.map((s, i) => `<button class="shot" data-i="${i}"><canvas width="144" height="108"></canvas><span><b>${esc(strokeName(s.m))}</b><span class="num">${fmtTime(s.swing.tc)} 지점</span></span><em>${s.a.score ?? '—'}</em></button>`).join('')}</div></div>`;
  for (const b of $$('.shot', el)) b.addEventListener('click', () => { thumbSeq++; S.shot = shots[Number(b.dataset.i)]; S.from = 'session'; renderResult(); show('result'); });
}
let thumbSeq = 0;
/** 샷 목록의 작은 사진들. 샷 모아 보기 화면이 떠 있을 때만, 한 장씩 차례로 그린다(다른 화면으로 가면 멈추고, 돌아오면 다시 한다). */
async function thumbs() {
  if (!S.session) return;
  const seq = ++thumbSeq, shots = S.session.shots;
  for (const b of $$('#v-session .shot')) {
    if (seq !== thumbSeq || currentView() !== 'session') return;
    const sh = shots[Number(b.dataset.i)], c = $('canvas', b);
    if (c.dataset.done) continue;
    const ok = await Pose.seek(video, sh.swing.keys.contact);
    if (seq !== thumbSeq || currentView() !== 'session') return;
    const x = c.getContext('2d');
    if (ok) x.drawImage(video, 0, 0, c.width, c.height);
    Draw.skeleton(x, G.poseAt(sh.frames, sh.swing.keys.contact).lm, c.width, c.height, { width: 2, hand: S.profile.hand });
    c.dataset.done = '1';
  }
}

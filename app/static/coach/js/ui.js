// 스윙 코치 — 화면 공용 도구: 화면 바꾸기(뒤로 가기 포함), 토스트, 아래에서 올라오는 시트, 저장된 내 정보.
export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── 화면 바꾸기 ─────────────────────────────────────────────────
const VIEWS = ['home', 'setup', 'people', 'working', 'result', 'session', 'physics', 'guide'];
let current = 'home';
const leaveHooks = [];
export function onLeave(fn) { leaveHooks.push(fn); }
export function show(name, { push = true } = {}) {
  if (name !== current) for (const fn of leaveHooks) fn(current, name);
  for (const v of VIEWS) $(`#v-${v}`).hidden = v !== name;
  current = name;
  $('#back').hidden = name === 'home' || name === 'working';
  $('#brand').hidden = name !== 'home' && name !== 'working';
  $('#profileBtn').hidden = name !== 'home';
  document.body.classList.toggle('tabs-on', name === 'home');     // 아래 탭(코트 오픈 ↔ 스윙 코치)은 처음 화면에서만
  if (push) history.pushState({ v: name }, '', name === 'home' ? location.pathname : `#${name}`);
  window.scrollTo(0, 0);
  const head = $(`#v-${name} h1, #v-${name} h2`);                  // 화면이 바뀐 것을 화면 읽기가 알게 제목으로 초점을 옮긴다
  if (head) { head.tabIndex = -1; head.focus({ preventScroll: true }); }
}
export const currentView = () => current;
export function initNav(onBack) {
  history.replaceState({ v: 'home' }, '', location.pathname);
  window.addEventListener('popstate', (e) => {
    const v = (e.state && e.state.v) || 'home';
    onBack(current, v);
  });
  $('#back').addEventListener('click', () => history.back());
}

// ── 토스트 · 시트 ───────────────────────────────────────────────
let toastTimer;
export function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
export function sheet(html, onReady) {
  const host = $('#sheet'), app = $('#app'), opener = document.activeElement;
  host.innerHTML = `<div class="sheet-wrap"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle" tabindex="-1">
    <button type="button" class="sheet-close" aria-label="닫기">닫기</button>${html}</div></div>`;
  const wrap = host.firstElementChild, box = wrap.firstElementChild;
  const title = box.querySelector('h2');
  if (title) title.id = 'sheetTitle';
  if (app) app.inert = true;                                       // 뒤 화면은 읽지도 누르지도 못하게
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    if (!host.firstElementChild) return;
    host.innerHTML = '';
    if (app) app.inert = false;
    document.removeEventListener('keydown', onKey);
    if (opener && opener.isConnected && opener.focus) opener.focus();
  }
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  box.querySelector('.sheet-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  if (onReady) onReady(box, close);
  box.focus();
  return close;
}

/** 여러 개 중 하나 고르는 버튼 줄. opts = [[값, 글자], …] */
export function seg(name, opts, value) {
  return `<div class="seg" data-seg="${esc(name)}">${opts.map(([v, label]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${String(v) === String(value)}">${esc(label)}</button>`).join('')}</div>`;
}
/** seg 줄에 눌림 처리를 건다. onChange(이름, 값) */
export function bindSegs(root, onChange) {
  for (const s of $$('[data-seg]', root)) {
    s.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      for (const x of $$('button', s)) x.setAttribute('aria-pressed', String(x === b));
      onChange(s.dataset.seg, b.dataset.v);
    });
  }
}

// ── 내 정보(기기에만 저장) ──────────────────────────────────────
const KEY = 'coach.profile.v1';
const DEFAULT = { sex: 'U', heightCm: 170, hand: 'R', level: 'mid' };
/** 저장된 값은 그대로 믿지 않는다: 허용 목록·숫자 범위로 다시 맞춘다(화면에 그대로 끼워 넣어도 안전하게). */
export function cleanProfile(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const h = Number(r.heightCm);
  return {
    sex: ['M', 'F', 'U'].includes(r.sex) ? r.sex : DEFAULT.sex,
    heightCm: Number.isFinite(h) && h >= 120 && h <= 220 ? Math.round(h) : DEFAULT.heightCm,
    hand: r.hand === 'L' ? 'L' : 'R',
    level: ['beg', 'mid', 'adv'].includes(r.level) ? r.level : DEFAULT.level,
  };
}
export function loadProfile() {
  try { return cleanProfile(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (_) { return { ...DEFAULT }; }
}
export function saveProfile(p) { try { localStorage.setItem(KEY, JSON.stringify(cleanProfile(p))); } catch (_) { /* 저장을 못 하는 브라우저 */ } }
export const hasProfile = () => { try { return !!localStorage.getItem(KEY); } catch (_) { return false; } };

const REFKEY = 'coach.myrefs.v1';
const nums = (a, n) => Array.isArray(a) && a.length >= n && a.slice(0, n).every((x) => typeof x === 'number' && Number.isFinite(x));
/** 저장해 둔 기준 자세 한 개가 쓸 수 있는 모양인지(깨졌거나 누가 바꿔 놓은 값은 버린다) */
export function validRef(r) {
  return !!r && typeof r === 'object' && ['serve', 'forehand', 'backhand'].includes(r.stroke) && ['trophy', 'contact', 'backswing', 'finish'].includes(r.phase)
    && typeof r.title === 'string' && r.title.length <= 40 && nums(r.feat, 36) && r.feat.length === 36
    && Array.isArray(r.lm) && r.lm.length === 33 && r.lm.every((k) => nums(k, 2))
    && Array.isArray(r.w) && r.w.length === 33 && r.w.every((k) => nums(k, 3));
}
export function loadMyRefs() {
  try { const v = JSON.parse(localStorage.getItem(REFKEY) || '[]'); return Array.isArray(v) ? v.filter(validRef).map((r) => ({ ...r, mine: true, thumb: null })) : []; } catch (_) { return []; }
}
export function saveMyRefs(list) { try { localStorage.setItem(REFKEY, JSON.stringify(list.slice(-60))); return true; } catch (_) { return false; } }

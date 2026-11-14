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
  if (push) history.pushState({ v: name }, '', name === 'home' ? location.pathname : `#${name}`);
  window.scrollTo(0, 0);
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
  const host = $('#sheet');
  host.innerHTML = `<div class="sheet-wrap" role="dialog" aria-modal="true"><div class="sheet">${html}</div></div>`;
  const wrap = host.firstElementChild;
  const close = () => { host.innerHTML = ''; };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  if (onReady) onReady(wrap.firstElementChild, close);
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
export function loadProfile() {
  try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (_) { return { ...DEFAULT }; }
}
export function saveProfile(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (_) { /* 저장을 못 하는 브라우저 */ } }
export const hasProfile = () => { try { return !!localStorage.getItem(KEY); } catch (_) { return false; } };

const REFKEY = 'coach.myrefs.v1';
export function loadMyRefs() { try { const v = JSON.parse(localStorage.getItem(REFKEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
export function saveMyRefs(list) { try { localStorage.setItem(REFKEY, JSON.stringify(list.slice(-60))); return true; } catch (_) { return false; } }

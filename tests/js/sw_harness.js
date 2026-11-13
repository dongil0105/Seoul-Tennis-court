// 서비스워커(app/static/sw.js)를 가짜 브라우저 안에서 돌려 본다 — 실제 푸시 서버에는 접속하지 않는다.
// 사용: node tests/js/sw_harness.js  → 결과를 JSON 한 줄로 출력
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const store = new Map();                       // Cache 'tn-inbox' 대신
const cache = {
  async match(k) { return store.has(k) ? { json: async () => JSON.parse(store.get(k)) } : undefined; },
  async put(k, res) { store.set(k, res.body); },
  async delete(k) { return store.delete(k); },
};
const log = { shown: [], badge: [], posted: [], cleared: 0 };
const handlers = {};
let now = 1_800_000_000_000;
const sandbox = {
  self: {
    addEventListener: (name, fn) => { handlers[name] = fn; },
    skipWaiting() {},
    clients: {
      claim: async () => {},
      matchAll: async () => [{ postMessage: (m) => log.posted.push(m), focus: async () => {} }],
      openWindow: async () => {},
    },
    registration: { showNotification: async (title, opts) => { log.shown.push({ title, body: opts.body, tag: opts.tag }); } },
    navigator: {
      setAppBadge: async (n) => { log.badge.push(n); },
      clearAppBadge: async () => { log.cleared += 1; },
    },
    location: { origin: 'https://example.test' },
  },
  caches: { open: async () => cache },
  Response: class { constructor(body) { this.body = body; } },
  Date: class extends Date { static now() { return now; } },
  URL, Promise, JSON, Math, Number, String, Array, Object, Map, Set, console, setTimeout, atob, Uint8Array, fetch: async () => ({ ok: false }),
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'static', 'sw.js'), 'utf8'), sandbox);

async function push(payload) {
  let done = Promise.resolve();
  handlers.push({ data: { json: () => payload, text: () => JSON.stringify(payload) }, waitUntil: (p) => { done = p; } });
  await done;
}
const inbox = () => (store.has('/__tn_inbox') ? JSON.parse(store.get('/__tn_inbox')) : null);

(async () => {
  const out = {};
  // 1) 전날 알림: 두 곳 → 보관함 2건, 숫자 2
  await push({ title: '한남테니스장 예약 내일 09:00 오픈', body: 'x', badge: 5, items: [
    { area: '한남', place: '한남테니스장', kind: 'd1', key: 'open|2026-11-14 09:00', text: '11.14(토) 09:00 예약 오픈' },
    { area: '반포', place: '반포종합운동장 테니스장', kind: 'd1', key: 'open|2026-11-14 09:00', text: '11.14(토) 09:00 예약 오픈 · 11.21(토) 이용분' }] });
  out.afterD1 = { n: inbox().length, badge: log.badge.at(-1), posted: log.posted.length, shown: log.shown.length };
  // 2) 같은 오픈의 1시간 전 알림 → 한 줄로 합쳐져 여전히 2건
  now += 12 * 36e5;
  await push({ title: 't', body: 'x', badge: 5, items: [
    { area: '한남', place: '한남테니스장', kind: 'h1', key: 'open|2026-11-14 09:00', text: '11.14(토) 09:00 예약 오픈' }] });
  out.afterH1 = { n: inbox().length, badge: log.badge.at(-1), kinds: inbox().map((x) => `${x.area}:${x.kind}`) };
  // 3) 반포 빈 시간 → 3건
  await push({ title: '반포 빈 시간이 생겼어요', body: 'y', badge: 0, items: [
    { area: '반포', place: '반포종합운동장 테니스장', kind: 'free', key: 'free|a', text: '11.16(월) 14~15시 · 3번 코트' }] });
  out.afterFree = { n: inbox().length, badge: log.badge.at(-1) };
  // 4) 항목이 없는 알림(테스트 알림)은 숫자·보관함을 건드리지 않는다
  const badgeCalls = log.badge.length;
  await push({ title: '코트 오픈 알림이 켜졌어요', body: 'z', badge: 0 });
  out.afterTest = { n: inbox().length, badgeCallsSame: log.badge.length === badgeCalls, cleared: log.cleared, shown: log.shown.length };
  // 5) 앱이 보관함을 비운 뒤(앱을 열어 봄) 새 알림 → 다시 1부터
  store.delete('/__tn_inbox');
  await push({ title: 't', body: 'x', items: [{ area: '장충', place: '장충테니스장', kind: 'd1', key: 'open|b', text: '11.20(금) 09:00 예약 오픈' }] });
  out.afterOpen = { n: inbox().length, badge: log.badge.at(-1) };
  // 6) 하루 지난 것은 지운다 · 이상한 항목은 버린다
  now += 25 * 36e5;
  await push({ title: 't', body: 'x', items: [{ area: '한남', kind: 'd1', key: 'k', text: '새 것' }, { text: '' }, null, 'bad', { area: 'x' }] });
  out.afterDay = { n: inbox().length, texts: inbox().map((x) => x.text), badge: log.badge.at(-1) };
  // 7) 보관함이 깨져 있어도 알림은 뜨고 새로 적는다
  store.set('/__tn_inbox', '{not json');
  await push({ title: 't', body: 'x', items: [{ area: '한남', kind: 'd1', key: 'k2', text: '복구' }] });
  out.afterBroken = { n: inbox().length, shown: log.shown.length };
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(e); process.exit(1); });

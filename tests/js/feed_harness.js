// 화면(app/static/dashboard.html)의 '보낸 알림 기록 → 새 알림' 부분만 떼어 가짜 브라우저에서 돌려 본다.
// 서버에는 접속하지 않는다. 사용: node tests/js/feed_harness.js  → 결과를 JSON 한 줄로 출력
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'static', 'dashboard.html'), 'utf8');
const from = html.indexOf('const FRESH_KEEP = ');
const to = html.indexOf('// 그 테니스장 이름 옆에 붙이는 표시');
if (from < 0 || to < from) { console.error('화면에서 새 알림 부분을 찾지 못했어요'); process.exit(1); }
const block = html.slice(from, to);

const T = 1_800_000_000_000;
const MIN = 60000, HOUR = 60 * MIN;
const AREAS = ['한남', '장충', '마루공원', '선우공원', '서울숲'];

function boot({ search = '', store = {}, settings = {}, visible = true } = {}) {
  const clock = { t: T };
  const state = { visible };
  const sandbox = {
    MOCK: null,
    location: { search },
    document: { get visibilityState() { return state.visible ? 'visible' : 'hidden'; } },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    settings: { areas: [...AREAS], d1: true, h1: true, free: false, enabled: false, off: false, ...settings },
    Date: class extends Date { static now() { return clock.t; } },
    URLSearchParams, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  const take = (list) => { sandbox.__list = list; return run('takeFeed(__list)'); };
  const sorted = (field) => JSON.parse(run(`JSON.stringify(fresh.map((x) => x.${field}).sort())`));
  return { run, take, sorted, store, clock, state, n: () => run('fresh.length') };
}

const hannam = (kind, at) => ({ area: '한남', areas: ['한남'], place: '한남테니스장', kind, key: 'open|2026-11-14 09:00', text: '11.14(토) 09:00 예약 오픈', at });
const feed3 = [
  hannam('d1', T - 40 * MIN),
  { area: '반포', areas: ['반포'], place: '반포종합운동장 테니스장', kind: 'd1', key: 'open|2026-11-14 09:00', text: '11.14(토) 09:00 예약 오픈 · 11.21(토) 이용분', at: T - 20 * MIN },
  { area: '반포', areas: ['반포'], place: '반포종합운동장 테니스장', kind: 'free', key: 'free|11.16(월) 14~15시 · 3번 코트', text: '11.16(월) 14~15시 · 3번 코트', at: T - MIN },
];
const out = {};

// 1) 알림을 켜지 않은 기기(기본 설정)
let p = boot();
out.plain = { added: p.take(feed3), areas: p.sorted('area') };
out.plainAgain = { added: p.take(feed3), n: p.n() };
p.run('fresh = []');                                   // 표시가 사라진 뒤(본 지 10분 넘어 다시 엶)
out.afterExpire = { added: p.take(feed3), n: p.n() };
out.seenSaved = Object.keys(JSON.parse(p.store.tn_seen || '{}')).includes('한남|open|2026-11-14 09:00|d1')
  && JSON.parse(p.store.tn_fresh || '[]').length === 1;

// 2) 카카오톡 알림의 링크로 연 브라우저
p = boot({ search: '?k=1' });
out.kakao = { added: p.take(feed3), areas: p.sorted('area'), kinds: p.sorted('kind'), remembered: p.store.tn_all };
p = boot({ store: { tn_all: '1' } });
out.kakaoLater = { showAll: p.run('showAll') };

// 3) 이 기기에서 고른 곳 · 시간만
p = boot({ settings: { enabled: true, areas: ['장충'], d1: false, h1: true, free: true } });
const jang = (kind, at) => ({ area: '장충', areas: ['장충'], place: '장충테니스장', kind, key: 'open|2026-11-14 10:00', text: '11.14(토) 10:00 예약 오픈', at });
out.picked = { added: p.take([...feed3, jang('d1', T - 12 * HOUR), jang('h1', T - 2 * MIN)]), areas: p.sorted('area'), kinds: p.sorted('kind') };

// 4) 앱 알림으로 먼저 받음(서비스워커 보관함 → checkInbox 가 하는 일)
p = boot();
p.run(`fresh.push({area: '한남', place: '한남테니스장', kind: 'd1', key: 'open|2026-11-14 09:00', text: 'x', at: ${T - 40 * MIN + 3000}, seen: 111});
       markSeen({area: '한남', key: 'open|2026-11-14 09:00', kind: 'd1', at: ${T - 40 * MIN + 3000}});`);
out.pushFirst = { added: p.take([hannam('d1', T - 40 * MIN)]), n: p.n(), seen: p.run('fresh[0].seen') };

// 5) 전날 알림 → 1시간 전 알림
p = boot();
p.take([hannam('d1', T - 12 * HOUR)]);
out.hourBefore = { added: p.take([hannam('d1', T - 12 * HOUR), hannam('h1', T - MIN)]), n: p.n(), kind: p.run('fresh[0].kind') };

// 6) 서버가 다시 켜져 같은 알림을 또 보냄
p = boot();
p.take([hannam('d1', T - 3 * HOUR)]);
p.run('fresh = []');
out.resent = { added: p.take([hannam('d1', T - HOUR)]), n: p.n() };

// 7) 24시간 지난 것
p = boot();
out.old = { added: p.take([hannam('d1', T - 25 * HOUR)]), n: p.n() };

// 8) 화면을 안 보고 있을 때
p = boot({ visible: false });
out.hidden = { added: p.take([hannam('d1', T - MIN)]), n: p.n() };
p.state.visible = true;
out.hiddenThenVisible = { added: p.take([hannam('d1', T - MIN)]), n: p.n() };

// 9) 이상한 값
p = boot();
out.garbage = { added: p.take(null) || p.take([null, 'x', { text: '' }, { area: '한남', kind: 'd1', key: 'k', text: '시각 없음' }]), n: p.n() };

console.log(JSON.stringify(out));

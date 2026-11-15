// 화면(app/static/dashboard.html)의 계산 부분(스크립트 처음 ~ MODEL-END)만 떼어 가짜 브라우저에서 돌려 본다.
// 서버에는 접속하지 않는다. 사용: node tests/js/venue_harness.js  → 결과를 JSON 한 줄로 출력
//   node tests/js/venue_harness.js --pretty  → 사람이 읽는 표
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'static', 'dashboard.html'), 'utf8');
const from = html.indexOf("'use strict';");
const to = html.indexOf('/* MODEL-END */');
if (from < 0 || to < from) { console.error('화면에서 계산 부분을 찾지 못했어요'); process.exit(1); }
const block = html.slice(from, to);

function boot(t, search = '') {
  const clock = {t};
  const sandbox = {
    location: {search},
    document: {getElementById: () => null},
    localStorage: {getItem: () => null, setItem: () => {}},
    Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.t); } static now() { return clock.t; } },
    URLSearchParams, URL, Intl, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  const build = (d) => { sandbox.__d = d; return JSON.parse(run('JSON.stringify(buildVenues(__d, nowMs()))')); };
  const sort = (d, key) => { sandbox.__d = d; sandbox.__k = key; return JSON.parse(run('JSON.stringify(sortVenues(buildVenues(__d, nowMs()).list, __k).map((v) => v.area))')); };
  const mock = (kind) => { sandbox.__m = kind; return JSON.parse(run('JSON.stringify(mockBoard(__m))')); };
  return {run, build, sort, mock, clock};
}
const brief = (m) => ({
  list: m.list.map((v) => [v.area, v.now.state, v.now.tone, v.now.title, v.now.sub, v.next.state, v.next.title, v.next.sub, v.next.soon]),
  hot: m.hot.map((x) => [x.area, x.open_at, Boolean(x.expected)]),
  next: m.next ? [m.next.area, m.next.open_at] : null,
});

const out = {};
// 1) 실제 응답(한남 예약이 열린 직후 2026-11-15 09:02:52)
const live = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'board_live_20261115.json'), 'utf8'));
let p = boot(live.now_ms);
const lm = p.build(live);
out.live = brief(lm);
out.liveDetail = Object.fromEntries(lm.list.map((v) => [v.area, {
  hot: v.hot.length, cold: v.cold.length, upcoming: v.upcoming.length,
  avail: v.avail.reduce((n, g) => n + g.courts.length, 0), shut: v.shut.reduce((n, g) => n + g.courts.length, 0),
  past: v.past.length, rule: v.rule, region: v.region, kind: v.kind}]));
out.liveSort = {base: p.sort(live, 'base'), now: p.sort(live, 'now'), soon: p.sort(live, 'soon')};
// 같은 응답을 3시간 뒤에 보면: 오늘 열린 예약은 '오늘 열림'이 아니게 되고(2시간 지남) 09:03 예약도 열려 있다
p = boot(live.now_ms + 3 * 36e5);
out.liveLater = brief(p.build(live));
// 2) 미리보기 자료(기준 시각 2026-11-10 12:00 KST)
const T = Date.UTC(2026, 10, 10, 3, 0, 0);
['opened', 'late', 'next', 'soon', 'none', 'empty', 'notice', 'passed', 'play', 'playfull', 'playerr'].forEach((kind) => {
  const q = boot(T, `?mock=${kind}`);
  out[kind] = brief(q.build(q.mock(kind)));
});
// 3) 이상한 값
p = boot(T);
out.garbage = brief(p.build({openings: [null, {area: '한남', open_at: 'x'}], available: 'no', closed: null, places: [null], play: null}));
out.emptyObj = brief(p.build({}));

if (process.argv.includes('--pretty')) {
  for (const [k, v] of Object.entries(out)) {
    console.log(`\n== ${k}`);
    if (v.list) { v.list.forEach((r) => console.log('  ' + r.join(' | '))); console.log('  hot', JSON.stringify(v.hot), 'next', JSON.stringify(v.next)); }
    else console.log('  ' + JSON.stringify(v));
  }
} else console.log(JSON.stringify(out));

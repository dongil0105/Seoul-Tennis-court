'use strict';
// Codex 가 설계 기준서(docs/REDESIGN_V6.md §4.1 · §4.2 · §10.1)만 보고 쓴 독립 시험 — 구현을 보고 맞춘 기대값이 아니다.
// 가져오면서 바꾼 것: 파일 위치 2곳, 그리고 검토 2 뒤에 기준서 문구가 바뀐 두 곳(상시 예약의 작은 글자 · 잠시 멈춤).
// 2026-11-15 테니스장 두 곳 추가(잠원 · 대치유수지): 고정 목록(areas)을 7곳으로, '몇 번째' 대신 이름으로 찾게 바꿨다(기대값은 그대로).
// Independent expectations: REDESIGN_V6.md §§4.1, 4.2, 10.1.
// No network, DOM, dependencies, or writes. Run with Node 20+ from any directory.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const util = require('node:util');
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'static', 'dashboard.html'), 'utf8');
const start = html.indexOf("'use strict';"), end = html.indexOf('/* MODEL-END */', start);
assert.ok(start >= 0 && end > start, 'DOM-free model markers');
const block = html.slice(start, end);
const ms = s => Date.parse(s.replace(' ', 'T') + '+09:00');
const T = ms('2026-11-15 09:00');
const H = 3600000, DAY = 24 * H;
const areas = ['대치유수지', '마루공원', '서울숲', '선우공원', '잠원', '장충', '한남'];   // 화면 순서 = 가나다순(2026-11-15 사용자 의견)
function boot(t = T) {
  const ctx = vm.createContext({
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [t])); } static now() { return t; } },
    location: {search: ''}, URL, URLSearchParams, Intl, console,
    document: {getElementById: () => null}, localStorage: {getItem: () => null, setItem() {}}
  });
  vm.runInContext(block, ctx, {timeout: 2000});
  return (expression, input) => {
    ctx.input = input;
    return JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, ctx, {timeout: 2000}));
  };
}
const build = (d, t = T) => boot(t)('buildVenues(input, nowMs())', d);
const hannam = m => m.list.find(v => v.area === '한남');   // 순서가 가나다순이 되어 자리(0번)가 아니라 이름으로 찾는다
const venue = (d, t = T) => hannam(build(d, t));
const court = (name = '1번', extra = {}) => ({court: name, reserve_url: `https://yeyak.seoul.go.kr/${name}`, ...extra});
const group = (courts = [court()], extra = {}) => ({area: '한남', until_kind: 'use', courts, ...extra});
const opening = (at = '2026-11-15 09:00', extra = {}) => ({area: '한남', open_at: at, courts: [court()], ...extra});
const cell = (state, tone, title, sub) => ({state, tone, title, sub});
const unknown = (sub = '일정이 아직 없어요') => ({state: 'unknown', title: '아직 몰라요', sub, soon: false});
const always = {state: 'always', title: '따로 없음', sub: '정해진 날이 없어요', soon: false};
const date = (title, sub, soon) => ({state: 'date', title, sub, soon});
const nextBrief = n => ({state: n.state, title: n.title, sub: n.sub, soon: n.soon});
const openBrief = x => x ? [x.area, x.open_at, !!x.expected] : null;
let total = 0, failed = 0;
function test(name, actual, expected) {
  total++;
  try { assert.deepStrictEqual(actual(), expected); }
  catch (e) {
    failed++;
    console.log(`FAIL ${name}\n  expected: ${util.inspect(expected, {depth: 8, breakLength: Infinity})}\n  actual:   ${e instanceof assert.AssertionError ? util.inspect(e.actual, {depth: 8, breakLength: Infinity}) : `THREW ${e.name}: ${e.message}`}`);
  }
}
const live = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'board_live_20261115.json'), 'utf8'));
// Hand-counted physical courts from the fixture: Hannam 1–6,8–12 = 11;
// Maru 1–3 with light variants = 3. Expected text is specified, not snapshotted.
for (const later of [false, true]) {
  const t = live.now_ms + (later ? 3 * H : 0), tag = later ? 'live+3h' : 'live';
  const nowCells = [
    later ? cell('check', 'warn', '확인 필요', '예약 화면에서 확인') : cell('hot', 'go', '오늘 열림', '09:00 시작 · 코트 11개'),
    cell('open', 'go', '예약 받는 중', '코트 2개'), cell('open', 'go', '예약 받는 중', '코트 3개'),
    cell('open', 'go', '예약 받는 중', '코트 1개'), cell('open', 'go', '예약 받는 중', '예약 1건'),
    cell('free', 'go', '빈 시간 있음', '11.17(화) 14~15시')
  ];
  const nx = [
    later ? unknown('지난번 11.15(일) 09:00') : date('오늘 09:03', '8초 남음', true),
    date('11.25(수) 10:00', '10일 남음 · 공지 일정', false), always,
    unknown('지난번 10.27(화) 09:30'), date('12.1(화) 09:01', '16일 남음', false),
    date('내일 09:00', later ? '20시간 58분 남음' : '23시간 58분 남음', true)
  ];
  ['한남', '장충', '마루공원', '선우공원', '서울숲', '반포'].forEach((a, i) => {
    test(`${tag}/${a}/now`, () => build(live, t).list.find(v => v.area === a).now, nowCells[i]);
    test(`${tag}/${a}/next`, () => nextBrief(build(live, t).list.find(v => v.area === a).next), nx[i]);
  });
  test(`${tag}/hot`, () => build(live, t).hot.map(openBrief), later ? [] : [['한남', '2026-11-15 09:00', false]]);
  test(`${tag}/next`, () => openBrief(build(live, t).next), later ? ['장충', '2026-11-25 10:00', true] : ['한남', '2026-11-15 09:03', false]);
}
for (const [offset, hot] of [[2 * H - 1, true], [2 * H, false]]) {
  test(`hot boundary ${offset}`, () => {
    const v = venue({openings: [opening()]}, T + offset);
    return [v.hot.length, v.cold.length, v.now.state];
  }, hot ? [1, 0, 'hot'] : [0, 1, 'none']);
}
test('opened inferred from time', () => venue({openings: [opening(undefined, {opened: false})]}).now.state, 'hot');
test('server opened flag is respected', () => venue({openings: [opening('2026-11-15 10:00', {opened: true})]}).hot.length, 1);
for (const available of [false, true]) {
  const d = {openings: [opening('2026-11-15 08:00', {expected: true, courts: []})],
    closed: [group([court('2번', {state: 'ended'})])], available: available ? [group()] : []};
  test(`notice recent ${available}/now`, () => venue(d).now, available ? cell('open', 'go', '예약 받는 중', '코트 1개') : cell('check', 'warn', '확인 필요', '08:00 공지 시각 지남'));
  test(`notice recent ${available}/fallback courts`, () => venue(d).hot[0].courts.map(c => c.court), ['2번']);
}
for (const age of [2 * H, 2 * H + 1, 3 * H]) {
  test(`notice expires ${age}`, () => {
    const m = build({openings: [opening(undefined, {expected: true})]}, T + age);
    return [m.hot.length, hannam(m).cold.length, hannam(m).now.state];
  }, [0, 0, 'none']);
}
test('dedupe strips display only', () => {
  const c = court();
  const v = venue({openings: [opening(undefined, {expected: true})], available: [group([c])], closed: [group([c], {state: 'ended'})]});
  return [v.now, v.avail.length, v.shut.length];
}, [cell('open', 'go', '예약 받는 중', '코트 1개'), 0, 0]);
test('real hot dedupe both lists', () => {
  const c = court(), v = venue({openings: [opening()], available: [group([c])], closed: [group([c], {state: 'unknown'})]});
  return [v.now, v.avail.length, v.shut.length];
}, [cell('hot', 'go', '오늘 열림', '09:00 시작 · 코트 1개'), 0, 0]);
const states = [
  ['wait', {openings: [opening('2026-11-16 09:00')]}, cell('wait', 'off', '예약 시작 전', '열리는 날을 기다려요')],
  ['none', {}, cell('none', 'off', '정보 없음', '올라온 예약이 없어요')],
  ['full', {closed: [group([court(), court('1번 조명'), court('2번')], {state: 'full'})]}, cell('full', 'off', '모두 마감', '코트 2개')],
  ['ended', {closed: [group(undefined, {state: 'ended'})]}, cell('ended', 'off', '예약 끝남', '다음 오픈을 기다려요')],
  ['paused', {closed: [group(undefined, {state: 'paused'})]}, cell('paused', 'off', '잠시 멈춤', '시설 사정으로 멈췄어요')],
  ['closed', {closed: [group([court('1번', {state: 'ended'}), court('2번', {state: 'paused'})])]}, cell('closed', 'off', '예약 안 받는 중', '다음 오픈을 기다려요')],
  ['unknown', {closed: [group([court('1번', {state: 'unknown'})], {state: 'full'})]}, cell('check', 'warn', '확인 필요', '예약 화면에서 확인')],
  ['full overrides ended', {closed: [group([court('1번', {state: 'full'}), court('2번', {state: 'ended'})])]}, cell('full', 'off', '모두 마감', '코트 1개')]
];
states.forEach(([n, d, expected]) => test(`state/${n}`, () => venue(d).now, expected));
for (const [names, expected] of [
  [['1면', '1면 조명', '2면', '2면 조명'], '코트 2개'], [['A', 'A 조명', 'B'], '코트 2개'],
  [['1번', '1번', '2번'], '코트 2개'], [['코트', '1번'], '예약 2건'], [['코트'], '예약 1건'], [[], '']
]) test(`courtsLabel/${names.join(',')}`, () => boot()('courtsLabel(input)', names.map(n => court(n))), expected);
for (const [at, title, sub, soon] of [
  ['2026-11-15 09:03', '오늘 09:03', '3분 00초 남음', true],
  ['2026-11-16 09:00', '내일 09:00', '1일 남음', false],
  ['2026-11-25 10:00', '11.25(수) 10:00', '10일 남음', false]
]) test(`next/${at}`, () => nextBrief(venue({openings: [opening(at)]}).next), date(title, sub, soon));
for (const offset of [DAY - 1, DAY, DAY + 1]) test(`soon boundary ${offset}`, () => venue({openings: [opening('2026-11-16 09:00')]}, T + DAY - offset).next.soon, offset < DAY);
for (const source of ['available', 'closed']) test(`always/${source}`, () => nextBrief(venue({[source]: [group(undefined, {until_kind: '', state: 'full'})]}).next), always);
test('past always group excluded', () => nextBrief(venue({closed: [group(undefined, {until_kind: '', past: true})]}).next), unknown());
test('unknown with past', () => nextBrief(venue({places: [{area: '한남', past_opens: ['bad', '2026-10-27 09:30']}]}).next), unknown('지난번 10.27(화) 09:30'));
test('unknown without past', () => nextBrief(venue({}).next), unknown());
const slot = (s, e) => ({s, e, courts: ['1번']});
const play = (days, extra = {}) => ({ok: true, days, ...extra});
const day = (date, slots = []) => ({date, slots});
const pv = (p, t = T) => build({play: p}, t).list.find(v => v.area === '반포');
for (const [name, p, expected] of [
  ['free contiguous', play([day('2026-11-15', [slot(20, 21), slot(21, 22)])]), cell('free', 'go', '빈 시간 있음', '오늘 20~22시')],
  ['free ranges', play([day('2026-11-15', [slot(14, 15), slot(20, 22)])]), cell('free', 'go', '빈 시간 있음', '오늘 14~15시 외')],
  ['free days', play([day('2026-11-15', [slot(20, 22)]), day('2026-11-16', [slot(6, 7)])]), cell('free', 'go', '빈 시간 있음', '오늘 20~22시 외')],
  ['stale', play([day('2026-11-15', [slot(20, 22)])], {stale: true}), cell('free', 'warn', '빈 시간 있음', '오래된 정보 · 오늘 20~22시')],
  ['full', play([day('2026-11-15'), day('2026-11-22')]), cell('full', 'off', '빈 시간 없음', '11.15~11.22 확인')],
  ['loading', {ok: false, state: 'loading'}, cell('loading', 'off', '불러오는 중', '잠시 뒤 다시 열어 주세요')],
  ['error', {ok: false, state: 'error'}, cell('error', 'off', '확인 못 함', '테니스플레이에서 확인')],
  ['unsorted earliest', play([day('2026-11-16', [slot(20, 22)]), day('2026-11-15', [slot(14, 15)])]), cell('free', 'go', '빈 시간 있음', '오늘 14~15시 외')]
]) test(`play/${name}`, () => pv(p).now, expected);
for (const [at, expected] of [
  ['2026-11-15 08:59', unknown()], ['2026-11-15 09:00', unknown()],
  ['2026-11-15 09:03', date('오늘 09:03', '3분 00초 남음', true)]
]) test(`play/next ${at}`, () => nextBrief(pv(play([], {next_open: {at, date: '2026-11-22'}})).next), expected);
// §4.2 requires only a future at, not a second date field.
test('play/next future at without use date', () => nextBrief(pv(play([], {next_open: {at: '2026-11-16 09:00'}})).next), date('내일 09:00', '1일 남음', false));
test('missing play', () => build({}).list.map(v => v.area), areas);
for (const [name, d] of [
  ['null', null], ['undefined', undefined], ['empty', {}], ['nonarrays', {openings: {}, available: 'x', closed: 12, places: false}],
  ['null entries', {openings: [null], available: [null], closed: [null], places: [null]}],
  ['bad dates', {openings: [opening('bad'), opening('2026-99-99 25:99')], places: [{area: '한남', past_opens: [null, 'bad']}]}],
  ['bad courts', {available: [group(null), group('bad')], closed: [group([null])]}],
  ['impossible date', {openings: [opening('2026-11-31 09:00')]}]
]) {
  test(`garbage/${name}/fixed venues`, () => build(d).list.map(v => v.area), areas);
  test(`garbage/${name}/ignore bad openings`, () => build(d).next, null);
}
test('day rollover excludes yesterday', () => {
  const m = build({openings: [opening('2026-11-14 23:30', {opened: true})]}, ms('2026-11-15 00:01'));
  return [m.hot.length, hannam(m).cold.length, hannam(m).now.state];
}, [0, 0, 'none']);
// Synthetic venue list makes sort testing independent of buildVenues.
const sortList = [
  {area: 'a', now: {state: 'none', tone: 'off'}, next: {state: 'unknown'}},
  {area: 'b', now: {state: 'open', tone: 'go'}, next: {state: 'date', at: '2026-11-16 09:00'}},
  {area: 'c', now: {state: 'hot', tone: 'go'}, next: {state: 'always'}},
  {area: 'd', now: {state: 'check', tone: 'warn'}, next: {state: 'date', at: '2026-11-15 10:00'}},
  {area: 'e', now: {state: 'open', tone: 'go'}, next: {state: 'date', at: '2026-11-16 09:00'}},
  {area: 'f', now: {state: 'none', tone: 'off'}, next: {state: 'unknown'}}
];
for (const [key, expected] of [['base', ['a', 'b', 'c', 'd', 'e', 'f']], ['now', ['c', 'b', 'e', 'd', 'a', 'f']], ['soon', ['d', 'b', 'e', 'a', 'c', 'f']]]) {
  test(`sort/${key}`, () => boot()(`sortVenues(input, '${key}').map(v=>v.area)`, sortList), expected);
}
test('sort does not mutate input', () => boot()("(sortVenues(input, 'now'), input.map(v=>v.area))", sortList), ['a', 'b', 'c', 'd', 'e', 'f']);
console.log(failed ? `FAIL ${failed}/${total}` : `PASS ${total}`);
process.exitCode = failed ? 1 : 0;

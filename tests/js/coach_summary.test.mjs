// 스윙 코치 — 종합 판단(summary.js)과 높이를 몸으로 느끼는 말(reach.js) 테스트.
//   node --test tests/js/coach_summary.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, countText, spreadText, baseTitle, gradeOf, dropServePrep } from '../../app/static/coach/js/summary.js';
import * as R from '../../app/static/coach/js/reach.js';

const item = (id, value, extra = {}) => ({ id, label: extra.label || id, sev: extra.sev ?? 2, weight: extra.weight ?? 2.5, side: 'low', value,
  title: `${extra.title || id} — 약 ${Math.round(value)}cm 더 앞에서`, cue: `${id} 고치는 법`, why: `${id} 이유` });
const shot = (stroke, score, items = [], more = {}) => ({ vid: more.vid ?? 0,
  m: { stroke, twoHanded: !!more.twoHanded, vis: more.vis ?? 0.9, view: more.view || 'side', contactFront: more.front, contactFrontFoot: more.front, wristHeightGround: more.height },
  a: { score, grade: '', items, good: (more.good || []).map((label) => ({ label })) } });

test('되풀이되는 문제가 가장 먼저 고칠 것으로 올라온다', () => {
  const shots = [
    ...[10, 12, 15, 14, 11, 9, 13, 16].map((v) => shot('forehand', 70, [item('fh_contact_front', v, { title: '타점이 늦어요', label: '타점 앞뒤', sev: 3, weight: 4 })], { good: ['어깨 턴'] })),
    ...[1, 2, 3, 4].map(() => shot('forehand', 90, [], { good: ['어깨 턴', '무릎 굽힘'] })),
    shot('serve', 60, [item('serve_knee', 12, { label: '무릎 굽힘' })]),
    shot('serve', 85, []),
    shot('serve', 88, []),
  ];
  const s = summarize(shots);
  assert.equal(s.n, 15);
  assert.deepEqual(s.kinds.map((k) => [k.kind, k.n]), [['serve', 3], ['forehand', 12]]);
  const p = s.priorities[0];
  assert.equal(p.id, 'fh_contact_front');
  assert.equal(p.n, 8); assert.equal(p.of, 12);
  assert.equal(p.title, '타점이 늦어요');                         // 샷마다 다른 cm 꼬리는 뗀다
  assert.equal(countText(p), '포핸드 12개 중 8개에서');
  assert.ok([12, 13].includes(p.item.value), '대표 항목은 가운데값');
  assert.ok(!s.priorities.some((x) => x.id === 'serve_knee'), '3개 중 1개에서만 나온 것은 되풀이가 아니다');
  const fh = s.kinds.find((k) => k.kind === 'forehand');
  assert.ok(fh.strengths.some((x) => x.label === '어깨 턴'));     // 12개 모두에서 좋음
  assert.ok(!fh.strengths.some((x) => x.label === '무릎 굽힘'));  // 12개 중 4개뿐
  assert.equal(fh.avg, Math.round((8 * 70 + 4 * 90) / 12));
  assert.equal(fh.best.length, 2); assert.equal(fh.worst.length, 2);
  assert.ok(shots[fh.best[0]].a.score >= shots[fh.worst[0]].a.score);
  assert.equal(s.grade, gradeOf(s.score));
});

test('샷이 하나뿐인 종류는 그 샷의 조언을 그대로 쓴다', () => {
  const s = summarize([shot('serve', 72, [item('serve_toss_arm', -0.1, { label: '토스한 팔', sev: 3, weight: 5 })]), shot('forehand', 80, []), shot('forehand', 82, [])]);
  assert.equal(s.priorities[0].id, 'serve_toss_arm');
  assert.equal(countText(s.priorities[0]), '서브에서');
});

test('점수를 못 매긴 샷은 평균과 되풀이 집계에서 뺀다', () => {
  const s = summarize([shot('forehand', null, [item('fh_turn', 30)]), shot('forehand', null, [item('fh_turn', 35)]), shot('forehand', 80, [])]);
  assert.equal(s.score, 80);
  assert.equal(s.rated, 1);
  assert.equal(s.priorities.length, 0);
  assert.equal(summarize([shot('serve', null, [])]).score, null);
});

test('한 종류에서 많아야 두 개, 모두 합쳐 세 개까지', () => {
  const many = ['a', 'b', 'c', 'd'].map((id) => item(`fh_${id}`, 10));
  const s = summarize([...[1, 2, 3].map(() => shot('forehand', 60, many)), ...[1, 2].map(() => shot('backhand', 65, [item('bh2_turn', 40)], { twoHanded: true }))]);
  assert.equal(s.priorities.length, 3);
  assert.equal(s.priorities.filter((p) => p.kind === 'forehand').length, 2);
  assert.ok(s.priorities.some((p) => p.kind === 'backhand'));
});

test('영상 여러 개의 샷을 한데 모은다', () => {
  const s = summarize([shot('serve', 80, [], { vid: 0 }), shot('serve', 70, [], { vid: 1 }), shot('forehand', 75, [], { vid: 2 })]);
  assert.equal(s.videos, 3);
  assert.equal(s.kinds.find((k) => k.kind === 'serve').n, 2);
});

test('타점이 일정한지 한 줄로 말한다', () => {
  const steady = summarize([0.2, 0.21, 0.19, 0.2].map((f) => shot('forehand', 80, [], { front: f, height: 0.55 }))).kinds[0];
  assert.match(spreadText(steady, 170), /타점 앞뒤가 일정해요/);
  const wild = summarize([0.05, 0.3, 0.12, 0.38].map((f) => shot('forehand', 80, [], { front: f, height: 0.55 }))).kinds[0];
  assert.match(spreadText(wild, 170), /타점 앞뒤가 샷마다 \d+cm쯤 흔들려요/);
  // 점수를 못 매긴(흐린) 샷은 흔들림 계산에 넣지 않는다
  const blurry = summarize([0.05, 0.3, 0.12, 0.38].map((f) => shot('forehand', null, [], { front: f, height: 0.55 }))).kinds[0];
  assert.equal(spreadText(blurry, 170), null);
  assert.equal(spreadText(summarize([shot('forehand', 80, [])]).kinds[0], 170), null);   // 잰 값이 모자라면 말하지 않는다
  assert.equal(baseTitle('타점이 늦어요 — 약 15cm 더 앞에서'), '타점이 늦어요');
});

// ── 높이를 몸으로 느끼는 말 ──────────────────────────────────────
test('키 → 리치: 키 170cm 면 리치 약 243cm', () => {
  assert.equal(R.reachOf(170).reach, 243);
  assert.ok(R.reachOf(180).reach - R.reachOf(170).reach >= 11);      // 키 10cm 에 리치 11~12cm
  const c = R.serveContact(1.08, 170);                               // 손목이 키의 1.08배 높이
  assert.equal(c.ball, 231); assert.equal(c.diff, -12);
  assert.equal(c.text, '리치보다 12cm 낮음');
  assert.equal(R.reachDiffText(2), '리치 높이 그대로');
  assert.equal(R.reachDiffText(9), '리치보다 9cm 높음');
});

test('서브 종류별 타점: 높이는 플랫 ≥ 슬라이스 ≥ 킥, 플랫이 가장 앞', () => {
  const [flat, slice, kick] = R.serveTargets(170, 'R');
  assert.deepEqual([flat.type, slice.type, kick.type], ['flat', 'slice', 'kick']);
  assert.ok(flat.height[0] >= slice.height[0] && slice.height[0] >= kick.height[0]);
  assert.ok(flat.front[1] > slice.front[1] && slice.front[1] > kick.front[1]);
  assert.match(slice.where, /오른쪽/); assert.match(kick.where, /왼쪽/);
  assert.match(R.serveTargets(170, 'L')[1].where, /왼쪽/);            // 왼손잡이는 좌우가 반대
});

test('네트 위 틈: 빠를수록 좁고, 타점이 높을수록·회전이 많을수록 넓다', () => {
  const g = (o) => R.serveGap({ contactCm: 243, speedKmh: 130, type: 'flat', ...o });
  const base = g({});
  assert.ok(base.ok && base.gapCm > 15 && base.gapCm < 70, `130km/h 플랫의 틈 ${base.gapCm}cm`);
  assert.ok(Math.abs(base.balls - base.gapCm / 6.7) < 0.2);
  assert.ok(g({ speedKmh: 160 }).gapCm < base.gapCm);
  assert.ok(g({ speedKmh: 100 }).gapCm > base.gapCm);
  assert.ok(g({ contactCm: 253 }).gapCm > base.gapCm);
  assert.ok(g({ type: 'kick' }).gapCm > g({ type: 'slice' }).gapCm && g({ type: 'slice' }).gapCm > base.gapCm);
  assert.equal(R.gapSay(1.5), '아주 빠듯'); assert.equal(R.gapSay(9), '넉넉');
  const none = R.serveGap({ contactCm: 150, speedKmh: 200, type: 'flat' });
  assert.ok(!none.ok || none.balls < 1);
});

test('스트로크: 몸 높이 말과, 느릴수록 네트 위로 높이 넘겨야 깊이 간다', () => {
  assert.equal(R.bodyLevel(0.3), '무릎 높이'); assert.equal(R.bodyLevel(0.55), '허리 높이');
  assert.equal(R.bodyLevel(0.7), '가슴 높이'); assert.equal(R.bodyLevel(0.84), '어깨 높이'); assert.equal(R.bodyLevel(NaN), '');
  const t = R.groundTargets(170);
  assert.deepEqual(t.height, [85, 120]);
  assert.ok(t.front.backhand1[0] > t.front.forehand[0] && t.front.forehand[0] > t.front.backhand2[0]);   // 원핸드가 가장 앞, 투핸드가 가장 몸 쪽
  const slow = R.groundClearance({ speedKmh: 70 }), fast = R.groundClearance({ speedKmh: 110 });
  assert.ok(slow.deepM > fast.deepM && slow.deepM > 2, `70km/h 는 네트 위 ${slow.deepM}m`);
  assert.ok(slow.deepM > slow.midM && slow.midM > slow.shortM);
  assert.match(R.netsText(slow.deepNets), /네트 높이의 [\d.]+배쯤/);
  assert.equal(R.netsText(1), '네트 하나 높이쯤');
});

// ── 한 사람 영상인지, 누구를 고르게 할지 ─────────────────────────
test('사람 판별: 한 사람 영상 / 뒤에 작게 지나가는 사람 / 경기 영상', async () => {
  const { mainPeople } = await import('../../app/static/coach/js/track.js');
  const g = (count, size, name) => ({ count, size, name, color: [0, 0, 0], sample: {} });
  assert.deepEqual(mainPeople([], 0), { people: [], single: true });
  // 한 사람만 꾸준히 나옴
  assert.equal(mainPeople([g(12, 0.7, '나')], 12).single, true);
  // 주인공이 크게 나오고 뒤 코트 사람은 절반도 안 되는 크기 → 묻지 않는다
  const bg = mainPeople([g(12, 0.7, '나'), g(9, 0.2, '뒤 코트')], 12);
  assert.equal(bg.single, true); assert.equal(bg.people.length, 1);
  // 잠깐 지나간 사람(12번 중 1번)은 세지 않는다
  assert.equal(mainPeople([g(12, 0.5, '나'), g(1, 0.5, '지나감')], 12).single, true);
  // 복식: 비슷한 크기의 두 사람 → 고르게 한다
  const dbl = mainPeople([g(12, 0.5, 'A'), g(11, 0.45, 'B')], 12);
  assert.equal(dbl.single, false); assert.equal(dbl.people.length, 2);
  // 멀리서 찍은 경기 영상: 모두 작게 나오면 건너편 선수도 고를 수 있다
  const match = mainPeople([g(12, 0.3, '가까운 쪽'), g(10, 0.12, '건너편')], 12);
  assert.equal(match.single, false); assert.deepEqual(match.people.map((p) => p.name), ['가까운 쪽', '건너편']);
  // 카메라가 움직이는 영상: 크게 나온 사람이 있어도 계속 나오지 않으면(12번 중 2번) 주인공으로 단정하지 않고 고르게 한다
  const pan = mainPeople([g(2, 0.49, '앞에 지나간 사람'), g(2, 0.21, '선수 A'), g(2, 0.14, '선수 B'), g(1, 0.3, '한 번')], 12);
  assert.equal(pan.single, false); assert.deepEqual(pan.people.map((p) => p.name), ['앞에 지나간 사람', '선수 A', '선수 B']);
  // 누구도 두 번 이상 안 나오면 본 사람 모두를 후보로
  assert.equal(mainPeople([g(1, 0.3, 'a'), g(1, 0.2, 'b')], 6).people.length, 2);
  // 많아야 여섯 명
  assert.equal(mainPeople(Array.from({ length: 9 }, (_, i) => g(12, 0.3, `p${i}`)), 12).people.length, 6);
});

test('서브 준비 동작이 스트로크로 잡힌 것은 뺀다', () => {
  const sh = (stroke, tc, vid = 0, sf = 1) => ({ vid, m: { stroke }, swing: { tc, sf } });
  const kept = dropServePrep([sh('forehand', 7.3), sh('serve', 9.6), sh('forehand', 10.2), sh('forehand', 12.5), sh('backhand', 3.0), sh('forehand', 8.0, 1)]);
  assert.deepEqual(kept.map((s) => `${s.vid}:${s.m.stroke}@${s.swing.tc}`), ['0:serve@9.6', '0:forehand@12.5', '0:backhand@3', '1:forehand@8']);
  // 서브가 없으면 그대로, 슬로모션(4배)이면 창도 4배
  assert.equal(dropServePrep([sh('forehand', 1), sh('backhand', 2)]).length, 2);
  assert.equal(dropServePrep([sh('forehand', 10), sh('serve', 20, 0, 4)]).length, 1);
  assert.equal(dropServePrep([sh('forehand', 5), sh('serve', 20, 0, 4)]).length, 2);
  // 준비 동작이 머리 위 동작(서브·스매시)으로 잡힌 것도 뺀다: 서브 3초 안쪽 앞, 손목 속도가 그 서브의 0.8배 미만
  const ov = (tc, peak, sub = null) => ({ vid: 0, m: { stroke: 'serve', sub }, swing: { tc, sf: 1, peak } });
  assert.deepEqual(dropServePrep([ov(7.2, 7.2, 'smash'), ov(9.6, 10.4)]).map((s) => s.swing.tc), [9.6]);
  // 속도가 비슷한 머리 위 스윙이 이어지면(스매시 연습) 둘 다 남는다. 3초보다 떨어져 있어도 남는다
  assert.equal(dropServePrep([ov(7.2, 9.5, 'smash'), ov(9.6, 10.4, 'smash')]).length, 2);
  assert.equal(dropServePrep([ov(2.0, 5.0), ov(9.6, 10.4)]).length, 2);
});

test('방향이 반대인 문제는 한데 합치지 않는다(늦은 타점 / 너무 앞선 타점)', () => {
  const late = (v) => ({ ...item('fh_contact_front', v, { title: '타점이 늦어요', label: '타점 앞뒤', sev: 3, weight: 4 }), side: 'low' });
  const early = (v) => ({ ...item('fh_contact_front', v, { title: '타점이 너무 앞이에요', label: '타점 앞뒤', sev: 3, weight: 4 }), side: 'high' });
  const s = summarize([shot('forehand', 70, [late(2)]), shot('forehand', 70, [late(4)]), shot('forehand', 70, [early(60)]), shot('forehand', 70, [early(65)])]);
  const ps = s.kinds[0].patterns.filter((p) => p.id === 'fh_contact_front');
  assert.equal(ps.length, 2);
  assert.deepEqual(ps.map((p) => [p.side, p.n, p.of]).sort(), [['high', 2, 4], ['low', 2, 4]]);
  assert.ok(ps.every((p) => (p.side === 'low' ? p.title === '타점이 늦어요' : p.title === '타점이 너무 앞이에요')));
});

test('평균에 쓴 샷 수를 따로 알려 준다(흐린 샷은 평균에서 빠질 수 있다)', () => {
  const s = summarize([shot('serve', 90, [], { vis: 0.9 }), shot('serve', 88, [], { vis: 0.9 }), shot('serve', 40, [], { vis: 0.3 })]);
  assert.equal(s.score, 89); assert.equal(s.scored, 2); assert.equal(s.rated, 3);
});

test('한 사람 영상의 따라가기: 색을 못 읽어도 방금 있던 자리의 사람을 이어서 본다', async () => {
  const { pickSingle } = await import('../../app/static/coach/js/track.js');
  const person = (cx, cy, h = 0.5) => { const lm = Array.from({ length: 33 }, () => [cx, cy, 0, 1]); lm[0] = [cx, cy - h / 2, 0, 1]; lm[31] = [cx, cy + h / 2, 0, 1]; return { lm }; };
  const st = { color: [200, 30, 30], sizeRef: 0.5 };
  assert.equal(pickSingle([person(0.5, 0.5)], [[200, 30, 30]], st, 0), 0);            // 옷 색으로 찾음
  // 색을 못 읽은 화면: 방금 있던 자리(0.5)에 가까운 사람을 고른다 — 앞을 지나가는 큰 사람(0.9)이 아니라
  assert.equal(pickSingle([person(0.9, 0.5, 0.9), person(0.52, 0.5)], [null, null], st, 0.1), 1);
  // 처음부터 색을 못 읽었고 두 명이면 아무도 고르지 않는다(가장 큰 사람을 덥석 잡지 않는다)
  assert.equal(pickSingle([person(0.2, 0.5, 0.9), person(0.7, 0.5)], [null, null], { color: [200, 30, 30] }, 0), -1);
  // 한 명뿐이면 그 사람
  assert.equal(pickSingle([person(0.3, 0.5)], [null], { color: [200, 30, 30] }, 0), 0);
  assert.equal(pickSingle([], [], st, 0.2), -1);
});

// ── 화면 모듈 문법 검사 ─────────────────────────────────────────
// app.js 처럼 화면(DOM)이 있어야 도는 모듈은 여기서 불러올 수 없어서, 문법만이라도 모듈로 읽어 확인한다.
// (같은 이름을 두 번 선언하는 실수는 브라우저에서만 드러나 화면 전체가 멈춘다.)
test('화면 모듈이 모두 문법 오류 없이 읽힌다', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const dir = new URL('../../app/static/coach/js/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('app.js') && files.length >= 12);
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: readFileSync(new URL(f, dir)), encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${String(r.stderr).split('\n').slice(0, 6).join(' ')}`);
  }
});

// ── 공 속도 예측 ────────────────────────────────────────────────
test('공 속도 예측: 손목이 빠를수록 빠르고, 범위와 함께 돌려준다', async () => {
  const { estimateSpeed, frameGain, speedSummary, benchmarks, shotSpeed } = await import('../../app/static/coach/js/speed.js');
  const base = { stroke: 'serve', serveType: 'flat', peak: 10, bodyH: 1.7, heightCm: 170, sf: 1, sfAuto: false, step: 1 / 60, vis: 0.9, view: 'side' };
  const e = estimateSpeed(base);
  assert.ok(e.ok);
  assert.ok(e.kmh >= 90 && e.kmh <= 125, `손목 10m/s 서브 → ${e.kmh}km/h`);           // 동호인 서브 범위
  assert.ok(e.lo < e.kmh && e.kmh < e.hi && e.kmh % 5 === 0);
  assert.equal(e.pct, 25);
  assert.ok(estimateSpeed({ ...base, peak: 14 }).kmh > e.kmh);
  // 같은 스윙이면 플랫 > 슬라이스 > 킥
  const sl = estimateSpeed({ ...base, serveType: 'slice' }).kmh, kk = estimateSpeed({ ...base, serveType: 'kick' }).kmh;
  assert.ok(e.kmh > sl && sl > kk);
  // 키가 크면 같은 화면 속도라도 실제 속도가 빠르다(모델 키 대비 환산)
  assert.ok(estimateSpeed({ ...base, heightCm: 190 }).kmh > e.kmh);
  // 포핸드: 손목 7m/s 는 동호인 포핸드 범위
  const f = estimateSpeed({ ...base, stroke: 'forehand', peak: 7 });
  assert.ok(f.ok && f.kmh >= 55 && f.kmh <= 80, `손목 7m/s 포핸드 → ${f.kmh}km/h`);
  // 프로 수준 손목 속도(14.5m/s) 포핸드는 프로 평균(117~126) 근처
  const pro = estimateSpeed({ ...base, stroke: 'forehand', peak: 14, step: 1 / 60 });
  assert.ok(pro.kmh >= 110 && pro.kmh <= 140, `손목 14m/s 포핸드 → ${pro.kmh}km/h`);
  // 옆에서 찍지 않았으면 범위를 넓힌다
  assert.equal(estimateSpeed({ ...base, view: 'behind' }).pct, 30);
  // 프레임 간격이 길면 뭉개진 만큼 올려 잡는다
  assert.ok(frameGain(1 / 30) > frameGain(1 / 60) && frameGain(1 / 240) === 1);
  assert.ok(estimateSpeed({ ...base, step: 1 / 30 }).kmh >= e.kmh);
  // 요약
  assert.deepEqual(speedSummary([{ ok: true, kmh: 100 }, { ok: true, kmh: 120, cal: true }, { ok: false }]), { n: 2, of: 3, avg: 110, max: 120, cal: true, assumed: false });
  assert.equal(speedSummary([{ ok: true, kmh: 100, assumed: true }]).assumed, true);
  assert.equal(speedSummary([{ ok: false }]), null);
  assert.ok(benchmarks('serve').length === 3 && benchmarks('backhand')[0][0].includes('백핸드'));
  // 샷에서 바로
  const s = shotSpeed({ swing: { peak: 10, h: 1.7, sf: 1, sfAuto: false, stroke: 'serve' }, m: { stroke: 'serve', vis: 0.9, view: 'side' }, step: 1 / 60 }, { heightCm: 170 });
  assert.equal(s.kmh, e.kmh);
});

test('공 속도 예측: 믿을 수 없을 때는 숫자를 내지 않는다', async () => {
  const { estimateSpeed } = await import('../../app/static/coach/js/speed.js');
  const base = { stroke: 'serve', serveType: 'flat', peak: 10, bodyH: 1.7, heightCm: 170, sf: 1, sfAuto: false, step: 1 / 60, vis: 0.9, view: 'side' };
  assert.equal(estimateSpeed({ ...base, sf: 6, sfAuto: true, peak: 1.3 }).ok, false);     // 슬로모션 배수를 영상에서 예측한 경우
  assert.match(estimateSpeed({ ...base, sf: 6, sfAuto: true, peak: 1.3 }).why, /슬로모션/);
  assert.equal(estimateSpeed({ ...base, vis: 0.4 }).ok, false);                           // 팔이 흐릿함
  assert.equal(estimateSpeed({ ...base, suspect: true }).ok, false);                      // 준비 동작
  assert.equal(estimateSpeed({ ...base, peak: 0 }).ok, false);
  assert.equal(estimateSpeed({ ...base, peak: 1.5 }).ok, false);                          // 너무 느린 스윙
  assert.equal(estimateSpeed({ ...base, stroke: 'volley' }).ok, false);
  // 사용자가 슬로모션 배수(4배)를 알려 준 경우: 화면 속도 2.5 → 실제 10 과 같은 값
  const slow = estimateSpeed({ ...base, peak: 2.5, sf: 4, sfAuto: false, step: 1 / 30 });
  const real = estimateSpeed({ ...base, peak: 10, step: 1 / 120 });
  assert.ok(slow.ok && slow.kmh === real.kmh, `${slow.kmh} vs ${real.kmh}`);
  assert.equal(slow.pct, 30);
  // 범위를 벗어난 값은 자르지 않고 숫자를 내지 않는다
  assert.equal(estimateSpeed({ ...base, peak: 40 }).ok, false);
  assert.equal(estimateSpeed({ ...base, peak: 3.2 }).ok, false);                          // 약 36km/h 서브: 하한(40) 아래
  // 가장 빠른 순간의 화면이 드문드문 찍혔으면(초당 20장 미만) 말하지 않는다
  assert.equal(estimateSpeed({ ...base, step: 1 / 10 }).ok, false);
  assert.match(estimateSpeed({ ...base, step: 1 / 10 }).why, /드문드문/);
  assert.equal(estimateSpeed({ ...base, step: NaN }).ok, false);
  // 긴 영상인데 사용자가 슬로모션이라고 했으면(분석은 일반 속도로 했다) 말하지 않는다
  assert.equal(estimateSpeed({ ...base, sfIgnored: true }).ok, false);
  // 영상 속도를 사용자가 고르지 않았으면 '일반 속도로 가정'했다고 표시한다
  assert.equal(estimateSpeed(base).assumed, true);
  assert.equal(estimateSpeed({ ...base, sfGiven: true }).assumed, false);
  assert.equal(estimateSpeed({ ...base, peak: 2.5, sf: 4, step: 1 / 10 }).assumed, false);
  // 한쪽만 프레임이 빠져도(앞 20ms · 뒤 70ms) 말하지 않는다: 평균(45ms)이 아니라 넓은 쪽으로 판정한다
  assert.equal(estimateSpeed({ ...base, step: 0.045, stepMax: 0.07 }).ok, false);
  assert.equal(estimateSpeed({ ...base, step: 0.033, stepMax: 0.034 }).ok, true);
  assert.equal(estimateSpeed({ ...base, peak: 2.5, sf: 4, step: 1 / 10 }).slow, 4);        // 계산에 쓴 배수를 알려 준다(화면에 적는다)
  assert.equal(estimateSpeed(base).slow, 0);
  // 슬로모션 4배 영상은 화면 간격이 1/10초여도 실제로는 1/40초라 괜찮다
  assert.equal(estimateSpeed({ ...base, peak: 2.5, sf: 4, step: 1 / 10 }).ok, true);
});

test('공 속도 보정: 실제 속도를 알려 주면 그 비율로 맞추고 범위를 좁힌다', async () => {
  const { estimateSpeed, calibration, shotSpeed } = await import('../../app/static/coach/js/speed.js');
  const base = { stroke: 'serve', serveType: 'flat', peak: 10, bodyH: 1.7, heightCm: 170, sf: 1, sfAuto: false, step: 1 / 60, vis: 0.9, view: 'side' };
  const e = estimateSpeed(base);
  assert.equal(e.cal, false);
  const f = calibration(e, 120);                                   // 실제로는 120km/h 였다
  assert.ok(f > 1 && f < 1.4);
  const c = estimateSpeed({ ...base, cal: f });
  assert.equal(c.kmh, 120); assert.equal(c.cal, true);
  assert.equal(c.pct, e.pct);                                      // 한 번 맞췄다고 참고 범위를 좁히지 않는다
  // 보정은 보정 전 값 기준이라, 이미 보정된 결과로 다시 보정해도 같은 비율이 나온다
  assert.equal(calibration(c, 120), f);
  // 터무니없는 값은 받지 않는다
  assert.equal(calibration(e, 400), null); assert.equal(calibration(e, 10), null); assert.equal(calibration(e, 235), null);
  assert.equal(calibration(estimateSpeed({ ...base, peak: 6 }), 140), null);            // 예측값의 2배가 넘는다
  // 맞춘 결과가 범위를 벗어나면 잘라서 보여 주지 않고 숫자를 내지 않는다. 맞춘 값 탓이라고 알려 준다(지울 수 있게)
  assert.equal(estimateSpeed({ ...base, peak: 18, cal: 1.4 }).ok, false);
  assert.equal(estimateSpeed({ ...base, peak: 18, cal: 1.4 }).calOut, true);
  // 잘못 잰 값(맞추기 전부터 범위 밖)이 맞춘 비율 때문에 그럴듯한 숫자로 바뀌어 나오면 안 된다
  assert.equal(estimateSpeed({ ...base, peak: 3.2, cal: 2 }).ok, false);                  // 약 36 → 72km/h
  assert.equal(estimateSpeed({ ...base, peak: 25, cal: 0.5 }).ok, false);                 // 약 281 → 140km/h
  assert.equal(estimateSpeed({ ...base, peak: 3.2, cal: 2 }).calOut, false);
  // 경계값(서브 40km/h)을 넣어 맞춰도 다시 계산하면 그 값이 나온다(비율을 반올림하지 않는다)
  const e5 = estimateSpeed({ ...base, peak: 5 });
  const f5 = calibration(e5, 40);
  assert.ok(f5 > 0.7 && f5 < 0.72);
  assert.equal(estimateSpeed({ ...base, peak: 5, cal: f5 }).kmh, 40);
  assert.equal(calibration({ ok: false }, 120), null);
  // 서브 보정은 서브에만, 스트로크 보정은 스트로크에만
  const shot = { swing: { peak: 10, h: 1.7, sf: 1, sfAuto: false, stroke: 'serve' }, m: { stroke: 'serve', vis: 0.9, view: 'side' }, step: 1 / 60 };
  assert.equal(shotSpeed(shot, { heightCm: 170, cal: { serve: f, forehand: 1, backhand: 1 } }).kmh, 120);
  assert.equal(shotSpeed(shot, { heightCm: 170, cal: { serve: 1, forehand: 1.5, backhand: 1.5 } }).kmh, e.kmh);
  // 가장 빠른 순간 앞뒤 프레임이 빠져 있으면(사람을 놓친 화면) 그 간격으로 판단한다
  const fr = (ts) => ts.map((x) => ({ t: x }));
  assert.equal(shotSpeed({ ...shot, swing: { ...shot.swing, ip: 2 }, frames: fr([0, 0.017, 0.033, 0.05, 0.067]) }, { heightCm: 170 }).ok, true);
  assert.equal(shotSpeed({ ...shot, swing: { ...shot.swing, ip: 2 }, frames: fr([0, 0.017, 0.033, 0.25, 0.27]) }, { heightCm: 170 }).ok, false);
  assert.equal(shotSpeed({ ...shot, swing: { ...shot.swing, ip: 2 }, frames: fr([0, 0.02, 0.04, 0.11, 0.13]) }, { heightCm: 170 }).ok, false);   // 뒤쪽만 70ms
});

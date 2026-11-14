// 스윙 코치 분석 엔진 테스트 — 합성 자세(막대 인형)로 스윙 검출·지표·조언·보정·사람 따라가기를 확인한다.
//   node --test tests/js/coach_engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../../app/static/coach/js/geom.js';
import { cleanFrames } from '../../app/static/coach/js/clean.js';
import { detectSwings, mainSwing, withContact, bodyScale } from '../../app/static/coach/js/swing.js';
import { poseMetrics, swingMetrics, guessPhase } from '../../app/static/coach/js/metrics.js';
import { advise, matchReference } from '../../app/static/coach/js/advice.js';
import * as Track from '../../app/static/coach/js/track.js';

// ── 막대 인형 ────────────────────────────────────────────────────
// 카메라 좌표: x 오른쪽, y 아래, z 멀어지는 쪽. 사람은 +x 쪽(화면 오른쪽)으로 친다 = 옆에서 찍은 영상.
// 가슴은 처음에 카메라를 본다(유닛 턴) → 임팩트 때 +x 를 본다.
const H = 1.7;
function figure({ wrist, yaw = 0, knee = 0, offWrist = null, lean = 0 }) {
  // yaw: 가슴이 향하는 방향(0 = 카메라 쪽(-z), 90 = +x 쪽). 몸 기준 오른쪽 R, 앞 F.
  const a = (yaw * Math.PI) / 180;
  const F = [Math.sin(a), 0, -Math.cos(a)], R = [-Math.cos(a), 0, -Math.sin(a)];
  const at = (r, up, f) => [R[0] * r + F[0] * f + lean * up, -up, R[2] * r + F[2] * f];   // 골반 중심 기준
  const drop = knee * 0.004;                                   // 무릎을 굽히면 몸이 내려간다
  const w = Array.from({ length: 33 }, () => [0, 0, 0, 1]);
  const set = (i, p) => { w[i] = [p[0], p[1] + drop * 0 , p[2], 1]; };
  set(23, at(-0.14, 0, 0)); set(24, at(0.14, 0, 0));
  set(11, at(-0.19, 0.5, 0)); set(12, at(0.19, 0.5, 0));
  set(0, at(0, 0.68, 0.06)); set(7, at(-0.07, 0.68, 0)); set(8, at(0.07, 0.68, 0));
  const kf = Math.sin((knee * Math.PI) / 180) * 0.42;          // 무릎이 앞으로 나오는 만큼
  const ku = 0.42 * Math.cos((knee * Math.PI) / 180);
  for (const [hip, kn, an, he, to, r] of [[23, 25, 27, 29, 31, -0.14], [24, 26, 28, 30, 32, 0.14]]) {
    set(kn, at(r, -ku, kf)); set(an, at(r, -ku - 0.42 * Math.cos((knee * Math.PI) / 180), 0));
    set(he, at(r, -ku - 0.42 * Math.cos((knee * Math.PI) / 180) - 0.03, -0.05)); set(to, at(r, -ku - 0.42 * Math.cos((knee * Math.PI) / 180) - 0.03, 0.15));
    void hip;
  }
  const rw = wrist;                                             // 오른손목(카메라 좌표, 골반 기준)
  const rs = w[12];
  set(14, [(rs[0] + rw[0]) / 2, (rs[1] + rw[1]) / 2 + 0.08, (rs[2] + rw[2]) / 2]);
  set(16, rw); set(18, rw); set(20, rw); set(22, rw);
  const lw = offWrist || at(-0.3, 0.2, 0.2);
  set(13, [(w[11][0] + lw[0]) / 2, (w[11][1] + lw[1]) / 2 + 0.05, (w[11][2] + lw[2]) / 2]);
  set(15, lw); set(17, lw); set(19, lw); set(21, lw);
  // 화면 좌표: 1 미터 = 화면 높이의 0.4, 골반이 (0.5, 0.55)
  const lm = w.map((p) => [0.5 + p[0] * 0.4 * (9 / 16), 0.55 + p[1] * 0.4, p[2], 1]);
  return { lm, w };
}
const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));

/** 포핸드 한 번(옆에서 찍음). front = 임팩트 때 손목이 골반보다 앞(미터), fps, slow = 슬로모션 배수 */
function forehand({ fps = 60, front = 0.35, turn = 100, knee = 35, start = 1.0, slow = 1, pad = 1.2 } = {}) {
  const frames = [];
  const T = (start + 0.5 + pad) * slow;
  for (let i = 0; i < T * fps; i++) {
    const t = i / fps, u = t / slow;
    const back = ease((u - (start - 0.6)) / 0.45);             // 테이크백
    const fwd = ease((u - start) / 0.22);                       // 앞으로 휘두름(0.22초)
    const yaw = (1 - back) * 60 + back * (90 - turn) + fwd * (turn + 20 - (90 - 70));
    const x = -0.55 * back + (0.55 + front) * Math.pow(fwd, 1.0) + 0.25 * ease((u - start - 0.2) / 0.3) * (fwd >= 1 ? -1 : 0);
    const y = -(0.15 + 0.25 * fwd);                              // 아래에서 위로
    const f = figure({ wrist: [x, y, -0.25 + 0.1 * back], yaw: Math.max(-20, Math.min(120, yaw)), knee: knee * (back - 0.5 * fwd) });
    frames.push({ t, ...f });
  }
  return frames;
}
/** 서브 한 번: 손목이 머리 위로 올라간다 */
function serve({ fps = 60, start = 1.2, reach = 1.0 } = {}) {
  const frames = [];
  for (let i = 0; i < (start + 1.2) * fps; i++) {
    const t = i / fps;
    const toss = ease((t - (start - 0.9)) / 0.4), up = ease((t - (start - 0.15)) / 0.2), down = ease((t - start - 0.08) / 0.3);
    const trophyY = -0.75, dropY = -0.55, topY = -(0.5 + 0.62 * reach + 0.2);
    let y = -0.1 + toss * (trophyY + 0.1);
    const dip = ease((t - (start - 0.32)) / 0.12) * (1 - up);
    y += dip * (dropY - trophyY);
    y = y * (1 - up) + topY * up;
    y = y * (1 - down) + -0.1 * down;
    const x = -0.25 + 0.5 * up + 0.3 * down;
    const off = [0.05, -(0.2 + 1.0 * toss * (1 - up)), -0.3];
    frames.push({ t, ...figure({ wrist: [x, y, -0.2], yaw: 30 + 50 * up, knee: 55 * toss * (1 - up), offWrist: off }) });
  }
  return frames;
}
const still = (n = 300, fps = 30) => Array.from({ length: n }, (_, i) => ({ t: i / fps, ...figure({ wrist: [0.25, -0.1, -0.2], yaw: 0 }) }));

// ── 테스트 ───────────────────────────────────────────────────────
test('막대 인형이 사람답다: 키·몸 기준 축', () => {
  const p = figure({ wrist: [0.3, -0.2, -0.2] });
  assert.ok(Math.abs(G.statureW(p) - H) < 0.35, `키 ${G.statureW(p)}`);
  const fr = G.bodyFrame(p);
  assert.ok(G.dot(G.sub(p.w[0], G.mid(p.w[11], p.w[12])), fr.F) > 0, '코는 가슴 앞에 있다');
});

test('가만히 서 있으면 스윙이 없다', () => {
  assert.deepEqual(detectSwings(still(), { hand: 'R' }), []);
});

test('포핸드 한 번을 찾고 옆 화면·임팩트 시각을 맞힌다', () => {
  for (const fps of [25, 30, 60, 120]) {
    const fr = forehand({ fps, start: 1.0 });
    const sw = detectSwings(fr, { hand: 'R' });
    assert.equal(sw.length, 1, `${fps}fps 스윙 수`);
    assert.equal(sw[0].stroke, 'forehand');
    assert.equal(sw[0].view, 'side');
    assert.equal(sw[0].sf, 1);
    assert.ok(Math.abs(sw[0].tc - 1.14) < 0.1, `${fps}fps 임팩트 ${sw[0].tc}`);
    assert.ok(sw[0].keys.backswing < sw[0].keys.contact && sw[0].keys.contact < sw[0].keys.finish);
    assert.ok(sw[0].tcErr <= 0.5 / fps + 1e-9 && sw[0].posErr >= 0);
  }
});

test('프레임이 촘촘할수록 임팩트 위치 오차가 작다', () => {
  const e30 = detectSwings(forehand({ fps: 30 }), { hand: 'R' })[0].posErr;
  const e120 = detectSwings(forehand({ fps: 120 }), { hand: 'R' })[0].posErr;
  assert.ok(e120 < e30 * 0.45, `${e30} → ${e120}`);
});

test('슬로모션: 배수를 알려 주면 그대로, 안 알려 주면 어림하고 표시한다', () => {
  const fr = forehand({ fps: 30, slow: 8 });
  const given = detectSwings(fr, { hand: 'R', sf: 8 });
  assert.equal(given.length, 1);
  assert.equal(given[0].sf, 8); assert.equal(given[0].sfAuto, false);
  const auto = detectSwings(fr, { hand: 'R' });
  assert.equal(auto.length, 1);
  assert.ok(auto[0].sf > 2 && auto[0].sfAuto === true);
});

test('서브는 손목이 머리 위로 올라가는 것으로 알아본다', () => {
  const sw = mainSwing(serve(), { hand: 'R' });
  assert.ok(sw);
  assert.equal(sw.stroke, 'serve');
  assert.ok(sw.keys.trophy < sw.keys.contact, '트로피가 임팩트보다 앞');
  const m = swingMetrics(serve(), sw, 1920, 1080);
  assert.ok(m.phases.contact.wristUp > 0.2, '임팩트 때 손목이 머리 위');
  assert.ok(m.wristHeightGround > 1.0 && m.wristHeightGround < 1.6, `손목 높이 ${m.wristHeightGround}`);
});

test('왼손잡이 포핸드도 포핸드로 본다', () => {
  const fr = forehand({ fps: 60 }).map((f) => G.mirrorPose(f));
  const sw = mainSwing(fr, { hand: 'L' });
  assert.ok(sw);
  assert.equal(sw.stroke, 'forehand');
});

test('옆 화면 타점: 더 앞에서 맞히면 contactFront 가 커진다', () => {
  const val = (front) => { const fr = forehand({ fps: 120, front }); const sw = mainSwing(fr, { hand: 'R' }); return swingMetrics(fr, sw, 1920, 1080).contactFront; };
  const late = val(0.05), good = val(0.4);
  assert.ok(good > late + 0.1, `${late} → ${good}`);
});

test('조언: 타점이 늦으면 "더 앞에서"가 가장 먼저 나온다', () => {
  const fr = forehand({ fps: 120, front: -0.05, turn: 100 });
  const sw = mainSwing(fr, { hand: 'R' });
  const m = swingMetrics(fr, sw, 1920, 1080);
  const a = advise(m, { heightCm: 175 });
  assert.ok(a.items.some((it) => it.id === 'fh_contact_front' && it.side === 'low'), JSON.stringify(a.items.map((i) => i.id)));
  assert.match(a.items.find((it) => it.id === 'fh_contact_front').title, /cm 더 앞에서/);
  assert.ok(a.score < 90);
  const tagged = advise(m, { heightCm: 175, result: 'long' });
  assert.match(tagged.resultNote, /면/);
});

test('조언: 프레임이 성긴 영상에서 경계선 타점은 단정하지 않는다', () => {
  const m = { stroke: 'forehand', view: 'side', twoHanded: false, sf: 1, vis: 0.9, conf: 0.9, posErr: 0.1, contactFront: 0.03, phases: { contact: { elbowHit: 130 }, finish: {} } };
  const a = advise(m, {});
  assert.ok(!a.items.some((it) => it.id === 'fh_contact_front'));
  assert.ok(a.notes.some((n) => /슬로모션/.test(n)));
});

test('임팩트 순간을 사용자가 옮기면 그 시각으로 다시 잡는다', () => {
  const fr = forehand({ fps: 60 });
  const sw = mainSwing(fr, { hand: 'R' });
  const moved = withContact(fr, sw, sw.tc - 0.05);
  assert.ok(Math.abs(moved.tc - (sw.tc - 0.05)) < 1e-9);
  assert.equal(moved.stroke, sw.stroke);
});

test('좌우 뒤바뀜 보정: 중간 몇 프레임만 뒤집힌 것을 되돌린다', () => {
  const fr = forehand({ fps: 60 });
  const broken = fr.map((f, i) => (i >= 20 && i < 26 ? { ...G.mirrorPose(f), lm: G.mirrorPose(f).lm.map((k) => [1 - k[0], k[1], k[2], k[3]]), w: G.mirrorPose(f).w.map((k) => [-k[0], k[1], k[2], k[3]]) } : f));
  // 위 조작 = 좌표는 그대로 두고 좌우 이름표만 바꾼 것
  const fixed = cleanFrames(broken, 16 / 9);
  for (let i = 18; i < 28; i++) assert.ok(Math.abs(fixed[i].lm[16][0] - fr[i].lm[16][0]) < 1e-6, `프레임 ${i} 오른손목`);
});

test('튀는 점 보정: 한 프레임만 엉뚱한 손목을 앞뒤 사이로 되돌린다', () => {
  const fr = still(40);
  const bad = fr.map((f, i) => (i === 20 ? { ...f, lm: f.lm.map((k, j) => (j === 16 ? [0.95, 0.05, 0, 1] : k)), w: f.w.map((k, j) => (j === 16 ? [2, -2, 0, 1] : k)) } : f));
  const fixed = cleanFrames(bad, 16 / 9);
  assert.ok(Math.abs(fixed[20].lm[16][0] - fr[20].lm[16][0]) < 0.01);
  assert.ok(fixed[20].fixed >= 1);
});

test('빈 구간을 가로질러 자세를 지어내지 않는다', () => {
  const a = { t: 0, ...figure({ wrist: [0, -0.1, -0.2] }) }, b = { t: 2, ...figure({ wrist: [0.6, -0.5, -0.2] }) };
  const p = G.poseAt([a, b], 0.4);
  assert.equal(p, a);
  assert.ok(G.validPose(a));
  assert.ok(!G.validPose({ t: 0, lm: [], w: [] }));
});

test('사진 한 장의 순간 어림: 서브 임팩트·트로피', () => {
  const contact = poseMetrics(figure({ wrist: [0.1, -1.3, -0.2], yaw: 80 }), 'R');
  assert.equal(guessPhase('serve', contact), 'contact');
  assert.equal(guessPhase('serve', { wristUp: 0.0, elbowHit: 95, offWristUp: 0.2 }), 'trophy');
});

test('대조군 찾기: 같은 자세가 가장 가깝고, 왼손잡이는 뒤집어 견준다', () => {
  const pose = figure({ wrist: [0.4, -0.3, -0.2], yaw: 80 });
  const other = figure({ wrist: [-0.4, -0.9, 0.1], yaw: 10, knee: 60 });
  const mk = (p, id) => ({ id, stroke: 'forehand', phase: 'contact', feat: G.poseFeature(p), sex: 'F', legs: true });
  const ref = { samples: [mk(other, 'far'), mk(pose, 'near')] };
  assert.equal(matchReference(ref, 'forehand', 'contact', pose, { hand: 'R' })[0].sample.id, 'near');
  assert.equal(matchReference(ref, 'forehand', 'contact', G.mirrorPose(pose), { hand: 'L' })[0].sample.id, 'near');
  assert.deepEqual(matchReference(ref, 'serve', 'contact', pose, {}), []);
});

test('옷 색: 이름·거리·따라가기', () => {
  assert.equal(Track.colorName([250, 250, 250]), '흰색');
  assert.equal(Track.colorName([15, 15, 18]), '검정');
  assert.equal(Track.colorName([200, 30, 40]), '빨강');
  assert.equal(Track.colorName([30, 60, 190]), '파랑');
  assert.ok(Track.colorDist([200, 30, 40], [170, 25, 35]) < Track.colorDist([200, 30, 40], [30, 60, 190]));
  const P = (x) => ({ lm: figure({ wrist: [0.2, -0.2, -0.2] }).lm.map((k) => [k[0] + x, k[1], k[2], k[3]]) });
  const state = { color: [200, 30, 40] };
  // 빨간 옷이 오른쪽, 파란 옷이 왼쪽 → 빨간 옷을 고른다. 다음 화면에서 순서가 바뀌어도 같은 사람.
  assert.equal(Track.pickTarget([P(-0.2), P(0.2)], [[30, 60, 190], [205, 35, 45]], state, 0), 1);
  assert.equal(Track.pickTarget([P(0.21), P(-0.2)], [[198, 28, 38], [30, 60, 190]], state, 0.1), 0);
  assert.equal(Track.pickTarget([P(-0.2)], [[30, 60, 190]], state, 0.2), -1, '대상이 화면에 없으면 -1');
  const groups = Track.groupPeople([{ t: 0, lm: P(0).lm, color: [200, 30, 40] }, { t: 1, lm: P(0.1).lm, color: [185, 28, 36] }, { t: 2, lm: P(0).lm, color: [30, 60, 190] }]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].name, '빨강');
});

test('키는 영상 전체에서 하나로 고정한다', () => {
  const h = bodyScale(forehand({ fps: 30 }));
  assert.ok(h > 1.2 && h < 2.2, `키 ${h}`);
});

// ── 교차 검토(Codex)에서 나온 것들 ───────────────────────────────
test('잰 것이 부족하면 점수를 내지 않는다(못 잰 것을 좋다고 하지 않는다)', () => {
  const none = advise({ stroke: 'forehand', view: 'unknown', twoHanded: false, sf: 1, vis: 0.9, conf: 0.9, posErr: 0.05, phases: {} }, {});
  assert.equal(none.score, null);
  assert.equal(none.grade, '평가 불가');
  assert.ok(none.unratedWhy);
  const blurry = advise({ stroke: 'forehand', view: 'side', twoHanded: false, sf: 1, vis: 0.2, conf: 0.2, posErr: 0.05, contactFront: 0.2, kneeBend: 40,
    chestAtBackswing: 100, chestAtContact: 20, headFront: 0.02, headMove: 0.02, wristHeightGround: 0.55, phases: { contact: { elbowHit: 130 }, finish: { wristSide: -0.2 } } }, {});
  assert.equal(blurry.score, null);
});

test('위치 오차가 큰 영상에서는 몇 cm 인지 말하지 않는다', () => {
  const base = { stroke: 'forehand', view: 'side', twoHanded: false, sf: 1, vis: 0.9, conf: 0.9, contactFront: -0.25, kneeBend: 40, chestAtBackswing: 100, chestAtContact: 20,
    headFront: 0.02, headMove: 0.02, wristHeightGround: 0.55, phases: { contact: { elbowHit: 130 }, finish: { wristSide: -0.2 } } };
  const sharp = advise({ ...base, posErr: 0.02 }, { heightCm: 175 }).items.find((i) => i.id === 'fh_contact_front');
  const coarse = advise({ ...base, posErr: 0.12 }, { heightCm: 175 }).items.find((i) => i.id === 'fh_contact_front');
  assert.match(sharp.title, /약 \d+cm/);
  assert.ok(coarse && !/\d+cm/.test(coarse.title), coarse && coarse.title);
});

test('왼손잡이에게 왼손·오른손을 박아서 말하지 않는다', () => {
  const m = { stroke: 'forehand', view: 'side', twoHanded: false, sf: 1, vis: 0.9, conf: 0.9, posErr: 0.02, contactFront: 0.2, kneeBend: 40, chestAtBackswing: 30, chestAtContact: 20,
    headFront: 0.02, headMove: 0.02, wristHeightGround: 0.55, phases: { contact: { elbowHit: 130 }, finish: { wristSide: -0.2 } } };
  const turn = advise(m, {}).items.find((i) => i.id === 'fh_turn');
  assert.ok(turn);
  assert.ok(!/왼손|오른손|왼쪽 어깨|오른쪽 어깨/.test(turn.cue), turn.cue);
});

test('같은 화면에 같이 나온 같은 색 옷 두 사람은 따로 묶는다', () => {
  const P = (x) => figure({ wrist: [0.2, -0.2, -0.2] }).lm.map((k) => [k[0] + x, k[1], k[2], k[3]]);
  const groups = Track.groupPeople([
    { t: 1, lm: P(-0.2), color: [200, 30, 40] }, { t: 1, lm: P(0.2), color: [198, 32, 42] },      // 같은 순간, 같은 색
    { t: 2, lm: P(-0.2), color: [201, 31, 41] },
  ]);
  assert.equal(groups.length, 2);
});

test('백핸드 대조군은 원핸드·투핸드가 같은 표본을 먼저 고른다', () => {
  const pose = figure({ wrist: [0.4, -0.3, -0.2], yaw: 80 });
  const mk = (id, twoHanded) => ({ id, stroke: 'backhand', phase: 'contact', feat: G.poseFeature(pose), sex: 'U', legs: true, twoHanded });
  const ref = { samples: [mk('one', false), mk('two', true)] };
  assert.equal(matchReference(ref, 'backhand', 'contact', pose, { twoHanded: true })[0].sample.id, 'two');
  assert.equal(matchReference(ref, 'backhand', 'contact', pose, { twoHanded: false })[0].sample.id, 'one');
});

// 화면 보고 학습: 화면과 상관없는 계산(watchcore.js)과 '치는 순간' 모델(moment.js)을 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'static', 'coach');
const W = await import(path.join(ROOT, 'js', 'watchcore.js'));
const M = await import(path.join(ROOT, 'js', 'moment.js'));
const { N_FEAT } = await import(path.join(ROOT, 'js', 'classify.js'));

/** 화면의 (cx, cy)에 키 h 로 서 있는 사람(관절 33개, 화면 좌표) */
function person(cx, cy, h, t = 0) {
  const lm = Array.from({ length: 33 }, (_, j) => [cx + (j % 2 ? 0.01 : -0.01), cy - h / 2 + (h * j) / 32, 0, 1]);
  lm[23] = [cx - 0.01, cy, 0, 1]; lm[24] = [cx + 0.01, cy, 0, 1];
  const w = lm.map((p) => [(p[0] - cx) * 2, (p[1] - cy) * 2, 0, 1]);
  return { t, lm, w };
}

test('누구를 볼지: 처음에는 가장 크게 나온 사람, 그 뒤로는 따라가던 사람', () => {
  const boxes = [person(0.2, 0.5, 0.2), person(0.7, 0.6, 0.5), person(0.5, 0.3, 0.1)].map((p) => W.personBox(p.lm));
  assert.equal(W.pickPerson(boxes, null), 1);
  assert.equal(W.pickPerson(boxes, { cx: 0.22, cy: 0.52, h: 0.2 }), 0);
  assert.equal(W.pickPerson([boxes[1]], { cx: 0.1, cy: 0.2, h: 0.1 }), -1, '멀리 있는 다른 사람으로 갈아타지 않는다');
  assert.equal(W.pickPerson([], null), -1);
  const b = W.personBox(person(0.4, 0.5, 0.3).lm);
  assert.ok(Math.abs(b.cx - 0.4) < 1e-9 && Math.abs(b.cy - 0.5) < 1e-9 && Math.abs(b.h - 0.3) < 1e-9);
});

test('멀리 찍힌 선수는 따라가며 확대: 네모는 화면 안, 좌표는 전체 화면 기준으로 되돌린다', () => {
  assert.equal(W.needZoom({ cx: 0.5, cy: 0.5, h: 0.2 }), true);
  assert.equal(W.needZoom({ cx: 0.5, cy: 0.5, h: 0.6 }), false);
  assert.equal(W.needZoom(null), false);
  for (const t of [{ cx: 0.02, cy: 0.95, h: 0.12 }, { cx: 0.99, cy: 0.01, h: 0.3 }, { cx: 0.5, cy: 0.5, h: 0.44 }]) {
    const r = W.zoomRect(t, 1920, 1080);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.s <= 1920 && r.y + r.s <= 1080 && r.s >= 160, JSON.stringify(r));
  }
  const rect = { x: 300, y: 200, s: 400 };
  const full = W.toFull([[0, 0, 0, 1], [1, 1, 0, 1], [0.5, 0.25, 0.1, 0.7]], rect, 1920, 1080);
  assert.deepEqual(full[0].slice(0, 2), [300 / 1920, 200 / 1080]);
  assert.deepEqual(full[1].slice(0, 2), [700 / 1920, 600 / 1080]);
  assert.ok(Math.abs(full[2][0] - 500 / 1920) < 1e-12 && full[2][3] === 0.7);
  const f = W.follow({ cx: 0, cy: 0, h: 0.2 }, { cx: 1, cy: 1, h: 0.4 });
  assert.ok(f.cx > 0.5 && f.cx < 1 && f.h > 0.2 && f.h < 0.4);
});

test('특징 벡터를 작게 담았다 풀어도 값이 같다(위치 0.0001, 속도 0.0005 안)', () => {
  const x = Array.from({ length: N_FEAT }, (_, i) => (i % 44 === 43 ? (i % 7) * 1.3 : Math.sin(i) * 1.7));
  x[0] = 99; x[1] = NaN; x[43] = 40;                                  // 범위를 넘는 값·깨진 값
  const text = W.packFeat(x), y = W.unpackFeat(text);
  assert.equal(y.length, N_FEAT);
  assert.ok(text.length < N_FEAT * 3, '660개가 1,800자 안쪽');
  for (let i = 2; i < N_FEAT; i++) if (i !== 43) assert.ok(Math.abs(x[i] - y[i]) <= (i % 44 === 43 ? 2.6e-4 : 5.1e-5), `${i}: ${x[i]} ≠ ${y[i]}`);
  assert.ok(Math.abs(y[0] - 3.2767) < 1e-9 && y[1] === 0 && Math.abs(y[43] - 16.3835) < 1e-9, '넘치면 끝값, 깨진 값은 0');
});

const P = (none, f = 0, b = 0, o = 0) => ({ backhand: b, bvolley: 0, forehand: f, fvolley: 0, none, overhead: o });
const cand = (t, p, stroke = 'forehand') => ({ t, v: 3, s: 1 - p.none, stroke, sub: null, P: p, x: Array.from({ length: N_FEAT }, (_, i) => (i % 5) * 0.1) });

test('묶음: 영상은 없고 후보의 특징·확률·설정만 담긴다. 한글 메모도 머리말에 실린다', () => {
  const frames = Array.from({ length: 240 }, (_, i) => person(0.5, 0.5, 0.6, i / 30));
  const cands = [cand(2.0, P(0.02, 0.98)), cand(4.0, P(0.99)), cand(6.0, P(0.1, 0, 0.9), 'backhand')];
  const shots = M.pickSwings(cands);
  assert.deepEqual(shots.map((s) => s.t), [2.0, 6.0]);
  const meta = { note: '머드리 동호인 복식 — 포핸드 연습', view: '뒤', level: '동호인', only: 'forehand', width: 1280, height: 720, zoomed: 0.25, found: 0.9 };
  for (const detail of [true, false]) {
    const c = W.buildChunk({ session: 'abc', seq: 3, profile: { hand: 'L', backhand: '1h' }, meta, frames, cands, shots, taps: [{ t: 2.31, k: 'forehand' }], detail });
    assert.equal(c.kind, 'swing-coach-watch');
    assert.deepEqual(c.profile, { hand: 'L', backhand: '1h' });
    assert.equal(c.cands.length, 3); assert.equal(c.shots.length, 2); assert.equal(c.frames, 240);
    assert.ok(Math.abs(c.meta.fps - 30) < 0.2);
    if (detail) { assert.equal(c.track.t.length, 240); assert.equal(c.windows.length, 0); }
    else { assert.equal(c.track, null); assert.equal(c.windows.length, 2); assert.ok(c.windows[0].track.t.length <= 91); }
    const text = JSON.stringify(c);
    for (const bad of ['http', 'youtube', 'blob:', 'data:image']) assert.ok(!text.includes(bad), `묶음에 ${bad} 가 들어 있다`);
    const head = W.metaHeader(c);
    assert.ok(/^[\x20-\x7e]*$/.test(head) && head.length <= 600, '머리말은 아스키 600자 안쪽');
    assert.equal(JSON.parse(head).note, meta.note.slice(0, 30));
  }
});

test('받는 쪽: 겹쳐 온 묶음을 이어도 후보·프레임·표시가 한 번씩만', () => {
  const mk = (seq, t0, t1, cs, taps) => W.buildChunk({ session: 's', seq, profile: { hand: 'R', backhand: '2h' }, meta: { note: '', width: 16, height: 9 },
    frames: Array.from({ length: Math.round((t1 - t0) * 30) + 1 }, (_, i) => person(0.5, 0.5, 0.6, t0 + i / 30)), cands: cs, shots: M.pickSwings(cs), taps, detail: true });
  const a = mk(0, 0, 12, [cand(3, P(0.01, 0.99)), cand(10.5, P(0.05, 0.95))], [{ t: 3.3, k: 'forehand' }]);
  const b = mk(1, 10, 22, [cand(10.5, P(0.05, 0.95)), cand(15, P(0.02, 0, 0, 0.98), 'serve')], [{ t: 15.3, k: 'serve' }]);
  const J = W.joinChunks([b, a, b]);                                   // 순서가 뒤섞이고 같은 묶음이 두 번 와도
  assert.deepEqual(J.cands.map((c) => c.t), [3, 10.5, 15]);
  assert.deepEqual(J.shots.map((s) => s.stroke), ['forehand', 'forehand', 'serve']);
  assert.equal(J.taps.length, 2);
  assert.equal(J.frames.length, 22 * 30 + 1);
  for (let i = 1; i < J.frames.length; i++) assert.ok(J.frames[i].t > J.frames[i - 1].t);
  assert.equal(J.cands[0].x.length, N_FEAT);
  assert.ok(Math.abs(J.cands[2].P.overhead - 0.98) < 1e-9);
});

test("'치는 순간' 모델: 파일 모양이 맞고, 가까이 붙은 후보는 확률 높은 것 하나만 고른다", () => {
  const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'moment_model.json'), 'utf8'));
  assert.equal(M.validMomentModel(model), true);
  assert.equal(M.validMomentModel({ ...model, classes: model.classes.filter((c) => c !== 'none') }), false);
  assert.equal(M.validMomentModel(null), false);
  const picked = M.pickSwings([cand(1.0, P(0.3, 0.7)), cand(1.4, P(0.05, 0.95)), cand(2.2, P(0.4, 0.6)), cand(5, P(0.8, 0.2))]);
  assert.deepEqual(picked.map((s) => s.t), [1.4, 2.2]);
  // 손목 속도의 꼭대기 찾기: 느린 것은 빼고, 0.35초 안에 붙은 것은 큰 것 하나
  const v = new Array(60).fill(0.2); v[10] = 3; v[15] = 5; v[40] = 0.8; v[50] = 2;
  const frames = v.map((_, i) => ({ t: i / 30 }));
  assert.deepEqual(M.candidates(frames, v), [15, 50]);
});

test('설정은 묶음마다 따로: 영상마다 "○○만"을 바꿔 가며 봐도 후보마다 그때의 설정이 붙는다', () => {
  const mk = (seq, t0, only, hand, cs) => W.buildChunk({ session: 's', seq, profile: { hand, backhand: '2h' }, meta: { note: '', only, device: '데스크탑', width: 16, height: 9 },
    frames: Array.from({ length: 91 }, (_, i) => person(0.5, 0.5, 0.6, t0 + i / 30)), cands: cs, shots: M.pickSwings(cs), taps: [], detail: false });
  const a = mk(0, 0, 'forehand', 'R', [cand(1, P(0.02, 0.98))]);
  const b = mk(1, 3, 'backhand', 'L', [cand(4, P(0.02, 0, 0.98), 'backhand')]);
  const c = mk(2, 6, null, 'R', [cand(7, P(0.02, 0, 0, 0.98), 'serve')]);
  const J = W.joinChunks([c, a, b]);
  assert.deepEqual(J.cands.map((x) => [x.t, x.only, x.hand]), [[1, 'forehand', 'R'], [4, 'backhand', 'L'], [7, null, 'R']]);
  assert.equal(a.meta.device, '데스크탑');
  assert.equal(JSON.parse(W.metaHeader(a)).device, '데스크탑');
  assert.ok(/^[\x20-\x7e]*$/.test(W.metaHeader(a)));
});

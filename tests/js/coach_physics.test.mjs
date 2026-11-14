// 스윙 코치 물리 모듈(app/static/coach/js/physics.js) 테스트.
// 사용: node --test tests/js/coach_physics.test.mjs   (저장소 루트에서)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ballContactHeight,
  COURT,
  DEFAULTS,
  SPIN_TILT_DEG,
  groundWindow,
  liftCoefficient,
  netHeightAt,
  serveWindow,
  simulate,
  straightLineMinHeight,
  sweep,
} from '../../app/static/coach/js/physics.js';

const DEG = Math.PI / 180;
const R = DEFAULTS.ballRadius;
const VACUUM = { Cd: 0, lift: false };

const near = (actual, expected, tol, msg = '') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg} expected ${expected} ± ${tol}, got ${actual}`);
const between = (actual, lo, hi, msg = '') =>
  assert.ok(actual > lo && actual < hi, `${msg} expected ${lo} < x < ${hi}, got ${actual}`);
const strictlyIncreasing = (xs, msg) =>
  xs.slice(1).forEach((x, i) => assert.ok(x > xs[i], `${msg}: ${xs.map((v) => v.toFixed(3)).join(', ')}`));

// 공기가 없을 때의 포물선 해 (착지는 공 중심이 z = 반지름일 때)
function projectile({ x0 = 0, y0 = 0, z0, speedKmh, elevDeg, azimDeg = 0 }) {
  const g = DEFAULTS.gravity;
  const v = speedKmh / 3.6;
  const vz = v * Math.sin(elevDeg * DEG);
  const vx = v * Math.cos(elevDeg * DEG) * Math.cos(azimDeg * DEG);
  const vy = v * Math.cos(elevDeg * DEG) * Math.sin(azimDeg * DEG);
  const t = (vz + Math.sqrt(vz * vz + 2 * g * (z0 - R))) / g;
  const tNet = (COURT.netX - x0) / vx;
  return {
    t,
    x: x0 + vx * t,
    y: y0 + vy * t,
    maxHeight: vz > 0 ? z0 + (vz * vz) / (2 * g) : z0,
    net: { t: tNet, y: y0 + vy * tNet, z: z0 + vz * tNet - 0.5 * g * tNet * tNet },
  };
}

describe('court and constants', () => {
  test('court dimensions and physical constants', () => {
    assert.equal(COURT.netX, 11.885);
    assert.equal(COURT.farServiceLineX, 18.285);
    assert.equal(COURT.farBaselineX, 23.77);
    assert.equal(COURT.singlesHalfWidth, 4.115);
    assert.equal(COURT.doublesHalfWidth, 5.485);
    assert.equal(DEFAULTS.ballMass, 0.057);
    assert.equal(DEFAULTS.ballRadius, 0.033);
    assert.equal(DEFAULTS.airDensity, 1.21);
    assert.equal(DEFAULTS.gravity, 9.81);
    assert.equal(DEFAULTS.Cd, 0.55);
    assert.ok(Object.isFrozen(COURT) && Object.isFrozen(DEFAULTS));
  });

  test('net height: 0.914 at the strap, 1.07 at the posts, rising in between', () => {
    near(netHeightAt(0), 0.914, 1e-12);
    between(netHeightAt(COURT.singlesHalfWidth), 0.95, 1.02, 'singles sideline');
    near(netHeightAt(COURT.netPostY), 1.07, 1e-12);
    near(netHeightAt(6.399), 1.07, 1e-12);
    assert.equal(netHeightAt(-2.5), netHeightAt(2.5));
    assert.equal(netHeightAt(9), netHeightAt(COURT.netPostY)); // 포스트 바깥은 더 높아지지 않는다
    strictlyIncreasing([0, 1, 2, 3, 4.115, 5.485, 6.399].map((y) => netHeightAt(y)), 'net height vs |y|');
  });

  test('lift coefficient follows Cl = 1 / (2 + v / (r·ω))', () => {
    assert.equal(liftCoefficient(30, 0), 0);
    const w = (3000 * 2 * Math.PI) / 60;
    near(liftCoefficient(30, w), 1 / (2 + 30 / (0.033 * w)), 1e-12);
    assert.ok(liftCoefficient(30, 2 * w) > liftCoefficient(30, w));
    assert.ok(liftCoefficient(30, 1e9) < 0.5); // 스핀이 아무리 커도 0.5 를 넘지 않는다
  });
});

describe('simulate', () => {
  const cases = [
    { name: 'serve, downward and angled', x0: 0.3, y0: 0.3, z0: 2.6, speedKmh: 180, elevDeg: -5, azimDeg: -3 },
    { name: 'groundstroke, upward', z0: 0.9, speedKmh: 110, elevDeg: 12 },
    { name: 'slow lob', x0: -2, y0: -1, z0: 1.2, speedKmh: 60, elevDeg: 35, azimDeg: 8 },
  ];
  for (const { name, ...args } of cases) {
    test(`no drag / no lift matches the analytic projectile within 1 cm (${name})`, () => {
      const sim = simulate({ ...args, spinRpm: 3000, spin: 'kick', constants: VACUUM });
      const exact = projectile(args);
      near(sim.landing.x, exact.x, 0.01, 'landing x');
      near(sim.landing.y, exact.y, 0.01, 'landing y');
      near(sim.landing.t, exact.t, 1e-3, 'flight time');
      near(sim.maxHeight, exact.maxHeight, 0.01, 'max height');
      near(sim.net.z, exact.net.z, 0.01, 'height at net');
      near(sim.net.y, exact.net.y, 0.01, 'lateral position at net');
      near(sim.net.t, exact.net.t, 1e-3, 'time at net');
      near(sim.speedAtLandingKmh / 3.6, Math.hypot(args.speedKmh / 3.6 * Math.cos(args.elevDeg * DEG), DEFAULTS.gravity * exact.t - args.speedKmh / 3.6 * Math.sin(args.elevDeg * DEG)), 1e-3, 'landing speed');
    });
  }

  test('result is independent of the integration step', () => {
    const args = { z0: 2.6, speedKmh: 180, elevDeg: -6, azimDeg: -3, spinRpm: 3000, spin: 'kick' };
    const coarse = simulate(args);
    const fine = simulate({ ...args, constants: { dt: 0.00025 } });
    near(coarse.landing.x, fine.landing.x, 1e-4);
    near(coarse.landing.y, fine.landing.y, 1e-4);
    near(coarse.net.z, fine.net.z, 1e-4);
  });

  test('drag shortens the flight and slows the ball', () => {
    const args = { z0: 2.75, speedKmh: 190, elevDeg: -6.8 };
    const air = simulate(args);
    const vacuum = simulate({ ...args, constants: VACUUM });
    assert.ok(air.landing.x < vacuum.landing.x - 0.5);
    assert.ok(air.net.z < vacuum.net.z);
    // 빠른 서브는 바운드 전까지 속도의 대략 1/4 을 잃는다
    between(air.speedAtLandingKmh / 190, 0.65, 0.8, 'speed kept by a 190 km/h serve');
    assert.ok(simulate({ ...args, constants: { Cd: 0.65 } }).landing.x < air.landing.x);
  });

  test('topspin dips, backspin floats, flat ignores spinRpm', () => {
    const base = { z0: 0.9, speedKmh: 110, elevDeg: 8, spinRpm: 2500 };
    const flat = simulate({ ...base, spin: 'flat' });
    const top = simulate({ ...base, spin: 'topspin' });
    const back = simulate({ ...base, spin: 'backspin' });
    assert.ok(top.landing.x < flat.landing.x - 1, 'topspin lands shorter');
    assert.ok(back.landing.x > flat.landing.x + 1, 'backspin carries further');
    assert.ok(top.net.z < flat.net.z && flat.net.z < back.net.z);
    assert.ok(top.maxHeight < flat.maxHeight && flat.maxHeight < back.maxHeight);
    near(top.landing.y, 0, 1e-9); // 탑/백스핀은 옆으로 휘지 않는다
    near(back.landing.y, 0, 1e-9);
    assert.ok(top.speedAtLandingKmh < 110 && back.speedAtLandingKmh < top.speedAtLandingKmh);
    assert.deepEqual(flat.landing, simulate({ ...base, spinRpm: 0 }).landing);
    assert.deepEqual(top.landing, simulate({ ...base }).landing); // spin 기본값은 topspin
  });

  test("a right-hander's slice serve curves to the server's left (−y)", () => {
    const base = { z0: 2.7, speedKmh: 140, elevDeg: -4, spinRpm: 3000 };
    const flat = simulate({ ...base, spin: 'flat' });
    const slice = simulate({ ...base, spin: 'slice' });
    const lefty = simulate({ ...base, spin: 'slice', sideSign: -1 });
    const kick = simulate({ ...base, spin: 'kick' });
    assert.equal(flat.landing.y, 0);
    assert.ok(slice.landing.y < -0.3, `slice should curve left, got y=${slice.landing.y}`);
    assert.ok(slice.net.y < 0);
    near(lefty.landing.y, -slice.landing.y, 1e-9, 'left-hander mirrors');
    near(lefty.landing.x, slice.landing.x, 1e-9);
    // 슬라이스는 약간의 탑스핀 성분으로 플랫보다 조금 짧고, 킥은 더 많이 떨어지면서 왼쪽으로도 휜다
    assert.ok(slice.landing.x < flat.landing.x);
    assert.ok(kick.landing.x < slice.landing.x && kick.landing.y < -0.2);
    assert.ok(Math.abs(kick.landing.y) < Math.abs(slice.landing.y));
  });

  test('tiltDeg overrides the spin-axis preset', () => {
    const base = { z0: 2.7, speedKmh: 140, elevDeg: -4, spinRpm: 3000 };
    assert.deepEqual(SPIN_TILT_DEG, { topspin: 0, kick: 45, slice: 75, backspin: 180 });
    assert.deepEqual(
      simulate({ ...base, spin: 'topspin', tiltDeg: 45 }).landing,
      simulate({ ...base, spin: 'kick' }).landing,
    );
    const pureSide = simulate({ ...base, tiltDeg: 90 });
    const slice = simulate({ ...base, spin: 'slice' });
    assert.ok(pureSide.landing.y < slice.landing.y, 'pure sidespin curves more than slice');
    assert.ok(pureSide.landing.x > slice.landing.x, 'and does not dip');
  });

  test('azimuth is positive toward +y and only rotates the trajectory', () => {
    const base = { x0: 0.3, y0: 0.3, z0: 2.6, speedKmh: 150, elevDeg: -4, spinRpm: 2500, spin: 'slice' };
    const straight = simulate(base);
    const right = simulate({ ...base, azimDeg: 10 });
    assert.ok(right.landing.y > straight.landing.y + 2);
    const dist = (s) => Math.hypot(s.landing.x - base.x0, s.landing.y - base.y0);
    near(dist(right), dist(straight), 1e-9, 'landing distance');
    near(right.landing.t, straight.landing.t, 1e-9, 'flight time');
  });

  test('net record: clearance uses the local net height, null if the ball drops short', () => {
    const sim = simulate({ y0: 0.3, z0: 2.6, speedKmh: 150, elevDeg: -4, azimDeg: -12 });
    near(sim.net.clearance, sim.net.z - R - netHeightAt(sim.net.y), 1e-12);
    assert.ok(sim.net.y < -2 && sim.net.t > 0 && sim.net.t < sim.landing.t);
    assert.ok(sim.landing.x > COURT.netX);

    const short = simulate({ z0: 2.6, speedKmh: 150, elevDeg: -20 });
    assert.equal(short.net, null);
    assert.ok(short.landing.x < COURT.netX);

    const intoNet = simulate({ z0: 2.6, speedKmh: 150, elevDeg: -8 });
    assert.ok(intoNet.net.clearance < 0, 'a too-low serve reports negative clearance');
  });

  test('path is sampled about every 20 ms from contact to landing', () => {
    const args = { x0: 0.3, y0: 0.3, z0: 2.6, speedKmh: 150, elevDeg: -4 };
    const { path, landing, maxHeight } = simulate(args);
    assert.deepEqual(path[0], { t: 0, x: 0.3, y: 0.3, z: 2.6 });
    const last = path.at(-1);
    near(last.t, landing.t, 1e-12);
    near(last.x, landing.x, 1e-12);
    near(last.z, R, 1e-6, 'path ends with the ball on the ground');
    for (let i = 1; i < path.length; i++) {
      const gap = path[i].t - path[i - 1].t;
      assert.ok(gap > 0 && gap <= 0.02 + 1e-9, `gap ${gap}`);
      if (i < path.length - 1) near(gap, 0.02, 1e-9);
    }
    near(path.length, landing.t / 0.02 + 1, 1.5);
    assert.equal(maxHeight, 2.6); // 아래로 친 서브의 최고점은 컨택 높이
  });

  test('rejects bad input', () => {
    assert.throws(() => simulate({ speedKmh: 100, elevDeg: 0 }), RangeError);
    assert.throws(() => simulate({ z0: 1, speedKmh: 100, elevDeg: 0, spinRpm: 1000, spin: 'wobble' }), RangeError);
    assert.throws(() => serveWindow({ contactHeight: 2.5, speedKmh: 150, target: 'corner' }), RangeError);
    assert.throws(() => serveWindow({ contactHeight: 2.5, speedKmh: 150, court: 'left' }), RangeError);
  });
});

describe('straightLineMinHeight', () => {
  test('classic geometric minimum is about 2.7 m', () => {
    const tee = straightLineMinHeight({ contactForward: 0, target: 'T' });
    between(tee, 2.6, 2.9, 'baseline → service line');
    near(straightLineMinHeight(), tee, 1e-12, 'defaults');
    // 닮은 삼각형: 네트 높이 × 18.285 / 6.4 (+ 공 반지름), T 서브는 네트 가운데 근처를 지난다
    near(tee, R + 0.914 * (18.285 / 6.4), 0.02);
  });

  test('wide needs more height (higher net), contact inside the baseline needs less', () => {
    const tee = straightLineMinHeight({ target: 'T' });
    const body = straightLineMinHeight({ target: 'body' });
    const wide = straightLineMinHeight({ target: 'wide' });
    assert.ok(tee < body && body < wide);
    between(wide, 2.6, 2.9);
    assert.ok(straightLineMinHeight({ contactForward: 0.5 }) < tee);
    near(straightLineMinHeight({ court: 'ad' }), tee, 1e-12);
  });

  test('agrees with the simulator when gravity and drag are switched off', () => {
    const constants = { gravity: 0, Cd: 0 };
    for (const target of ['T', 'wide']) {
      const h = straightLineMinHeight({ contactForward: 0.3, target });
      const above = serveWindow({ contactHeight: h + 0.02, speedKmh: 150, target, constants });
      const below = serveWindow({ contactHeight: h - 0.02, speedKmh: 150, target, constants });
      assert.ok(above.feasible && above.windowDeg < 0.1, `${target}: just above the minimum is barely possible`);
      assert.ok(!below.feasible && below.windowDeg === 0, `${target}: just below the minimum is impossible`);
    }
  });
});

describe('serveWindow', () => {
  const flat = (contactHeight, speedKmh, extra = {}) => serveWindow({ contactHeight, speedKmh, ...extra });

  test('window grows with contact height (2.3 → 2.9 m)', () => {
    const heights = [2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9];
    const windows = sweep(serveWindow, { speedKmh: 150 }, 'contactHeight', heights).map((p) => p.result.windowDeg);
    strictlyIncreasing(windows, 'window vs contact height');
    assert.ok(windows.at(-1) > 1.5 * windows[0]);
    // 앱의 대표 문구: 컨택을 10 cm 올리면 창이 넓어진다
    assert.ok(flat(2.65, 150).windowDeg > flat(2.55, 150).windowDeg + 0.1);
  });

  test('window shrinks with speed for flat serves (120 → 200 km/h)', () => {
    const speeds = [120, 140, 160, 180, 200];
    const windows = sweep(serveWindow, { contactHeight: 2.7 }, 'speedKmh', speeds).map((p) => p.result.windowDeg);
    strictlyIncreasing([...windows].reverse(), 'window vs speed (reversed)');
    assert.ok(windows[0] > 2 * windows.at(-1));
  });

  test('topspin and kick open the window compared with flat at the same speed', () => {
    for (const speedKmh of [120, 150, 180]) {
      const base = { contactHeight: 2.55, speedKmh, spinRpm: 3000 };
      const flatWin = serveWindow({ ...base, spin: 'flat' }).windowDeg;
      const topWin = serveWindow({ ...base, spin: 'topspin' }).windowDeg;
      const kickWin = serveWindow({ ...base, spin: 'kick' }).windowDeg;
      const sliceWin = serveWindow({ ...base, spin: 'slice' }).windowDeg;
      assert.ok(topWin > flatWin * 1.3, `${speedKmh}: topspin ${topWin} vs flat ${flatWin}`);
      assert.ok(kickWin > flatWin * 1.3, `${speedKmh}: kick ${kickWin} vs flat ${flatWin}`);
      assert.ok(topWin >= kickWin && kickWin > sliceWin && sliceWin > flatWin);
      // 더 많은 스핀 → 더 넓은 창
      assert.ok(serveWindow({ ...base, spin: 'topspin', spinRpm: 4000 }).windowDeg > topWin);
    }
  });

  test('190 km/h flat to the T: about 1–3° from 2.75 m, next to nothing from 2.2 m', () => {
    const tall = flat(2.75, 190);
    assert.equal(tall.feasible, true);
    between(tall.windowDeg, 1, 3, 'window from 2.75 m');
    assert.ok(tall.minElevDeg < 0 && tall.maxElevDeg < 0, 'a fast serve is hit downward');

    const low = flat(2.2, 190);
    assert.ok(!low.feasible || low.windowDeg < 0.5, `window from 2.2 m: ${low.windowDeg}`);
  });

  test('wide crosses a higher part of the net than T', () => {
    const [tee, body, wide] = ['T', 'body', 'wide'].map((target) => flat(2.55, 150, { target }));
    assert.ok(wide.netHeightOnPathCm > body.netHeightOnPathCm && body.netHeightOnPathCm > tee.netHeightOnPathCm);
    between(tee.netHeightOnPathCm, 91.4, 92.5);
    between(wide.netHeightOnPathCm, 95, 100);
    assert.ok(wide.distanceToServiceLineM > tee.distanceToServiceLineM);
    near(tee.distanceToServiceLineM, Math.hypot(18.285 - 0.3, 0.7), 1e-9);
    assert.ok(wide.windowDeg < tee.windowDeg, 'higher net → smaller window');
  });

  test('limits agree with simulate to 0.01°', () => {
    for (const args of [
      { contactHeight: 2.55, speedKmh: 150 },
      { contactHeight: 2.7, speedKmh: 130, spinRpm: 3000, spin: 'kick', target: 'wide', court: 'ad' },
    ]) {
      const win = serveWindow(args);
      assert.equal(win.minLaunch.elevDeg, win.minElevDeg);
      assert.equal(win.maxLaunch.elevDeg, win.maxElevDeg);
      // 하한 궤적은 네트를 겨우 넘고, 상한 궤적은 서비스라인에 겨우 떨어진다
      const lowest = simulate(win.minLaunch);
      const highest = simulate(win.maxLaunch);
      between(lowest.net.clearance, -1e-12, 0.004, 'net clearance at the lower limit');
      between(COURT.farServiceLineX - highest.landing.x, -1e-12, 0.05, 'distance inside the line at the upper limit');
      near(lowest.landing.y, win.targetY, 1e-6);
      near(highest.landing.y, win.targetY, 1e-6);
      const low = (d) => simulate({ ...win.minLaunch, elevDeg: win.minElevDeg + d });
      const high = (d) => simulate({ ...win.maxLaunch, elevDeg: win.maxElevDeg + d });
      assert.ok(low(0.01).net.clearance >= 0, 'clears the net just above the lower limit');
      assert.ok(low(-0.01).net.clearance < 0, 'hits the net 0.01° below the lower limit');
      assert.ok(high(-0.01).landing.x <= COURT.farServiceLineX, 'in just below the upper limit');
      assert.ok(high(0.01).landing.x > COURT.farServiceLineX, 'long 0.01° above the upper limit');
      near(win.windowDeg, win.maxElevDeg - win.minElevDeg, 1e-12);
      near(win.toleranceDeg, win.windowDeg / 2, 1e-12);
    }
  });

  test('best is the middle of the window and can be replayed with simulate', () => {
    const win = flat(2.55, 150);
    const { best } = win;
    near(best.elevDeg, (win.minElevDeg + win.maxElevDeg) / 2, 1e-12);
    between(best.netClearanceCm, 5, 40);
    between(best.landingDepthM, 0, 6.4);
    between(best.flightTimeS, 0.3, 0.8);
    between(best.landingSpeedKmh, 90, 150);

    const sim = simulate(best.launch);
    near(sim.landing.y, win.targetY, 1e-6, 'lands on the target line');
    near(sim.landing.x - COURT.netX, best.landingDepthM, 1e-9);
    near(sim.net.clearance * 100, best.netClearanceCm, 1e-6);
    near(sim.landing.t, best.flightTimeS, 1e-9);
    near(sim.speedAtLandingKmh, best.landingSpeedKmh, 1e-9);
    assert.deepEqual(win.contact, { x0: 0.3, y0: 0.3, z0: 2.55 });
  });

  test('deuce and ad courts mirror each other', () => {
    const deuce = flat(2.55, 150, { court: 'deuce', target: 'wide' });
    const ad = flat(2.55, 150, { court: 'ad', target: 'wide' });
    assert.equal(deuce.contact.y0, 0.3);
    assert.equal(ad.contact.y0, -0.3);
    near(deuce.targetY, -(4.115 - 0.4), 1e-12);
    near(ad.targetY, 4.115 - 0.4, 1e-12);
    near(flat(2.55, 150, { target: 'T' }).targetY, -0.4, 1e-12);
    near(flat(2.55, 150, { target: 'body' }).targetY, -4.115 / 2, 1e-12);
    near(ad.windowDeg, deuce.windowDeg, 1e-9);
    near(ad.best.azimDeg, -deuce.best.azimDeg, 1e-9);
    assert.ok(deuce.best.azimDeg < 0, 'deuce serve is aimed to the left');

    // 왼손잡이의 애드 코트 슬라이스 = 오른손잡이의 듀스 코트 슬라이스의 거울상
    const spin = { spinRpm: 3000, spin: 'slice', target: 'wide' };
    const righty = flat(2.6, 140, { ...spin, court: 'deuce', rightHanded: true });
    const lefty = flat(2.6, 140, { ...spin, court: 'ad', rightHanded: false });
    near(lefty.windowDeg, righty.windowDeg, 1e-9);
    near(lefty.best.azimDeg, -righty.best.azimDeg, 1e-9);
  });

  test('azimuth solver lands curving serves on the target line', () => {
    for (const spin of ['slice', 'kick']) {
      for (const court of ['deuce', 'ad']) {
        for (const target of ['T', 'body', 'wide']) {
          for (const rightHanded of [true, false]) {
            const win = serveWindow({ contactHeight: 2.7, speedKmh: 140, spinRpm: 3000, spin, court, target, rightHanded });
            const label = `${spin}/${court}/${target}/${rightHanded ? 'R' : 'L'}`;
            assert.ok(win.feasible, label);
            // 방위각은 고도각마다 따로 푼다 (요구 정밀도 0.15 m, 실제로는 수치 오차 수준)
            for (const launch of [win.minLaunch, win.best.launch, win.maxLaunch]) {
              const sim = simulate(launch);
              near(sim.landing.y, win.targetY, 1e-6, `${label} @${launch.elevDeg.toFixed(2)}°`);
              assert.ok(sim.landing.x > COURT.netX && sim.landing.x <= COURT.farServiceLineX, `${label} in the box`);
              assert.ok(Math.sign(sim.landing.y) === (court === 'deuce' ? -1 : 1), `${label} correct box`);
            }
          }
        }
      }
    }
    // 오른손잡이 슬라이스는 왼쪽으로 휘므로 플랫보다 오른쪽을 겨냥해야 한다
    const sliceAim = serveWindow({ contactHeight: 2.7, speedKmh: 140, spinRpm: 3000, spin: 'slice' }).best.azimDeg;
    const flatAim = flat(2.7, 140).best.azimDeg;
    assert.ok(sliceAim > flatAim + 1, `slice aim ${sliceAim} vs flat ${flatAim}`);
  });

  test('impossible serves report a zero window instead of failing', () => {
    const tooFast = flat(2.0, 200);
    assert.equal(tooFast.feasible, false);
    assert.equal(tooFast.windowDeg, 0);
    assert.equal(tooFast.toleranceDeg, 0);
    assert.ok(tooFast.minElevDeg > tooFast.maxElevDeg, 'net limit is above the long limit');
    assert.ok(tooFast.best.netClearanceCm < 0 || tooFast.best.landingDepthM > 6.4, 'the compromise angle still misses');

    const tooSlow = flat(2.5, 30); // 어떤 각도로도 네트까지 못 간다
    assert.equal(tooSlow.feasible, false);
    assert.equal(tooSlow.windowDeg, 0);
    assert.ok(Number.isNaN(tooSlow.minElevDeg) && Number.isNaN(tooSlow.maxElevDeg));
    assert.equal(tooSlow.best, null);
    assert.equal(tooSlow.minLaunch, null);
    assert.equal(tooSlow.maxLaunch, null);

    assert.throws(() => serveWindow({ speedKmh: 150 }), { name: 'RangeError', message: /contactHeight/ });
  });

  test('slow serves have a wide, upward window', () => {
    const slow = flat(2.5, 80);
    assert.ok(slow.feasible && slow.windowDeg > 4);
    assert.ok(slow.maxElevDeg > 0, 'an 80 km/h serve can be hit upward');
    assert.equal(slow.maxElevCapped, false);
  });
});

describe('groundWindow', () => {
  const flatWin = groundWindow({ speedKmh: 110, spin: 'flat' });
  const topWin = groundWindow({ speedKmh: 110, spinRpm: 2500, spin: 'topspin' });

  test('110 km/h from the baseline at 0.9 m: topspin gives a clearly larger window than flat', () => {
    assert.ok(flatWin.feasible && topWin.feasible);
    between(flatWin.windowDeg, 2, 5, 'flat window');
    between(topWin.windowDeg, flatWin.windowDeg * 1.5, 10, 'topspin window');
    assert.ok(flatWin.minElevDeg > 0, 'must be hit upward to clear the net');
    assert.ok(topWin.minElevDeg > flatWin.minElevDeg && topWin.maxElevDeg > flatWin.maxElevDeg);
    assert.deepEqual(flatWin.contact, { x0: 0, y0: 3, z0: 0.9 });
    near(groundWindow({ speedKmh: 110, spinRpm: 2500 }).windowDeg, topWin.windowDeg, 1e-12, 'spin defaults to topspin');
    assert.ok(groundWindow({ speedKmh: 110, spinRpm: 2500, spin: 'backspin' }).windowDeg < flatWin.windowDeg);
  });

  test('limits agree with simulate', () => {
    for (const win of [flatWin, topWin]) {
      const at = (elevDeg) => simulate({ ...win.best.launch, elevDeg });
      between(simulate(win.minLaunch).net.clearance, -1e-12, 0.004, 'net clearance at the lower limit');
      between(COURT.farBaselineX - simulate(win.maxLaunch).landing.x, -1e-12, 0.05, 'inside the baseline at the upper limit');
      assert.ok(at(win.minElevDeg + 0.01).net.clearance >= 0);
      assert.ok(at(win.minElevDeg - 0.01).net.clearance < 0);
      assert.ok(at(win.maxElevDeg - 0.01).landing.x <= COURT.farBaselineX);
      assert.ok(at(win.maxElevDeg + 0.01).landing.x > COURT.farBaselineX);
      near(win.best.elevDeg, (win.minElevDeg + win.maxElevDeg) / 2, 1e-12);
      between(win.best.landingDepthM, 0, COURT.farBaselineX - COURT.netX);
      assert.ok(win.best.netClearanceCm > 0);
    }
    // 같은 베이스라인 깊이에 떨어질 때 탑스핀 공이 더 높이 넘어가고 더 가파르게 떨어진다
    const flatDeep = simulate(flatWin.maxLaunch);
    const topDeep = simulate(topWin.maxLaunch);
    assert.ok(topDeep.landing.angleDeg > flatDeep.landing.angleDeg + 3);
    assert.ok(topDeep.net.clearance > flatDeep.net.clearance + 0.3);
  });

  test('cross-court is safer than down the line: lower net and a longer court', () => {
    const line = groundWindow({ speedKmh: 110, spinRpm: 2500 });
    const cross = groundWindow({ speedKmh: 110, spinRpm: 2500, crossCourt: true });
    assert.ok(cross.windowDeg > line.windowDeg + 0.3);
    assert.ok(cross.netHeightOnPathCm < line.netHeightOnPathCm - 3);
    near(cross.netHeightOnPathCm, 91.4, 0.5);
    assert.ok(cross.distanceToBaselineM > line.distanceToBaselineM);
    near(line.distanceToBaselineM, 23.77, 1e-9);
    assert.equal(line.targetY, 3);
    assert.equal(cross.targetY, -3);
    const sim = simulate(cross.best.launch);
    // 착지점은 컨택점(0, 3) → 목표점(23.77, −3) 직선 위
    near(sim.landing.y, 3 - (6 * sim.landing.x) / 23.77, 1e-6);
    // startY 로 위치를 바꿀 수 있다: 가운데에서 정면으로, 코트 밖으로 밀려난 자리에서는 목표를 사이드라인 안쪽으로
    const middle = groundWindow({ speedKmh: 110, spinRpm: 2500, startY: 0, crossCourt: true });
    near(middle.netHeightOnPathCm, 91.4, 1e-9);
    assert.ok(Object.is(middle.targetY, 0) && Object.is(middle.best.azimDeg, 0));
    const pulledWide = groundWindow({ speedKmh: 110, spinRpm: 2500, startY: -5 });
    near(pulledWide.targetY, -(4.115 - 0.4), 1e-12);
    assert.ok(pulledWide.best.azimDeg > 0, 'aims back into the court');
    near(groundWindow({ speedKmh: 110, spinRpm: 2500, startY: -5, crossCourt: true }).targetY, 4.115 - 0.4, 1e-12);
  });

  test('minDepthFromNet and court position move the lower limit', () => {
    const deep = groundWindow({ speedKmh: 110, spinRpm: 2500, minDepthFromNet: 8 });
    assert.ok(deep.minElevDeg > topWin.minElevDeg + 1);
    near(deep.maxElevDeg, topWin.maxElevDeg, 1e-9);
    assert.ok(deep.windowDeg < topWin.windowDeg);
    const atLimit = simulate({ ...deep.best.launch, elevDeg: deep.minElevDeg });
    near(atLimit.landing.x - COURT.netX, 8, 0.05, 'lower limit lands at the required depth');

    const behind = groundWindow({ speedKmh: 110, spin: 'flat', fromBaseline: 2 });
    assert.equal(behind.contact.x0, -2);
    assert.ok(behind.minElevDeg > flatWin.minElevDeg && behind.maxElevDeg > flatWin.maxElevDeg);
    const inside = groundWindow({ speedKmh: 110, spin: 'flat', fromBaseline: -2 });
    assert.ok(inside.maxElevDeg < flatWin.maxElevDeg);
  });

  test('slow balls never go long below the elevation cap', () => {
    const slow = groundWindow({ speedKmh: 60, spin: 'flat' });
    assert.equal(slow.maxElevCapped, true);
    assert.equal(slow.maxElevDeg, DEFAULTS.elevCapDeg);
    assert.ok(slow.feasible);
    assert.equal(groundWindow({ speedKmh: 30, spin: 'flat' }).feasible, false);
  });
});

describe('sweep', () => {
  test('returns { value, result } per value without touching the base arguments', () => {
    const base = { speedKmh: 150, contactHeight: 2.5 };
    const points = sweep(serveWindow, base, 'contactHeight', [2.4, 2.6]);
    assert.deepEqual(points.map((p) => p.value), [2.4, 2.6]);
    assert.deepEqual(base, { speedKmh: 150, contactHeight: 2.5 });
    near(points[1].result.windowDeg, serveWindow({ speedKmh: 150, contactHeight: 2.6 }).windowDeg, 1e-12);
    assert.deepEqual(sweep(serveWindow, base, 'contactHeight', []), []);

    const spins = sweep(groundWindow, { speedKmh: 110 }, 'spinRpm', [0, 1500, 3000]).map((p) => p.result.windowDeg);
    strictlyIncreasing(spins, 'groundstroke window vs topspin');
    const calls = sweep((args) => args.x * 2, { x: 0, keep: 1 }, 'x', new Set([1, 2]));
    assert.deepEqual(calls, [{ value: 1, result: 2 }, { value: 2, result: 4 }]);
  });
});

describe('court boundaries and fixed aim', () => {
  const inside = (flight, farX, minY, maxY) => flight.landed && flight.net !== null &&
    flight.net.clearance >= 0 && flight.landing.x >= COURT.netX && flight.landing.x <= farX &&
    flight.landing.y >= minY && flight.landing.y <= maxY;

  test('pulled-wide groundstrokes must enter both singles and doubles sidelines', () => {
    for (const startY of [-8, 8]) {
      for (const doubles of [false, true]) {
        const win = groundWindow({ speedKmh: 110, spin: 'flat', startY, doubles });
        const width = doubles ? COURT.doublesHalfWidth : COURT.singlesHalfWidth;
        assert.ok(win.feasible);
        for (const launch of [win.minLaunch, win.best.launch, win.maxLaunch]) {
          assert.ok(inside(simulate(launch), COURT.farBaselineX, -width, width));
        }
        const outside = simulate({ ...win.minLaunch, elevDeg: win.minElevDeg - 0.01 });
        assert.ok(outside.net.clearance > 0 && outside.landing.x < COURT.farBaselineX);
        assert.ok(Math.abs(outside.landing.y) > width, 'lower bound is the sideline, not net or baseline');
      }
    }
  });

  test('doubles accepts alley landings while singles aims inside its narrower court', () => {
    const args = { speedKmh: 110, spin: 'flat', startY: 5 };
    const doubles = groundWindow({ ...args, doubles: true });
    const singles = groundWindow(args);
    assert.ok(simulate(doubles.best.launch).landing.y > COURT.singlesHalfWidth);
    assert.ok(simulate(doubles.best.launch).landing.y <= COURT.doublesHalfWidth);
    assert.ok(simulate(singles.best.launch).landing.y <= COURT.singlesHalfWidth);
    assert.deepEqual(singles, groundWindow({ ...args, doubles: false }));
  });

  test('serves land inside the correct service box in both dimensions', () => {
    for (const court of ['deuce', 'ad']) {
      for (const target of ['T', 'wide']) {
        const win = serveWindow({ contactHeight: 2.7, speedKmh: 80, spin: 'slice', spinRpm: 6000, court, target });
        const [minY, maxY] = court === 'deuce' ? [-COURT.singlesHalfWidth, 0] : [0, COURT.singlesHalfWidth];
        assert.ok(win.feasible);
        for (const launch of [win.minLaunch, win.best.launch, win.maxLaunch]) {
          assert.ok(inside(simulate(launch), COURT.farServiceLineX, minY, maxY));
        }
        // Unreachable lateral target: the clamped azimuth can clear the net and land
        // before the service line while still being in the wrong half or beyond a sideline.
        const unreachable = serveWindow({ contactHeight: 5, speedKmh: 500, standY: 200, court, target, constants: VACUUM });
        assert.equal(unreachable.feasible, false);
        assert.equal(unreachable.windowDeg, 0);
      }
    }
  });

  test('named ranges retain aliases and fixed-aim width matches independent elevation samples', () => {
    const cases = [
      [groundWindow({ speedKmh: 80, spin: 'slice', spinRpm: 6000, startY: 4 }), COURT.farBaselineX, -COURT.singlesHalfWidth, COURT.singlesHalfWidth],
      [serveWindow({ contactHeight: 2.7, speedKmh: 80, spin: 'slice', spinRpm: 6000, target: 'wide' }), COURT.farServiceLineX, -COURT.singlesHalfWidth, 0],
      [serveWindow({ contactHeight: 2.7, speedKmh: 80, spin: 'slice', spinRpm: 6000, target: 'T', court: 'ad' }), COURT.farServiceLineX, 0, COURT.singlesHalfWidth],
    ];
    for (const [win, farX, minY, maxY] of cases) {
      assert.equal(win.elevRangeReaimedDeg, win.windowDeg);
      assert.equal(win.toleranceDeg, win.elevRangeReaimedDeg / 2);
      const resolution = 0.02;
      let count = 0;
      for (let e = win.best.elevDeg - 20; e <= win.best.elevDeg + 20; e += resolution) {
        if (inside(simulate({ ...win.best.launch, elevDeg: e }), farX, minY, maxY)) count++;
      }
      near(win.fixedAimWindowDeg, count * resolution, 2 * resolution, 'fixed azimuth sampling');
    }
    assert.ok(cases[0][0].fixedAimWindowDeg < cases[0][0].elevRangeReaimedDeg - 1);
    assert.ok(cases[1][0].fixedAimWindowDeg < cases[1][0].elevRangeReaimedDeg - 0.5);
  });

  test('impossible and capped windows expose both new widths', () => {
    for (const win of [serveWindow({ contactHeight: 2, speedKmh: 200 }), groundWindow({ speedKmh: 30 })]) {
      assert.equal(win.elevRangeReaimedDeg, 0);
      assert.equal(win.fixedAimWindowDeg, 0);
    }
    const capped = groundWindow({ speedKmh: 60, spin: 'flat', startY: 0 });
    assert.equal(capped.maxElevCapped, true);
    near(capped.fixedAimWindowDeg, capped.windowDeg, DEFAULTS.elevTolDeg);
  });
});

describe('validation and time limits', () => {
  const simArgs = { z0: 2.6, speedKmh: 150, elevDeg: -4 };
  const calls = [
    (constants) => simulate({ ...simArgs, constants }),
    (constants) => serveWindow({ contactHeight: 2.6, speedKmh: 150, constants }),
    (constants) => groundWindow({ speedKmh: 110, constants }),
  ];

  test('rejects nonpositive and nonfinite integration and scan constants', () => {
    for (const key of ['dt', 'elevScanStepDeg', 'maxTime', 'elevTolDeg']) {
      for (const value of [0, -1, NaN, Infinity, -Infinity]) {
        for (const call of calls) {
          assert.throws(() => call({ [key]: value }), { name: 'RangeError', message: new RegExp(key) });
        }
      }
    }
  });

  test('rejects invalid speeds and contact heights in every trajectory API', () => {
    for (const value of [0, -1, NaN, Infinity, -Infinity, null]) {
      for (const call of [
        () => simulate({ ...simArgs, speedKmh: value }),
        () => serveWindow({ contactHeight: 2.6, speedKmh: value }),
        () => groundWindow({ speedKmh: value }),
      ]) assert.throws(call, { name: 'RangeError', message: /speedKmh/ });
      for (const call of [
        () => simulate({ ...simArgs, z0: value }),
        () => serveWindow({ contactHeight: value, speedKmh: 150 }),
        () => groundWindow({ contactHeight: value, speedKmh: 110 }),
      ]) assert.throws(call, { name: 'RangeError', message: /contactHeight|z0/ });
    }
  });

  test('rejects excessive flight/scan iteration budgets without starting loops', () => {
    for (const call of calls) {
      for (const constants of [{ dt: 1e-300 }, { maxTime: 1e100 }, { elevScanStepDeg: 1e-300 }]) {
        assert.throws(() => call(constants), { name: 'RangeError', message: /iterations/ });
      }
    }
    // Even a tolerance below floating-point resolution cannot trap bisection.
    assert.ok(groundWindow({ speedKmh: 110, constants: { elevTolDeg: Number.MIN_VALUE } }).feasible);
  });

  test('timeout has no fake landing and ends the path exactly at maxTime', () => {
    const flight = simulate({ ...simArgs, constants: { maxTime: 0.005, dt: 0.002 } });
    assert.equal(flight.landed, false);
    assert.equal(flight.reason, 'timeout');
    assert.equal(flight.landing, null);
    assert.equal(flight.speedAtLandingKmh, null);
    assert.equal(flight.path.at(-1).t, 0.005);
    assert.ok(flight.path.at(-1).z > R);
    const normal = simulate(simArgs);
    assert.equal(normal.landed, true);
    assert.ok(normal.landing && !normal.reason);
  });

  test('a final partial step cannot invent a landing after the deadline', () => {
    const args = { z0: 0.1, speedKmh: 10, elevDeg: 0, constants: { ...VACUUM, dt: 0.1, maxTime: 0.11 } };
    assert.equal(simulate(args).landed, false); // analytic ground contact is about 0.117 s
    const landed = simulate({ ...args, constants: { ...args.constants, maxTime: 0.13 } });
    assert.equal(landed.landed, true);
    assert.ok(landed.landing.t <= 0.13);
  });

  test('window solvers handle timeouts without dereferencing null landings', () => {
    for (const fn of [serveWindow, groundWindow]) {
      const win = fn({ contactHeight: 2.6, speedKmh: 150, constants: { maxTime: 0.001 } });
      assert.equal(win.feasible, false);
      assert.equal(win.windowDeg, 0);
      assert.equal(win.fixedAimWindowDeg, 0);
      assert.equal(win.best, null);
    }
  });
});

describe('net selection and ball contact height', () => {
  test('singles sticks reach 1.07 m at ±5.029 m, with doubles unchanged by default', () => {
    for (const y of [0, 2, 5.029, 6.399, 9]) {
      assert.equal(netHeightAt(y), netHeightAt(y, 'doubles'));
      assert.equal(netHeightAt(y, 'singles'), netHeightAt(-y, 'singles'));
    }
    near(netHeightAt(0, 'singles'), 0.914, 1e-12);
    near(netHeightAt(5.029, 'singles'), 1.07, 1e-12);
    near(netHeightAt(9, 'singles'), 1.07, 1e-12);
    assert.ok(netHeightAt(4, 'singles') > netHeightAt(4, 'doubles'));
    assert.throws(() => netHeightAt(0, 'unknown'), RangeError);
  });

  test('net selection propagates through simulations, windows, replay and geometry', () => {
    const args = { z0: 2.6, y0: 4, speedKmh: 150, elevDeg: -4 };
    const singles = simulate({ ...args, net: 'singles' });
    const doubles = simulate(args);
    assert.deepEqual(singles.landing, doubles.landing);
    assert.ok(singles.net.clearance < doubles.net.clearance);
    near(singles.net.clearance, singles.net.z - R - netHeightAt(singles.net.y, 'singles'), 1e-12);
    for (const fn of [serveWindow, groundWindow]) {
      const win = fn({ contactHeight: 2.6, speedKmh: 110, target: 'wide', net: 'singles' });
      assert.ok(win.feasible);
      assert.equal(win.best.launch.net, 'singles');
      near(win.netHeightOnPathCm, 100 * netHeightAt(win.best.netY, 'singles'), 1e-12);
      near(simulate(win.best.launch).net.clearance * 100, win.best.netClearanceCm, 1e-9);
      assert.equal(win.minLaunch.net, 'singles');
      assert.equal(win.maxLaunch.net, 'singles');
    }
    assert.ok(straightLineMinHeight({ target: 'wide', net: 'singles' }) > straightLineMinHeight({ target: 'wide' }));
  });

  test('ball contact scenario ranges use metres for serve, forehand and backhand', () => {
    const serve = ballContactHeight({ wristHeightM: 2, stroke: 'serve' });
    near(serve.low, 2.40, 1e-12);
    near(serve.mid, 2.475, 1e-12);
    near(serve.high, 2.55, 1e-12);
    for (const stroke of ['forehand', 'backhand']) {
      assert.deepEqual(ballContactHeight({ wristHeightM: 1, stroke }), { low: 0.9, mid: 1, high: 1.1 });
    }
    assert.throws(() => ballContactHeight({ wristHeightM: NaN, stroke: 'serve' }), RangeError);
    assert.throws(() => ballContactHeight({ wristHeightM: 1, stroke: 'volley' }), RangeError);
  });
});

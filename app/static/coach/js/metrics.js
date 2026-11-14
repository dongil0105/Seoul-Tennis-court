// 스윙 코치 — 자세에서 재는 수치. DOM 을 쓰지 않는다(브라우저·Node 공용).
//
// 두 종류가 있다.
//  · poseMetrics: 자세 한 장에서 재는 것(카메라 방향과 상관없다) — 선수 사진과 내 영상의 같은 순간을 같은 자로 잰다.
//  · swingMetrics: 스윙 전체에서 재는 것 — 옆에서 찍은 영상의 '타점이 얼마나 앞인가', 임팩트 높이, 점프 등.
// 길이는 모두 '키의 몇 배'(예: 0.12 = 키 170cm 면 약 20cm).
import * as G from './geom.js';

const { J } = G;
const UP = [0, -1, 0];
const flex = (a, b, c) => 180 - G.angleAt(a, b, c);            // 굽힘 각(곧게 펴면 0)

/** 자세 한 장의 수치. hand = 치는 손. h = 그 사람의 키(모델 미터) — 영상이면 bodyScale 로 고정한 값을 넘긴다. */
export function poseMetrics(pose, hand = 'R', h = G.statureW(pose)) {
  const w = pose.w, S = G.sides(hand), sign = hand === 'L' ? -1 : 1;
  if (!(h > 0)) return null;
  const midSh = G.mid(w[J.lSh], w[J.rSh]), midHip = G.mid(w[J.lHip], w[J.rHip]);
  const fs = G.bodyFrame(pose, 'shoulders'), fh = G.bodyFrame(pose, 'hips');
  const trunk = G.sub(midSh, midHip);
  const wr = G.inBody(fs, w[S.hit.wr], midSh);                  // 손목: (오른쪽, 위, 앞)
  const footY = Math.max(w[J.lHeel][1], w[J.rHeel][1], w[J.lToe][1], w[J.rToe][1]);   // 더 낮은 발(y 는 아래로)
  const shDx = G.sub(w[S.hit.sh], w[S.off.sh]);
  const sepRaw = G.deg(Math.atan2(G.cross(fh.R, fs.R)[1], G.dot(fh.R, fs.R)));        // 골반 대비 어깨가 돈 각
  return {
    kneeHit: flex(w[S.hit.hip], w[S.hit.knee], w[S.hit.ank]),
    kneeOff: flex(w[S.off.hip], w[S.off.knee], w[S.off.ank]),
    elbowHit: G.angleAt(w[S.hit.sh], w[S.hit.el], w[S.hit.wr]),   // 180 = 곧게 폄
    elbowOff: G.angleAt(w[S.off.sh], w[S.off.el], w[S.off.wr]),
    armTrunk: G.angleAt(w[S.hit.el], w[S.hit.sh], w[S.hit.hip]),  // 팔과 몸통 사이 각(겨드랑이)
    shoulderTilt: G.deg(Math.atan2(-shDx[1], Math.hypot(shDx[0], shDx[2]))),   // 치는 쪽 어깨가 더 높으면 +
    trunkTilt: G.angleBetween(trunk, UP),                           // 몸통이 수직에서 기운 각
    trunkLeanF: G.deg(Math.atan2(G.dot(trunk, fh.F), G.dot(trunk, UP))),          // 앞으로 숙이면 +
    trunkLeanSide: G.deg(Math.atan2(G.dot(trunk, fh.R) * sign, G.dot(trunk, UP))), // 치는 쪽으로 기울면 +
    sep: Math.abs(sepRaw),                                          // 골반–어깨 꼬임(크기)
    sepSigned: sepRaw * sign,                                       // 부호 있는 꼬임(치는 손 기준으로 맞춤)
    wristUp: (w[J.nose][1] - w[S.hit.wr][1]) / h,                   // 손목이 코보다 얼마나 위
    offWristUp: (w[J.nose][1] - w[S.off.wr][1]) / h,
    wristFront: wr[2] / h,                                          // 가슴 앞쪽으로 얼마나
    wristSide: (wr[0] * sign) / h,                                  // 치는 쪽 옆으로 얼마나
    wristOverFoot: (footY - w[S.hit.wr][1]) / h,                    // 더 낮은 발에서 손목까지(점프 중이면 바닥 기준이 아니다)
    stance: G.dist(w[J.lAnk], w[J.rAnk]) / h,
    reach: G.dist(w[S.hit.wr], w[S.hit.sh]) / ((G.dist(w[S.hit.sh], w[S.hit.el]) + G.dist(w[S.hit.el], w[S.hit.wr])) || 1),
    hands: G.dist(w[J.lWr], w[J.rWr]) / h,
    vis: G.vis(pose, S.hit.wr, S.hit.el, S.hit.sh, S.off.sh, J.lHip, J.rHip, J.lKnee, J.rKnee, J.lAnk, J.rAnk),
  };
}

/**
 * 사진 한 장이 스트로크의 어느 순간인지 예측한다(선수 사진을 순간별로 나눌 때). 모르면 null.
 * stroke: 'serve'|'forehand'|'backhand', m = poseMetrics 결과(오른손 기준으로 뒤집어 잰 것이어도 된다).
 */
export function guessPhase(stroke, m) {
  if (stroke === 'serve') {
    // 임팩트: 치는 손이 머리 위로 뻗어 있고, 반대 손(토스한 손)은 이미 내려와 있다. 팔이 귀에 붙을 만큼 수직이면 토스하는 팔이다.
    if (m.wristUp > 0.22 && m.elbowHit > 140 && m.offWristUp < 0 && m.armTrunk < 162) return 'contact';
    if (m.offWristUp > 0.02 && m.elbowHit < 135 && m.wristUp > -0.2 && m.wristUp < 0.3) return 'trophy';
    return null;
  }
  if (stroke === 'forehand') {
    if (m.wristFront > 0.1 && m.wristSide > -0.06 && m.wristUp < 0.05) return 'contact';
    if (m.wristFront < 0.02 && m.wristSide > 0.08) return 'backswing';
    if (m.wristSide < -0.06 && m.wristFront > 0) return 'finish';
    return null;
  }
  if (stroke === 'backhand') {
    if (m.wristFront > 0.1 && m.wristSide > -0.12 && m.wristSide < 0.2 && m.wristUp < 0.05) return 'contact';
    if (m.wristSide < -0.1 && m.wristFront < 0.12) return 'backswing';
    if (m.wristSide > 0.2 && m.wristUp > -0.1) return 'finish';
    return null;
  }
  return null;
}

/**
 * 스윙 전체 수치. frames/swing 은 swing.js 의 것. W,H = 영상 픽셀 크기.
 * 이름에 주의: 여기서 재는 것은 '손목'이다(공이 아니다). 화면 위치를 견주는 값은 카메라를 고정해 찍었다고 본다.
 */
export function swingMetrics(frames, swing, W, H) {
  const S = G.sides(swing.hand), h = swing.h, sf = swing.sf;
  const at = (t) => (t == null ? null : G.poseAt(frames, t));
  const out = { stroke: swing.stroke, view: swing.view, twoHanded: swing.twoHanded, uncertain: swing.uncertain, suspect: !!swing.suspect, sf, sfAuto: swing.sfAuto,
    conf: swing.vis, vis: swing.vis, tcErr: swing.tcErr, posErr: swing.posErr / h, phases: {} };
  for (const [name, t] of Object.entries(swing.keys)) {
    const p = at(t);
    const pm = p && poseMetrics(p, swing.hand, h);
    if (pm) out.phases[name] = pm;
  }
  const pc = at(swing.keys.contact);
  const kOf = (p) => G.pxPerMeter(p, W, H);
  const k = kOf(pc);
  const X = (p, i) => p.lm[i][0] * W, Y = (p, i) => p.lm[i][1] * H;
  const toH = (px, kk = k) => px / kk / h;                          // 픽셀 → 키의 몇 배
  const lowFoot = (p) => Math.max(Y(p, J.lHeel), Y(p, J.rHeel), Y(p, J.lToe), Y(p, J.rToe));
  if (!Number.isFinite(k) || !out.phases.contact) return out;

  // 손목 높이: 스트로크는 같은 프레임의 발 기준(카메라가 움직여도 안 틀린다). 서브는 점프하므로 뜨기 전 바닥 기준.
  out.wristOverFoot = toH(lowFoot(pc) - Y(pc, S.hit.wr));
  if (swing.stroke === 'serve') {
    const ys = [];
    for (let i = swing.i0; i <= swing.i1 && frames[i].t < swing.keys.contact - 0.05 * sf; i++) {
      if (frames[i].t > swing.keys.contact - 1.2 * sf) ys.push(lowFoot(frames[i]));
    }
    const ground = G.percentile(ys, 0.8);
    if (Number.isFinite(ground)) {
      out.wristHeightGround = toH(ground - Y(pc, S.hit.wr));        // 바닥에서 손목까지(임팩트)
      out.jump = Math.max(0, toH(ground - lowFoot(pc)));            // 임팩트 때 발이 뜬 높이
    }
  } else {
    out.wristHeightGround = out.wristOverFoot;
  }

  // 임팩트 시각이 한 장 어긋나도 '높은 공'으로 잘못 보지 않게: 앞뒤 한 장까지 본 것 중 가장 낮은 손목 높이
  if (swing.stroke !== 'serve') {
    const dt = 2 * swing.tcErr, hs2 = [out.wristOverFoot];
    for (const t of [swing.keys.contact - dt, swing.keys.contact + dt]) { const p = at(t); if (p) hs2.push(toH(lowFoot(p) - Y(p, S.hit.wr), kOf(p))); }
    out.wristHeightLo = Math.min(...hs2.filter(Number.isFinite));
  }

  if (swing.view === 'side') {
    const dir = swing.dirX;
    const hipX = (p) => (X(p, J.lHip) + X(p, J.rHip)) / 2;
    const frontAnk = dir * X(pc, J.lAnk) > dir * X(pc, J.rAnk) ? J.lAnk : J.rAnk;
    out.contactFront = toH((X(pc, S.hit.wr) - hipX(pc)) * dir);     // 손목이 골반보다 얼마나 앞(치는 방향)
    out.contactFrontFoot = toH((X(pc, S.hit.wr) - X(pc, frontAnk)) * dir);   // 앞발보다 얼마나 앞
    out.headFront = toH((X(pc, J.nose) - hipX(pc)) * dir);          // 머리가 골반보다 앞(+)·뒤(-) — 뒤로 젖혔나
    const pf = at(swing.keys.finish);
    if (pf) out.hipShift = toH((hipX(pf) - hipX(pc)) * dir);        // 임팩트 뒤 골반이 앞으로 간 만큼(체중 이동 그 자체는 아니다)
  }

  // 임팩트 앞뒤 0.1초 동안 머리가 골반에 대해 흔들린 최대폭(카메라 이동·걸음은 빠진다)
  const hs = [];
  for (let i = swing.i0; i <= swing.i1; i++) {
    const f = frames[i];
    if (Math.abs(f.t - swing.keys.contact) > 0.1 * sf) continue;
    const kk = kOf(f);
    if (!Number.isFinite(kk)) continue;
    hs.push([(X(f, J.nose) - (X(f, J.lHip) + X(f, J.rHip)) / 2) / kk / h, (Y(f, J.nose) - (Y(f, J.lHip) + Y(f, J.rHip)) / 2) / kk / h]);
  }
  if (hs.length >= 3) {
    const mx = hs.reduce((a, p) => a + p[0], 0) / hs.length, my = hs.reduce((a, p) => a + p[1], 0) / hs.length;
    out.headMove = Math.max(...hs.map((p) => Math.hypot(p[0] - mx, p[1] - my)));
  }

  // 가슴이 치는 방향을 얼마나 보고 있나(0 = 정면으로 열림, 90 = 옆으로 섬, 90 넘으면 등을 보일 만큼 돌림). 방향을 모르면 재지 않는다.
  if (swing.dirKnown) {
    const chest = (p) => (p ? G.angleBetween(G.bodyFrame(p, 'shoulders').F, swing.dir) : NaN);
    out.chestAtContact = chest(pc);
    out.hipsAtContact = G.angleBetween(G.bodyFrame(pc, 'hips').F, swing.dir);
    if (swing.stroke === 'serve') out.chestAtTrophy = chest(at(swing.keys.trophy));
    else {
      out.chestAtBackswing = chest(at(swing.keys.backswing));
      // 백스윙 끝 순간이 조금 어긋나도 '턴 부족'으로 잘못 보지 않게: 그 앞뒤 0.1초 중 가장 많이 돈 값
      const tb = swing.keys.backswing, cs = [out.chestAtBackswing];
      if (tb != null) for (const t of [tb - 0.1 * sf, tb - 0.05 * sf, tb + 0.05 * sf, tb + 0.1 * sf]) cs.push(chest(at(t)));
      out.chestAtBackswingHi = Math.max(...cs.filter(Number.isFinite));
    }
  }
  if (swing.stroke === 'serve') {
    const tr = out.phases.trophy, ld = out.phases.load, st = out.phases.start;
    if (tr) { out.tossArmUp = tr.offWristUp; out.tTrophyToContact = (swing.keys.contact - swing.keys.trophy) / sf; }
    if (ld) out.kneeBend = (ld.kneeHit + ld.kneeOff) / 2;           // 무릎이 가장 깊이 굽은 값(두 무릎 평균)
    if (st && tr && st.stance > 0.05) {
      out.stanceRatio = tr.stance / st.stance;                      // 트로피 때 발 간격 ÷ 시작 때 — 작으면 뒷발을 끌어온 것(핀포인트)
      out.stanceType = out.stanceRatio < 0.62 ? 'pinpoint' : 'platform';
    } else out.stanceType = 'unknown';
  } else {
    if (out.phases.load) out.kneeBend = (out.phases.load.kneeHit + out.phases.load.kneeOff) / 2;
    if (swing.keys.backswing != null) out.tBackToContact = (swing.keys.contact - swing.keys.backswing) / sf;
  }
  return out;
}

/** 키(cm)를 주면 '키의 몇 배'를 cm 로 */
export const toCm = (ratio, heightCm = 170) => ratio * heightCm;

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

/** 자세 한 장의 수치. hand = 치는 손. */
export function poseMetrics(pose, hand = 'R') {
  const w = pose.w, S = G.sides(hand), sign = hand === 'L' ? -1 : 1;
  const h = G.statureW(pose) || 1;
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
    wristUp: (w[J.nose][1] - w[S.hit.wr][1]) / h,                   // 손목이 코보다 얼마나 위
    offWristUp: (w[J.nose][1] - w[S.off.wr][1]) / h,
    wristFront: wr[2] / h,                                          // 가슴 앞쪽으로 얼마나
    wristSide: (wr[0] * sign) / h,                                  // 치는 쪽 옆으로 얼마나
    wristHeight: (footY - w[S.hit.wr][1]) / h,                      // 바닥(낮은 발)에서 손목까지
    stance: G.dist(w[J.lAnk], w[J.rAnk]) / h,
    reach: G.dist(w[S.hit.wr], w[S.hit.sh]) / ((G.dist(w[S.hit.sh], w[S.hit.el]) + G.dist(w[S.hit.el], w[S.hit.wr])) || 1),
    hands: G.dist(w[J.lWr], w[J.rWr]) / h,
    vis: G.vis(pose, S.hit.wr, S.hit.el, S.hit.sh, S.off.sh, J.lHip, J.rHip, J.lKnee, J.rKnee, J.lAnk, J.rAnk),
  };
}

/**
 * 사진 한 장이 스트로크의 어느 순간인지 어림한다(선수 사진을 순간별로 나눌 때). 모르면 null.
 * stroke: 'serve'|'forehand'|'backhand', m = poseMetrics 결과(오른손 기준으로 뒤집어 잰 것이어도 된다).
 */
export function guessPhase(stroke, m) {
  if (stroke === 'serve') {
    if (m.wristUp > 0.22 && m.elbowHit > 140) return 'contact';
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
 * 돌려주는 것: { phase별 poseMetrics, 그리고 옆 화면 전용 수치(view==='side' 일 때만 숫자) }
 */
export function swingMetrics(frames, swing, W, H) {
  const S = G.sides(swing.hand);
  const at = (t) => (t == null ? null : G.poseAt(frames, t));
  const out = { stroke: swing.stroke, view: swing.view, twoHanded: swing.twoHanded, sf: swing.sf, conf: swing.conf, phases: {} };
  for (const [name, t] of Object.entries(swing.keys)) {
    const p = at(t);
    if (p) out.phases[name] = poseMetrics(p, swing.hand);
  }

  const pc = at(swing.keys.contact);
  const k = G.pxPerMeter(pc, W, H), h = G.statureW(pc) || 1;
  const X = (p, i) => p.lm[i][0] * W, Y = (p, i) => p.lm[i][1] * H;
  const toH = (px) => px / k / h;                                  // 픽셀 → 키의 몇 배

  // 바닥: 스윙 앞부분에서 두 발 중 낮은 쪽의 평소 높이(점프 전)
  const footYs = [];
  for (let i = swing.i0; i <= swing.i1 && frames[i].t < swing.keys.contact - 0.05 * swing.sf; i++) {
    footYs.push(Math.max(Y(frames[i], J.lHeel), Y(frames[i], J.rHeel), Y(frames[i], J.lToe), Y(frames[i], J.rToe)));
  }
  const ground = G.percentile(footYs, 0.8);
  if (Number.isFinite(ground) && Number.isFinite(k)) {
    out.contactHeight = toH(ground - Y(pc, S.hit.wr));              // 임팩트 때 손목 높이
    const lowFoot = Math.max(Y(pc, J.lHeel), Y(pc, J.rHeel), Y(pc, J.lToe), Y(pc, J.rToe));
    out.jump = toH(ground - lowFoot);                               // 임팩트 때 발이 뜬 높이
  }

  if (swing.view === 'side' && Number.isFinite(k)) {
    const dir = swing.dirX;
    const hipX = (X(pc, J.lHip) + X(pc, J.rHip)) / 2;
    const frontAnk = dir * X(pc, J.lAnk) > dir * X(pc, J.rAnk) ? J.lAnk : J.rAnk;
    out.contactFront = toH((X(pc, S.hit.wr) - hipX) * dir);         // 손목이 골반보다 얼마나 앞(치는 방향)
    out.contactFrontFoot = toH((X(pc, S.hit.wr) - X(pc, frontAnk)) * dir);   // 앞발보다 얼마나 앞
    out.headFront = toH((X(pc, J.nose) - hipX) * dir);              // 머리가 골반보다 앞(+)·뒤(-) — 뒤로 젖혔나
    const pf = at(swing.keys.finish);
    if (pf) out.weightShift = toH(((X(pf, J.lHip) + X(pf, J.rHip)) / 2 - hipX) * dir);   // 임팩트 뒤 몸이 앞으로 간 만큼
  }

  // 임팩트 앞뒤 머리 흔들림
  const p1 = at(swing.keys.contact - 0.1 * swing.sf), p2 = at(swing.keys.contact + 0.1 * swing.sf);
  if (p1 && p2 && Number.isFinite(k)) out.headMove = toH(Math.hypot(X(p2, J.nose) - X(p1, J.nose), Y(p2, J.nose) - Y(p1, J.nose)));

  // 가슴이 치는 방향을 얼마나 보고 있나(0 = 정면으로 열림, 90 = 옆으로 섬, 90 넘으면 등을 보일 만큼 돌림)
  const chest = (p) => (p ? G.angleBetween(G.bodyFrame(p, 'shoulders').F, swing.dir) : NaN);
  const hips = (p) => (p ? G.angleBetween(G.bodyFrame(p, 'hips').F, swing.dir) : NaN);
  out.chestAtContact = chest(pc);
  out.hipsAtContact = hips(pc);
  if (swing.stroke === 'serve') {
    const pt = at(swing.keys.trophy), ps = at(swing.keys.start);
    if (pt) {
      out.chestAtTrophy = chest(pt);
      out.tossArmUp = out.phases.trophy ? out.phases.trophy.offWristUp : NaN;
      if (ps) {
        const st0 = poseMetrics(ps, swing.hand).stance, st1 = out.phases.trophy.stance;
        out.stanceRatio = st0 > 0.05 ? st1 / st0 : NaN;             // 트로피 때 발 간격 ÷ 시작 때 — 작으면 핀포인트
        out.stanceType = out.stanceRatio < 0.62 ? 'pinpoint' : 'platform';
      }
      // 무릎이 가장 깊이 굽은 값(두 무릎 평균)
      out.kneeBend = (out.phases.trophy.kneeHit + out.phases.trophy.kneeOff) / 2;
      out.tTrophyToContact = (swing.keys.contact - swing.keys.trophy) / swing.sf;
    }
  } else {
    const pb = at(swing.keys.backswing), pl = at(swing.keys.load);
    if (pb) { out.chestAtBackswing = chest(pb); out.tBackToContact = (swing.keys.contact - swing.keys.backswing) / swing.sf; }
    if (pl) out.kneeBend = (out.phases.load.kneeHit + out.phases.load.kneeOff) / 2;
  }
  return out;
}

/** 키(cm)를 주면 '키의 몇 배'를 cm 로 */
export const toCm = (ratio, heightCm = 170) => ratio * heightCm;

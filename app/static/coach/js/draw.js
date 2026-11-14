// 스윙 코치 — 캔버스에 그리는 것들: 뼈대, 선수 자세 겹쳐 보기, 공유 카드.
import * as G from './geom.js';

const { J, BONES } = G;
export const COLORS = { me: '#D7F24B', meArm: '#FFFFFF', pro: '#58C7FF', warn: '#FF8A65', dim: 'rgba(255,255,255,.55)' };

/** 화면 좌표 뼈대. lm = [[x,y,…] × 33] (0~1). hand 를 주면 치는 팔을 더 굵고 밝게. */
export function skeleton(ctx, lm, W, H, { color = COLORS.me, width = 3, hand = null, alpha = 1, minVis = 0.25, mirror = false } = {}) {
  const X = (i) => (mirror ? 1 - lm[i][0] : lm[i][0]) * W, Y = (i) => lm[i][1] * H;
  const ok = (i) => lm[i] && (lm[i][3] === undefined || lm[i][3] >= minVis);
  const hit = hand ? (hand === 'L' ? [11, 13, 15] : [12, 14, 16]) : [];
  ctx.save();
  ctx.globalAlpha = alpha; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const [a, b] of BONES) {
    if (!ok(a) || !ok(b)) continue;
    const arm = hit.includes(a) && hit.includes(b);
    ctx.strokeStyle = arm ? COLORS.meArm : color; ctx.lineWidth = arm ? width * 1.5 : width;
    ctx.beginPath(); ctx.moveTo(X(a), Y(a)); ctx.lineTo(X(b), Y(b)); ctx.stroke();
  }
  if (ok(J.nose) && ok(J.lSh) && ok(J.rSh)) {                     // 머리: 코를 중심으로 어깨 너비의 0.38배 원
    const r = Math.max(4, Math.hypot(X(J.lSh) - X(J.rSh), Y(J.lSh) - Y(J.rSh)) * 0.38, Math.hypot(X(J.lEar) - X(J.rEar), Y(J.lEar) - Y(J.rEar)) * 0.6);
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.arc(X(J.nose), Y(J.nose), r, 0, 6.2832); ctx.stroke();
  }
  ctx.fillStyle = color;
  for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    if (!ok(i)) continue;
    ctx.beginPath(); ctx.arc(X(i), Y(i), hit.includes(i) ? width * 1.5 : width * 1.05, 0, 6.2832); ctx.fill();
  }
  ctx.restore();
}

/**
 * 선수 자세를 내 화면에 겹친다: 선수의 3차원 뼈대를 내 몸이 향한 방향·내 키에 맞춰 돌려 놓고, 골반을 맞춰 그린다.
 * ref = reference.json 의 표본(w: 33×[x,y,z], 오른손 기준). 내가 왼손잡이면 좌우를 뒤집는다.
 */
export function ghost(ctx, pose, ref, W, H, { hand = 'R', color = COLORS.pro, width = 3, alpha = 0.9 } = {}) {
  const k = G.pxPerMeter(pose, W, H);
  if (!Number.isFinite(k) || !ref || !ref.w) return false;
  const refPose = { t: 0, lm: ref.lm, w: ref.w };
  const fr = G.bodyFrame(refPose, 'hips'), fu = G.bodyFrame(pose, 'hips');
  const or = G.mid(ref.w[J.lHip], ref.w[J.rHip]), ou = G.mid(pose.w[J.lHip], pose.w[J.rHip]);
  const scale = G.statureW(pose) / (G.statureW(refPose) || 1);
  const flip = hand === 'L' ? -1 : 1;
  const hipPx = [(pose.lm[J.lHip][0] + pose.lm[J.rHip][0]) / 2 * W, (pose.lm[J.lHip][1] + pose.lm[J.rHip][1]) / 2 * H];
  const pts = ref.w.map((p) => {
    const b = G.inBody(fr, p, or);                                // 선수 몸 기준(오른쪽, 위, 앞)
    const wx = G.add(G.add(G.mul(fu.R, b[0] * flip * scale), G.mul(fu.U, b[1] * scale)), G.mul(fu.F, b[2] * scale));
    return [(hipPx[0] + (wx[0] + ou[0] - ou[0]) * k) / W, (hipPx[1] + wx[1] * k) / H, 0, 1];
  });
  skeleton(ctx, pts, W, H, { color, width, alpha });
  return true;
}

/** 캔버스를 화면 크기에 맞게 선명하게(기기 픽셀 비율) */
export function fit(canvas, cssW, cssH) {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
  return canvas.getContext('2d');
}

/** 점수 고리(SVG 문자열) */
export function ring(score, size = 132) {
  const r = size / 2 - 9, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="점수 ${score}점">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="9"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--ball)" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-size="${size * 0.34}" font-weight="800" fill="currentColor">${score}</text></svg>`;
}

function wrap(ctx, text, x, y, maxW, lineH, maxLines = 3) {
  const chars = [...text];
  let line = '', n = 0;
  for (let i = 0; i < chars.length; i++) {
    const test = line + chars[i];
    if (ctx.measureText(test).width > maxW && line) {
      n++;
      if (n === maxLines) { ctx.fillText(line.slice(0, -1) + '…', x, y); return y + lineH; }
      ctx.fillText(line, x, y); y += lineH; line = chars[i];
    } else line = test;
  }
  if (line) { ctx.fillText(line, x, y); y += lineH; }
  return y;
}

/** 공유 카드(1080×1350 PNG). frame = 뼈대까지 그린 캔버스. 영상 자체는 담지 않는다. */
export function shareCard({ frame, score, grade, stroke, top, cue, url }) {
  const c = document.createElement('canvas');
  c.width = 1080; c.height = 1350;
  const x = c.getContext('2d');
  x.fillStyle = '#0B1210'; x.fillRect(0, 0, 1080, 1350);
  const fw = 1080 - 96, fh = 760, ar = frame.width / frame.height;     // 사진 영역
  let dw = fw, dh = fw / ar;
  if (dh > fh) { dh = fh; dw = fh * ar; }
  x.save();
  x.beginPath(); x.roundRect(48, 48, fw, fh, 36); x.clip();
  x.fillStyle = '#060A09'; x.fillRect(48, 48, fw, fh);
  x.drawImage(frame, 48 + (fw - dw) / 2, 48 + (fh - dh) / 2, dw, dh);
  x.restore();
  const font = (w, s) => `${w} ${s}px "Pretendard Variable", Pretendard, -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
  x.fillStyle = '#D7F24B'; x.font = font(800, 150); x.textBaseline = 'top';
  x.fillText(String(score), 48, 842);
  const sw = x.measureText(String(score)).width;
  x.fillStyle = '#FFFFFF'; x.font = font(700, 44); x.fillText(`${stroke} · ${grade}`, 48 + sw + 28, 872);
  x.fillStyle = 'rgba(255,255,255,.6)'; x.font = font(500, 34); x.fillText('스윙 코치 자세 점수', 48 + sw + 28, 934);
  x.fillStyle = '#FFFFFF'; x.font = font(700, 46);
  let y = wrap(x, top || '자세가 안정적이에요', 48, 1034, 984, 60, 2);
  x.fillStyle = 'rgba(255,255,255,.78)'; x.font = font(500, 36);
  if (cue) wrap(x, cue, 48, y + 10, 984, 50, 2);
  x.fillStyle = 'rgba(255,255,255,.5)'; x.font = font(500, 30); x.textBaseline = 'bottom';
  x.fillText(url || '', 48, 1302);
  x.fillStyle = '#D7F24B'; x.textAlign = 'right'; x.font = font(800, 32); x.fillText('스윙 코치', 1032, 1302);
  return c;
}

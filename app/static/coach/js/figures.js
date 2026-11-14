// 스윙 코치 — 조언에 붙이는 간단한 그림. "지금"(주황)과 "이렇게"(노랑)를 막대 인형 두 개로 나란히 보여 준다.
// 잰 각도·거리를 그림에 그대로 넣는다(예: 팔꿈치 152° → ㄴ자). SVG 문자열만 만든다(DOM 을 쓰지 않는다 — 브라우저·Node 공용).
//
// 그림 종류: 옆에서 본 모습(대부분), 위에서 본 모습(어깨 턴·몸통 회전), 앞에서 본 모습(서브의 팔–몸통 각).
// 각도 규약(옆모습): 0 = 아래, 90 = 앞(오른쪽 = 네트 쪽), 180 = 위, 음수 = 뒤.

const NOW = '#FF8A65', GOAL = '#D7F24B', BODY = 'rgba(255,255,255,.6)', DIM = 'rgba(255,255,255,.34)', TXT = 'rgba(255,255,255,.72)';
const rad = (d) => (d * Math.PI) / 180;
const dirv = (a) => [Math.sin(rad(a)), Math.cos(rad(a))];
const add = (p, v, k = 1) => [p[0] + v[0] * k, p[1] + v[1] * k];
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const f = (n) => (Math.round(n * 10) / 10).toFixed(1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const line = (a, b, c, w = 3.4, extra = '') => `<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}" stroke="${c}" stroke-width="${w}" stroke-linecap="round" ${extra}/>`;
const dash = (a, b, c = DIM) => line(a, b, c, 1.4, 'stroke-dasharray="3 4"');
const dot = (p, r, c) => `<circle cx="${f(p[0])}" cy="${f(p[1])}" r="${r}" fill="${c}"/>`;
const text = (x, y, s, c = TXT, size = 11, weight = 600, anchor = 'middle') => `<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${c}">${esc(s)}</text>`;

/** 두 방향 사이의 호(각도 표시). c = 중심, a0→a1 = 내 각도 규약의 방향 */
function arc(c, r, a0, a1, color) {
  const p0 = add(c, dirv(a0), r), p1 = add(c, dirv(a1), r);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0, sweep = a1 > a0 ? 0 : 1;
  return `<path d="M${f(p0[0])} ${f(p0[1])} A${r} ${r} 0 ${large} ${sweep} ${f(p1[0])} ${f(p1[1])}" fill="none" stroke="${color}" stroke-width="1.6"/>`;
}
/** 화살표(선 + 촉) */
function arrow(a, b, c, w = 1.8) {
  const d = Math.atan2(b[1] - a[1], b[0] - a[0]), h = 5;
  const l = [b[0] - h * Math.cos(d - 0.5), b[1] - h * Math.sin(d - 0.5)], r = [b[0] - h * Math.cos(d + 0.5), b[1] - h * Math.sin(d + 0.5)];
  return line(a, b, c, w) + `<path d="M${f(l[0])} ${f(l[1])} L${f(b[0])} ${f(b[1])} L${f(r[0])} ${f(r[1])}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

const GROUND = 126;

/**
 * 옆에서 본 막대 인형. o = { lean(앞으로 숙임 +), knee(무릎 굽힘), arm:{sh, el, bend, racket}, off:{sh, el, bend}, lift(발이 뜬 높이), headDx }
 * hi = 강조할 부위 ['arm','off','legs','trunk','head'], color = 강조 색. 돌려주는 것: { svg, pts }
 */
function sideFigure(o, cx, hi, color) {
  const L = 27, k = o.knee ?? 10, lean = o.lean ?? 0, lift = o.lift || 0;
  const g = GROUND - lift;
  const hip = [cx, g - 2 * L * Math.cos(rad(k / 2))];
  const leg = (ax) => {
    const ank = [cx + ax, g];
    const vx = ank[0] - hip[0], vy = ank[1] - hip[1];
    const d = Math.min(2 * L - 0.01, Math.hypot(vx, vy));
    const kd = Math.atan2(vx, vy) + Math.acos(d / (2 * L));          // 무릎은 앞(네트 쪽)으로 나온다
    return [hip, [hip[0] + L * Math.sin(kd), hip[1] + L * Math.cos(kd)], ank];
  };
  const up = dirv(180 - lean);
  const sh = add(hip, up, 32), head = add(add(sh, up, 11), [o.headDx || 0, 0]);
  const limb = (a) => {
    const el = add(sh, dirv(a.sh), 16);
    const d2 = a.sh + (a.bend ?? 1) * (180 - a.el);
    const wr = add(el, dirv(d2), 15);
    return { el, wr, d2, tip: add(wr, dirv(d2 + (a.rk || 0)), 17) };
  };
  const A = limb(o.arm), B = o.off ? limb(o.off) : null;
  const col = (part) => (hi.includes(part) ? color : BODY);
  const w = (part) => (hi.includes(part) ? 4.2 : 3.2);
  let s = '';
  const back = leg(-7), front = leg(8);
  s += line(back[0], back[1], col('legs'), w('legs')) + line(back[1], back[2], col('legs'), w('legs'));
  s += line(front[0], front[1], col('legs'), w('legs')) + line(front[1], front[2], col('legs'), w('legs'));
  if (B) s += line(sh, B.el, col('off'), w('off')) + line(B.el, B.wr, col('off'), w('off'));
  s += line(hip, sh, col('trunk'), w('trunk'));
  s += `<circle cx="${f(head[0])}" cy="${f(head[1])}" r="6.5" fill="none" stroke="${col('head')}" stroke-width="${w('head')}"/>`;
  s += line(sh, A.el, col('arm'), w('arm')) + line(A.el, A.wr, col('arm'), w('arm'));
  if (o.arm.racket !== false) s += line(A.wr, A.tip, col('arm'), 1.6) + `<ellipse cx="${f(A.tip[0])}" cy="${f(A.tip[1])}" rx="3.2" ry="5.2" transform="rotate(${f(-A.d2 - (o.arm.rk || 0))} ${f(A.tip[0])} ${f(A.tip[1])})" fill="none" stroke="${col('arm')}" stroke-width="1.6"/>`;
  return { svg: s, pts: { hip, sh, head, el: A.el, wr: A.wr, tip: A.tip, d2: A.d2, off: B, front: front[2], back: back[2], knee: front[1] } };
}

/** 위에서 본 모습: 네트는 위쪽. a = 가슴이 네트에서 돌아간 각(0 = 네트를 정면으로, 90 = 옆으로). side = 도는 방향(+1 오른쪽) */
function topFigure(cx, a, side, color) {
  const c = [cx, 82];
  const ch = [Math.sin(rad(a)) * side, -Math.cos(rad(a))];                 // 가슴이 향한 쪽
  const sv = [-ch[1], ch[0]];                                              // 어깨선(가슴 방향에 수직)
  let s = line([cx - 34, 30], [cx + 34, 30], DIM, 2) + text(cx, 23, '네트', DIM, 9, 600);
  s += dash(c, [cx, 36]);
  s += line(add(c, sv, -23), add(c, sv, 23), color, 5);
  s += `<circle cx="${f(c[0])}" cy="${f(c[1])}" r="8.5" fill="#0C1412" stroke="${color}" stroke-width="3"/>`;
  s += arrow(add(c, ch, 10), add(c, ch, 33), color, 2);
  if (a > 6) {
    const r = 21, p0 = [cx, c[1] - r], p1 = add(c, ch, r);
    s += `<path d="M${f(p0[0])} ${f(p0[1])} A${r} ${r} 0 ${a > 180 ? 1 : 0} ${side > 0 ? 1 : 0} ${f(p1[0])} ${f(p1[1])}" fill="none" stroke="${DIM}" stroke-width="1.4"/>`;
  }
  return s;
}

/** 앞에서 본 모습(서브 임팩트): 어깨선 기울기 tilt 와 팔–몸통 각 arm */
function frontFigure(cx, arm, tilt, color) {
  const pel = [cx, 100], chest = [cx, 66];
  const sv = [Math.cos(rad(tilt)), -Math.sin(rad(tilt))];                   // 치는 쪽 어깨 방향(올라감)
  const hs = add(chest, sv, 15), os = add(chest, sv, -15);
  const down = [Math.sin(rad(tilt)), Math.cos(rad(tilt))];                  // 몸통 옆선(어깨에서 아래로)
  const ang = Math.atan2(down[0], down[1]) + rad(arm);                      // 몸통 옆선에서 바깥쪽으로 arm 만큼 든 팔
  const hand = [hs[0] + 30 * Math.sin(ang), hs[1] + 30 * Math.cos(ang)];
  let s = line(pel, [cx - 8, GROUND], BODY, 3.2) + line(pel, [cx + 8, GROUND], BODY, 3.2) + line(pel, chest, BODY, 3.2);
  s += line(os, hs, BODY, 3.2) + line(os, add(os, [-4, 22]), BODY, 3.2);
  s += `<circle cx="${f(chest[0])}" cy="${f(chest[1] - 13)}" r="6.5" fill="none" stroke="${BODY}" stroke-width="3.2"/>`;
  s += line(hs, hand, color, 4.2) + line(hand, add(hand, [Math.sin(ang), Math.cos(ang)], 16), color, 1.6);
  s += dash(hs, add(hs, down, 24));
  const r = 11, a0 = Math.atan2(down[0], down[1]), p0 = [hs[0] + r * Math.sin(a0), hs[1] + r * Math.cos(a0)], p1 = [hs[0] + r * Math.sin(ang), hs[1] + r * Math.cos(ang)];
  s += `<path d="M${f(p0[0])} ${f(p0[1])} A${r} ${r} 0 ${arm > 180 ? 1 : 0} 0 ${f(p1[0])} ${f(p1[1])}" fill="none" stroke="${color}" stroke-width="1.6"/>`;
  return s;
}

const LX = 78, RX = 222;
/** 두 칸짜리 그림 틀: 왼쪽 '지금', 오른쪽 '이렇게' */
function frame(left, right, nowText, goalText, label, extra = '') {
  return `<svg viewBox="0 0 300 174" role="img" aria-label="${esc(label)}">
    <line x1="150" y1="14" x2="150" y2="132" stroke="${DIM}" stroke-width="1" stroke-dasharray="2 5"/>
    ${line([LX - 46, GROUND + 1.5], [LX + 46, GROUND + 1.5], DIM, 1.4)}${line([RX - 46, GROUND + 1.5], [RX + 46, GROUND + 1.5], DIM, 1.4)}
    ${left}${right}${extra}
    ${text(LX, 149, '지금', NOW, 13, 800)}${text(RX, 149, '이렇게', GOAL, 13, 800)}
    ${text(LX, 166, nowText, TXT, 11.5, 500)}${text(RX, 166, goalText, TXT, 11.5, 500)}</svg>`;
}

// 기본 자세
const TROPHY = { lean: -8, knee: 36, arm: { sh: -100, el: 95, bend: -1 }, off: { sh: 172, el: 176 } };
const SERVE_HIT = { lean: 8, knee: 6, lift: 5, arm: { sh: 168, el: 176 }, off: { sh: 35, el: 70 } };
const GROUND_HIT = { lean: 6, knee: 30, arm: { sh: 62, el: 150 }, off: { sh: -35, el: 150 } };
const merge = (base, o) => ({ ...base, ...o, arm: { ...base.arm, ...(o.arm || {}) }, off: { ...base.off, ...(o.off || {}) } });

/** 옆모습 두 칸. deco(pts 지금, pts 이렇게) 로 보조선·화살표를 더한다 */
function side2(base, now, goal, hi, nowText, goalText, label, deco) {
  const a = sideFigure(merge(base, now), LX, hi, NOW), b = sideFigure(merge(base, goal), RX, hi, GOAL);
  return frame(a.svg, b.svg, nowText, goalText, label, deco ? deco(a.pts, b.pts) : '');
}
/** 팔꿈치 각을 호로 표시: 위팔 방향(팔꿈치→어깨)과 아래팔 방향 사이 */
function elbowDeco() {
  const one = (p, color) => {
    const toSh = (Math.atan2(p.sh[0] - p.el[0], p.sh[1] - p.el[1]) * 180) / Math.PI;
    let d = p.d2;
    while (d - toSh > 180) d -= 360;
    while (d - toSh < -180) d += 360;
    return arc(p.el, 8, toSh, d, color);
  };
  return (pa, pb) => one(pa, NOW) + one(pb, GOAL);
}
const netHint = (x) => arrow([x + 18, GROUND + 9], [x + 44, GROUND + 9], DIM, 1.2) + text(x + 14, GROUND + 12.5, '네트', DIM, 8.5, 600, 'end');
const cmOf = (it) => { const m = /약 (\d+)cm/.exec(it.title || ''); return m ? Number(m[1]) : null; };
const deg = (v) => `${Math.round(v)}°`;

/**
 * 조언 한 개에 맞는 그림(SVG 문자열). 맞는 그림이 없으면 ''.
 * it = advise() 의 항목({ id, side, value, you, title }), m = swingMetrics 결과, opt = { hand }
 */
export function adviceFigure(it, m = {}, opt = {}) {
  if (!it || !it.id) return '';
  const v = Number(it.value), low = it.side === 'low';
  const key = it.id.replace(/^(fh|bh2|bh1)_/, 'g_');
  const stroke = it.id.startsWith('bh') ? 'backhand' : it.id.startsWith('fh') ? 'forehand' : 'serve';
  const turnSide = (stroke === 'backhand' ? -1 : 1) * (opt.hand === 'L' ? -1 : 1);
  const top2 = (aNow, aGoal, nowText, goalText, label) => frame(topFigure(LX, aNow, turnSide, NOW), topFigure(RX, aGoal, turnSide, GOAL), nowText, goalText, label);
  switch (key) {
    // ── 서브 ──
    case 'serve_knee':
      return side2(TROPHY, { knee: clamp(v, 0, 60) }, { knee: 58 }, ['legs'], `무릎 ${deg(v)}`, '의자에 반쯤 앉듯', '무릎 굽힘: 지금은 거의 서 있고, 목표는 반쯤 앉은 자세');
    case 'serve_toss_arm':
      return side2(TROPHY, { off: { sh: 70, el: 150 } }, {}, ['off'], '토스한 팔이 내려옴', '공을 가리킨 채 유지', '토스한 팔: 지금은 일찍 내려오고, 목표는 위로 뻗은 채 유지');
    case 'serve_trophy_elbow': {
      const e = clamp(v, 35, 176);
      return side2(TROPHY, { arm: { el: e } }, { arm: { el: 95 } }, ['arm'], `팔꿈치 ${deg(v)}`, 'ㄴ자 (약 90°)', `트로피 팔꿈치: 지금 ${deg(v)}, 목표는 ㄴ자`, elbowDeco());
    }
    case 'serve_turn':
      return top2(clamp(v, 0, 60), 100, `가슴이 ${deg(v)} 돌아감`, '옆으로 서서 등이 살짝', '몸 돌림: 지금은 네트를 정면으로 보고, 목표는 옆으로 선 자세');
    case 'serve_contact_height': {
      const cm = cmOf(it);
      return side2(SERVE_HIT, { knee: 22, lift: 0, lean: 16, arm: { sh: 150, el: 128 } }, {}, ['arm'], it.you || '타점이 낮음', cm ? `약 ${cm}cm 더 높이` : '가장 높은 곳에서',
        '타점 높이: 지금은 팔이 굽고 낮은 곳에서, 목표는 팔을 다 펴고 가장 높은 곳에서', (a, b) => dash([LX - 40, b.wr[1]], [RX + 40, b.wr[1]], GOAL) + arrow([a.wr[0] + 12, a.wr[1]], [a.wr[0] + 12, b.wr[1] + 3], NOW, 1.6));
    }
    case 'serve_contact_elbow':
      return side2(SERVE_HIT, { arm: { el: clamp(v, 95, 172) } }, {}, ['arm'], `팔꿈치 ${deg(v)}`, '다 편 채로', `임팩트 팔꿈치: 지금 ${deg(v)}로 굽어 있고, 목표는 다 편 자세`, elbowDeco());
    case 'serve_arm_trunk':
      return low
        ? frame(frontFigure(LX, clamp(v, 40, 100), 0, NOW), frontFigure(RX, 112, 26, GOAL), `팔–몸통 ${deg(v)}`, '어깨를 기울여 약 110°', '팔과 몸통 사이 각: 지금은 팔꿈치가 처져 있고, 목표는 어깨선을 기울여 110도쯤')
        : frame(frontFigure(LX, clamp(v, 150, 178), 0, NOW), frontFigure(RX, 115, 30, GOAL), `팔–몸통 ${deg(v)} (귀 옆)`, '어깨를 기울여 약 110°', '팔과 몸통 사이 각: 지금은 팔을 귀 옆에 붙여 수직으로, 목표는 어깨선을 기울여 110도쯤');
    case 'serve_contact_front': {
      const cm = cmOf(it);
      if (!low) return side2(SERVE_HIT, { lean: 30, lift: 0, arm: { sh: 138 } }, {}, ['trunk', 'arm'], '몸이 앞으로 쏟아짐', '가슴을 세우고 위로', '토스가 너무 앞: 지금은 몸이 앞으로 쏟아지고, 목표는 가슴을 세워 위로', (a) => netHint(a.front[0] - 10));
      return side2(SERVE_HIT, { lean: -6, lift: 0, arm: { sh: 186 } }, { arm: { sh: 160 } }, ['arm'], it.you || '머리 위·뒤에서', cm ? `약 ${cm}cm 더 앞에서` : '앞발보다 앞에서',
        '타점 앞뒤: 지금은 머리 위나 뒤에서, 목표는 앞발보다 앞에서', (a, b) => dash([a.front[0], GROUND], [a.front[0], 20]) + dash([b.front[0], GROUND], [b.front[0], 20]) + dot(a.wr, 3, NOW) + dot(b.wr, 3, GOAL) + netHint(LX - 10) + netHint(RX - 10));
    }
    case 'serve_head':
      return side2(SERVE_HIT, { lean: 26, lift: 0, headDx: 5 }, {}, ['head', 'trunk'], '머리가 먼저 떨어짐', '턱을 든 채 끝까지', '머리 고정: 지금은 머리가 먼저 떨어지고, 목표는 턱을 든 채 유지');
    // ── 포핸드·백핸드 ──
    case 'g_contact_front':
    case 'g_contact_front3d': {
      const cm = cmOf(it);
      const hipLine = (a, b) => dash([a.hip[0], GROUND], [a.hip[0], 34]) + dash([b.hip[0], GROUND], [b.hip[0], 34]) + dot(a.wr, 3, NOW) + dot(b.wr, 3, GOAL)
        + arrow([b.hip[0] + 3, b.wr[1] + 16], [b.wr[0] - 1, b.wr[1] + 16], GOAL, 1.4) + netHint(LX - 10) + netHint(RX - 10);
      if (!low) return side2(GROUND_HIT, { lean: 22, arm: { sh: 88, el: 178 } }, {}, ['arm', 'trunk'], it.you || '팔만 뻗어 침', '한 걸음 다가가서', '타점이 너무 앞: 지금은 팔만 뻗고, 목표는 발로 다가가서', hipLine);
      return side2(GROUND_HIT, { arm: { sh: 8, el: 105 } }, {}, ['arm'], it.you || '몸 옆·뒤에서 맞음', cm ? `약 ${cm}cm 더 앞에서` : '몸 앞에서',
        '타점 앞뒤: 지금은 몸 옆이나 뒤에서 맞고, 목표는 골반보다 앞에서', hipLine);
    }
    case 'g_knee': {
      const lowBall = m && m.wristHeightGround < 0.42;
      const ball = (p, c) => dot([p.tip[0] + 4, p.tip[1]], 2.6, c);
      return side2(GROUND_HIT, { knee: clamp(v, 0, 30), lean: lowBall ? 30 : 4, arm: lowBall ? { sh: 30, el: 165 } : {} }, { knee: 62, lean: 10, arm: lowBall ? { sh: 48, el: 160 } : {} }, ['legs'],
        `무릎 ${deg(v)}`, lowBall ? '무릎으로 낮추기' : '앉았다 일어나며', lowBall ? '낮은 공: 지금은 허리만 숙이고, 목표는 무릎을 굽혀 엉덩이를 낮게' : '무릎 굽힘: 지금은 서서 치고, 목표는 무릎을 굽힌 자세',
        (a, b) => ball(a, '#fff') + ball(b, '#fff'));
    }
    case 'g_high_ball':
      return side2(GROUND_HIT, { arm: { sh: 112, el: 150 } }, {}, ['arm'], it.you || '어깨 위에서 맞음', '허리~가슴 높이에서', '타점 높이: 지금은 어깨 위에서, 목표는 허리에서 가슴 높이',
        (a, b) => dash([LX - 40, a.sh[1]], [LX + 44, a.sh[1]]) + dash([RX - 40, b.sh[1]], [RX + 44, b.sh[1]]) + text(LX - 42, a.sh[1] - 3, '어깨', DIM, 8.5, 600, 'start') + text(RX - 42, b.sh[1] - 3, '어깨', DIM, 8.5, 600, 'start') + dot(a.tip, 2.6, '#fff') + dot(b.tip, 2.6, '#fff'));
    case 'g_turn': {
      const goal = it.id.startsWith('bh1') ? 110 : it.id.startsWith('bh2') ? 88 : 100;
      return top2(clamp(v, 0, 86), goal, `어깨 턴 ${deg(v)}`, `${goal}° 이상 (옆으로)`, `어깨 턴: 지금 ${deg(v)}, 목표는 옆으로 설 만큼`);
    }
    case 'g_rotation':
      return top2(clamp(v, 55, 125), 30, `가슴이 ${deg(v)} (옆을 봄)`, '배꼽이 네트를 보게', '몸통 회전: 지금은 맞는 순간에도 옆을 보고, 목표는 네트 쪽으로 돌아 나온 자세');
    case 'g_open':
      return top2(clamp(v, 0, 44), 78, `가슴이 ${deg(v)} (열림)`, '옆으로 선 채 맞히기', '어깨 열림: 지금은 일찍 열리고, 목표는 옆으로 선 채 맞히기');
    case 'g_lean_back':
      return side2(GROUND_HIT, { lean: -17 }, { lean: 9 }, ['trunk', 'head'], '뒤로 젖혀짐', '가슴을 공 쪽으로', '상체 기울기: 지금은 뒤로 젖혀지고, 목표는 가슴을 공 쪽으로', (a) => netHint(a.front[0] - 4));
    case 'g_head':
      return side2(GROUND_HIT, { headDx: 6, lean: 12 }, {}, ['head'], '머리가 먼저 돌아감', '타점을 반 박자 더 보기', '머리 고정: 지금은 머리가 먼저 돌아가고, 목표는 타점을 끝까지 보기',
        (a, b) => dash(b.head, b.tip, GOAL) + dot(a.tip, 2.6, '#fff') + dot(b.tip, 2.6, '#fff'));
    case 'g_jammed':
      if (it.id.startsWith('bh2')) {
        return side2(GROUND_HIT, { arm: { sh: 22, el: 80 }, off: { sh: 18, el: 78 } }, { arm: { sh: 60, el: 162 }, off: { sh: 56, el: 158 } }, ['arm', 'off'], '두 팔이 몸에 붙음', '앞으로 쭉 밀기', '팔 뻗기: 지금은 두 팔이 몸에 붙고, 목표는 앞으로 뻗은 자세');
      }
      return side2(GROUND_HIT, { arm: { sh: 20, el: clamp(v, 50, 100) } }, { arm: { sh: 62, el: 140 } }, ['arm'], `팔꿈치 ${deg(v)} (끼임)`, '공과 한 팔 거리', `공과의 거리: 지금은 팔꿈치가 ${deg(v)}로 몸에 끼고, 목표는 한 팔 거리`, elbowDeco());
    case 'g_finish':
      return side2(GROUND_HIT, { arm: { sh: 84, el: 165 } }, { arm: { sh: 148, el: 62 } }, ['arm'], '앞에서 멈춤', '몸 반대쪽으로 넘기기', '팔로스루: 지금은 앞에서 멈추고, 목표는 몸 반대쪽으로 넘어가기',
        (a, b) => arrow([b.el[0] + 14, b.el[1] + 12], [b.wr[0] + 6, b.wr[1] - 2], GOAL, 1.4));
    case 'g_elbow':
      return side2(GROUND_HIT, { arm: { sh: 48, el: clamp(v, 95, 146) } }, { arm: { sh: 60, el: 176 } }, ['arm'], `팔꿈치 ${deg(v)}`, '팔을 편 채로', `임팩트 팔꿈치: 지금 ${deg(v)}로 굽어 있고, 목표는 편 자세`, elbowDeco());
    default:
      return '';
  }
}

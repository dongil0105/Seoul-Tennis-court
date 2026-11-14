// 스윙 코치 — '내 키로 보는 타점 높이' 화면과, 서브 결과에 붙는 '내 타점 높이' 카드.
// 각도(몇 도)는 쓰지 않는다. 키 → 리치 → 서브 종류별 타점 높이·위치(cm), 네트 위로 지나가야 하는 틈(cm·공 개수),
// 스트로크는 몸 높이(무릎·허리·가슴·어깨)와 네트 높이의 몇 배로 말한다. 계산은 reach.js(순수 모듈).
import * as R from './reach.js';
import { $, esc, seg, bindSegs } from './ui.js';

const SERVE_SPEEDS = [[100, '천천히'], [130, '보통'], [160, '빠르게']];
const GROUND_SPEEDS = [[70, '동호인 보통'], [90, '빠른 편'], [110, '선수급']];
const levelSpeed = (level) => (level === 'adv' ? 160 : level === 'beg' ? 100 : 130);
const range = (a) => (a[0] === a[1] ? `${a[0]}` : `${a[0]}~${a[1]}`);

/** 키와 리치를 한눈에: 팔과 라켓을 위로 뻗은 사람 그림에 높이 두 줄 */
function reachFigure(heightCm, mark) {
  const { reach } = R.reachOf(heightCm);
  const top = Math.max(reach, mark ? mark.cm : 0) + 14, k = 150 / top;      // cm → 화면 높이
  const Y = (cm) => 168 - cm * k, cx = 92;
  const H = heightCm, sh = 0.818 * H, hip = 0.53 * H, wr = 1.15 * H;
  const ln = (x1, y1, x2, y2, c = 'rgba(255,255,255,.62)', w = 3.2) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`;
  const rule = (cm, color) => `<line x1="24" y1="${Y(cm).toFixed(1)}" x2="296" y2="${Y(cm).toFixed(1)}" stroke="${color}" stroke-width="1.3" stroke-dasharray="4 5"/>`;
  const guide = (cm, color, label) => `${rule(cm, color)}<text x="296" y="${(Y(cm) - 5).toFixed(1)}" text-anchor="end" font-size="12" font-weight="700" fill="${color}">${esc(label)}</text>`;
  const near = mark && Math.abs(Y(mark.cm) - Y(reach)) < 17;      // 두 줄이 붙어 있으면 글자를 한 줄로 합친다(겹치지 않게)
  return `<svg class="reachfig" viewBox="0 0 320 178" role="img" aria-label="키 ${heightCm}cm 이면 리치는 약 ${reach}cm${mark ? `, 이번 타점은 약 ${mark.cm}cm` : ''}">
    ${ln(24, 168, 296, 168, 'rgba(255,255,255,.3)', 1.5)}
    ${near ? `${rule(reach, '#D7F24B')}${rule(mark.cm, '#FF8A65')}<text x="296" y="${(Math.min(Y(reach), Y(mark.cm)) - 5).toFixed(1)}" text-anchor="end" font-size="12" font-weight="700"><tspan fill="#D7F24B">리치 약 ${reach}cm</tspan><tspan fill="#FF8A65"> · ${esc(mark.label)} ${mark.cm}cm</tspan></text>`
      : `${guide(reach, '#D7F24B', `리치 약 ${reach}cm`)}${mark ? guide(mark.cm, '#FF8A65', `${mark.label} ${mark.cm}cm`) : ''}`}
    ${guide(H, 'rgba(255,255,255,.55)', `키 ${H}cm`)}
    ${ln(cx - 7, 168, cx, Y(hip))}${ln(cx + 7, 168, cx, Y(hip))}${ln(cx, Y(hip), cx, Y(sh))}
    <circle cx="${cx}" cy="${(Y(H) + 7.5 * 1).toFixed(1)}" r="7" fill="none" stroke="rgba(255,255,255,.62)" stroke-width="3"/>
    ${ln(cx, Y(sh), cx - 16, Y(sh - 0.2 * H))}
    ${ln(cx, Y(sh), cx + 9, Y(wr), '#D7F24B', 3.6)}
    ${ln(cx + 9, Y(wr), cx + 11, Y(reach - 12), '#D7F24B', 1.8)}
    <ellipse cx="${cx + 11.5}" cy="${Y(reach).toFixed(1)}" rx="5.5" ry="${(15 * k).toFixed(1)}" fill="none" stroke="#D7F24B" stroke-width="1.8"/>
  </svg>`;
}

/** 서브 종류별 타점 카드(높이·앞뒤·좌우) */
function serveRows(heightCm, hand, sel) {
  return R.serveTargets(heightCm, hand).map((t) => `<div class="pattern${t.type === sel ? ' sel' : ''}"><b>${t.label} <span class="num hl">${range(t.height)}cm</span></b>
    <span>${esc(t.heightSay)} · 앞발보다 <span class="num">${range(t.front)}cm</span> 앞</span><span>${esc(t.where)}</span></div>`).join('');
}

/** 네트 위로 지나가야 하는 틈: 종류별 막대 */
function gapRows(contactCm, speed, hand) {
  const rows = R.serveTargets(170, hand).map((t) => ({ t, g: R.serveGap({ contactCm, speedKmh: speed, type: t.type, hand }) }));
  const mx = Math.max(40, ...rows.map((r) => r.g.gapCm || 0));
  return `<div class="bars gap">${rows.map(({ t, g }) => `<div><span>${t.label}</span><i><b style="width:${Math.round(((g.gapCm || 0) / mx) * 100)}%"></b></i>
    <em>${g.ok ? `${g.gapCm}cm · 공 ${Math.round(g.balls)}개` : '어려움'}</em></div>`).join('')}</div>`;
}
function gapSentence(contactCm, speed, type, hand) {
  const g = R.serveGap({ contactCm, speedKmh: speed, type, hand }), up = R.serveGap({ contactCm: contactCm + 10, speedKmh: speed, type, hand });
  if (!g.ok) return '이 높이·속도의 플랫 서브는 넣기 어렵습니다. 속도를 줄이거나 회전을 걸어야 합니다.';
  let s = `네트 바로 위부터 ${g.highCm}cm 위까지, 공 ${Math.round(g.balls)}개가 들어갈 틈으로 지나가야 서비스 박스에 떨어집니다(${g.say}).`;
  if (up.ok && up.gapCm > g.gapCm) s += ` 타점을 10cm 높이면 틈이 ${up.gapCm - g.gapCm}cm 넓어집니다.`;
  return s;
}

/**
 * 서브 결과에 붙는 카드. o = { heightCm, wristRatio(영상에서 잰 손목 높이 ÷ 키, 없으면 null), type, hand, level }
 */
export function serveHeightCard(root, o) {
  const H = o.heightCm, { reach } = R.reachOf(H), speed = levelSpeed(o.level);
  const c = Number.isFinite(o.wristRatio) ? R.serveContact(o.wristRatio, H) : null;
  const measured = c && c.ball >= 0.85 * reach && c.ball <= reach + 45;       // 터무니없는 값은 '잰 값'이라고 하지 않는다
  const type = o.type || 'flat', target = R.serveTargets(H, o.hand).find((t) => t.type === type);
  let say = '';
  if (measured) {
    const d = c.ball - target.height[0];
    say = d < -5 ? `${target.label} 서브라면 <b>${-d}cm 더 높은 곳</b>에서 맞히는 것이 좋아요(권장 ${range(target.height)}cm).`
      : c.ball > target.height[1] + 5 ? `${target.label} 서브 권장 높이(${range(target.height)}cm)보다 높게 잡혔어요. ${Number.isFinite(o.jump) && o.jump * H >= 5 ? '뛰어올라 높은 곳에서 맞혔습니다.' : '뛰어올라 맞혔거나, 어림값이 실제보다 높게 나왔을 수 있어요.'}`
        : `${target.label} 서브에 맞는 높이입니다(권장 ${range(target.height)}cm).`;
  }
  root.innerHTML = `<div class="phys">
    <div class="small muted">키 ${H}cm → 리치 약 ${reach}cm</div>
    ${measured ? `<div class="big"><b class="num">${c.ball}</b><span>cm</span></div><div class="small">손목 높이로 어림한 이번 타점 · <b>${esc(c.text)}</b></div>` : `<div class="big"><b class="num">${reach}</b><span>cm</span></div><div class="small">발을 붙이고 칠 수 있는 가장 높은 타점(리치)</div>`}
    ${reachFigure(H, measured ? { cm: c.ball, label: '이번 타점' } : null)}
    ${say ? `<p class="small" style="margin-top:10px">${say}</p>` : ''}
    <h3 style="margin-top:20px">종류별로 맞히는 높이와 자리</h3>
    ${serveRows(H, o.hand, type)}
    <h3 style="margin-top:20px">네트 위로 지나가야 하는 틈 <span class="muted" style="font-weight:500">· ${speed}km/h</span></h3>
    ${gapRows(measured ? c.ball : reach, speed, o.hand)}
    <p class="small muted" style="margin-top:10px">${esc(gapSentence(measured ? c.ball : reach, speed, type, o.hand))}</p>
    <p class="small muted" style="margin-top:8px">${measured ? '타점 높이는 영상에서 잰 손목 높이에 라켓 길이(약 48cm)를 더한 어림값입니다. 라켓 각도와 자세 인식 오차로 10cm 넘게 다를 수 있어요.' : '영상에서 타점 높이를 재지 못해 리치 높이로 계산했습니다.'} 틈은 ${speed}km/h 로 쳤다고 보고 계산한 예시입니다.</p>
  </div>`;
}

/** 몸 높이 눈금 그림: 무릎·허리·가슴·어깨 줄과 좋은 타점 띠(허리~가슴), 이번 타점 표시 */
function bodyFigure(heightCm, markCm) {
  const b = R.bodyHeights(heightCm), g = R.groundTargets(heightCm);
  const k = 150 / (heightCm + 8), Y = (cm) => 166 - cm * k, cx = 70;
  const H = heightCm, sh = 0.818 * H, hip = 0.53 * H;
  const ln = (x1, y1, x2, y2, c = 'rgba(255,255,255,.62)', w = 3.2) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`;
  const tick = (cm, label) => `<line x1="110" y1="${Y(cm).toFixed(1)}" x2="296" y2="${Y(cm).toFixed(1)}" stroke="rgba(255,255,255,.22)" stroke-width="1" stroke-dasharray="3 5"/>
    <text x="296" y="${(Y(cm) - 4).toFixed(1)}" text-anchor="end" font-size="11" font-weight="600" fill="rgba(255,255,255,.6)">${label} ${cm}cm</text>`;
  const zoneTop = Y(g.height[1]), zoneH = Y(g.height[0]) - Y(g.height[1]);
  const mark = Number.isFinite(markCm) ? `<line x1="${cx + 8}" y1="${Y(markCm).toFixed(1)}" x2="200" y2="${Y(markCm).toFixed(1)}" stroke="#FF8A65" stroke-width="2"/>
    <circle cx="${cx + 30}" cy="${Y(markCm).toFixed(1)}" r="5" fill="#FF8A65"/><text x="118" y="${(Y(markCm) + 15).toFixed(1)}" font-size="12" font-weight="800" fill="#FF8A65">이번 타점 ${Math.round(markCm)}cm</text>` : '';
  return `<svg class="reachfig" viewBox="0 0 320 176" role="img" aria-label="좋은 타점 높이는 허리에서 가슴 사이, 바닥에서 ${g.height[0]}~${g.height[1]}cm${Number.isFinite(markCm) ? `. 이번 타점은 약 ${Math.round(markCm)}cm` : ''}">
    <rect x="110" y="${zoneTop.toFixed(1)}" width="186" height="${zoneH.toFixed(1)}" fill="rgba(215,242,75,.14)"/>
    ${ln(24, 166, 296, 166, 'rgba(255,255,255,.3)', 1.5)}
    ${tick(b.knee, '무릎')}${tick(b.waist, '허리')}${tick(b.chest, '가슴')}${tick(b.shoulder, '어깨')}
    ${ln(cx - 7, 166, cx, Y(hip))}${ln(cx + 7, 166, cx, Y(hip))}${ln(cx, Y(hip), cx, Y(sh))}
    <circle cx="${cx}" cy="${(Y(H) + 7).toFixed(1)}" r="7" fill="none" stroke="rgba(255,255,255,.62)" stroke-width="3"/>
    ${ln(cx, Y(sh), cx + 16, Y(0.62 * H))}${ln(cx + 16, Y(0.62 * H), cx + 30, Y(Number.isFinite(markCm) ? Math.min(markCm, 0.95 * H) : 0.58 * H))}
    ${mark}
  </svg>`;
}

/**
 * 포핸드·백핸드 결과에 붙는 카드. o = { heightCm, wristRatio(임팩트 때 손목 높이 ÷ 키), front(골반보다 앞, ÷ 키 — 옆에서 찍었을 때만), kind('forehand'|'backhand2'|'backhand1'), level }
 */
export function groundHeightCard(root, o) {
  const H = o.heightCm, g = R.groundTargets(H);
  const cm = Number.isFinite(o.wristRatio) && o.wristRatio > 0.1 && o.wristRatio < 1.2 ? Math.round(o.wristRatio * H) : NaN;
  const level = Number.isFinite(cm) ? R.bodyLevel(o.wristRatio) : '';
  const want = g.front[o.kind] || g.front.forehand, name = o.kind === 'forehand' ? '포핸드' : o.kind === 'backhand1' ? '원핸드 백핸드' : '투핸드 백핸드';
  let say = '';
  if (Number.isFinite(cm)) {
    say = cm < g.height[0] - 5 ? `좋은 높이(${range(g.height)}cm)보다 낮은 공이었어요. 허리 말고 <b>무릎을 굽혀</b> 몸을 공 높이로 낮추면 됩니다.`
      : cm > g.height[1] + 5 ? `좋은 높이(${range(g.height)}cm)보다 높은 공이었어요. <b>한 발 물러나 떨어지는 공</b>을 치거나 한 발 들어가 일찍 잡으세요.`
        : `치기 좋은 높이(${range(g.height)}cm)에서 맞혔어요.`;
  }
  const speed = o.level === 'adv' ? 95 : o.level === 'beg' ? 60 : 75;
  const c = R.groundClearance({ speedKmh: speed, rpm: 1000, contactCm: Number.isFinite(cm) ? Math.max(40, Math.min(cm, 150)) : Math.round(0.55 * H) });
  const frontCm = Number.isFinite(o.front) ? Math.round(o.front * H) : NaN;
  root.innerHTML = `<div class="phys">
    ${Number.isFinite(cm) ? `<div class="small muted">손목 높이로 어림한 이번 타점</div><div class="big"><b>${esc(level)}</b><span class="num">약 ${cm}cm</span></div>` : `<div class="small muted">치기 좋은 높이</div><div class="big"><b>허리~가슴</b><span class="num">${range(g.height)}cm</span></div>`}
    ${bodyFigure(H, cm)}
    ${say ? `<p class="small" style="margin-top:10px">${say}</p>` : ''}
    <dl class="kv" style="margin-top:14px">
      <dt>${name} 타점 앞뒤</dt><dd>골반보다 ${range(want)}cm 앞이 좋아요</dd>
      ${Number.isFinite(frontCm) ? `<dt>이번 타점</dt><dd>골반보다 ${Math.abs(frontCm)}cm ${frontCm >= 0 ? '앞' : '뒤'}</dd>` : ''}
    </dl>
    ${Number.isFinite(c.deepM) ? `<h3 style="margin-top:20px">네트 위로 얼마나 높이 넘길까 <span class="muted" style="font-weight:500">· 계산 예시</span></h3>
      <p class="small muted" style="margin:4px 0 8px">이 샷을 잰 값이 아니라, 베이스라인에서 ${speed}km/h(보통 회전)로 친다고 보고 계산한 것입니다. 코트 안쪽에서 치면 더 낮게 넘겨도 됩니다.</p>
      <div class="pattern"><b>깊게 보내려면 <span class="num hl">네트 위 약 ${c.deepM.toFixed(1)}m</span></b><span>${esc(R.netsText(c.deepNets))} 높이로 넘겨야 베이스라인 가까이 떨어집니다.</span></div>
      ${Number.isFinite(c.shortM) ? `<div class="pattern"><b>네트 위 ${c.shortM.toFixed(1)}m 로 낮게 넘기면</b><span>서비스라인 근처에 짧게 떨어져 상대가 치기 쉽습니다.</span></div>` : ''}` : ''}
    <p class="small muted" style="margin-top:10px">${Number.isFinite(cm) ? '타점 높이는 임팩트 때 손목 높이로 본 어림값입니다. 라켓이 위아래로 기울면 10cm 넘게 다를 수 있어요.' : '영상에서 타점 높이를 재지 못했습니다.'}${Number.isFinite(frontCm) ? '' : ' 옆에서 찍으면 타점이 골반보다 몇 cm 앞인지도 알려 드려요.'}</p>
  </div>`;
}

export function renderPhysicsView(root, profile) {
  const s = { h: profile.heightCm || 170, speed: levelSpeed(profile.level), gspeed: 70, hand: profile.hand || 'R' };
  root.innerHTML = `
    <h1>내 키로 보는 타점 높이</h1>
    <p class="lead">키를 넣으면 리치와, 어디서 맞혀야 하는지를 cm 로 알려 드려요.</p>
    <div class="sec"><div class="phys">
      <div class="field" style="margin-top:0"><div class="label">키 <b class="num" id="hV"></b></div><input type="range" id="hR" min="140" max="200" step="1" value="${s.h}" aria-label="키"></div>
      <div id="reachFig"></div>
      <p class="small muted" style="margin-top:8px">리치 = 발을 땅에 붙이고 팔과 라켓을 위로 쭉 뻗었을 때 라켓 한가운데 높이. 키가 10cm 크면 리치는 11~12cm 높아집니다.</p>
    </div></div>
    <div class="sec"><h2>서브</h2><p class="small muted" style="margin:4px 0 12px">종류별로 공을 맞히는 높이와 자리입니다.</p>
      <div id="sRows"></div>
      <h3 style="margin-top:22px">네트 위로 지나가야 하는 틈</h3>
      <p class="small muted" style="margin:4px 0 10px">리치 높이에서 쳤을 때, 서비스 박스에 들어가려면 공이 네트 위 얼마 사이로 지나가야 하는지입니다.</p>
      ${seg('speed', SERVE_SPEEDS.map(([v, l]) => [String(v), `${l} ${v}`]), String(s.speed))}
      <div id="sGap" style="margin-top:12px"></div>
      <p class="small" style="margin-top:10px" id="sSay"></p>
    </div>
    <div class="sec"><h2>포핸드 · 백핸드</h2>
      <dl class="kv" id="gKv"></dl>
      <h3 style="margin-top:22px">네트 위로 얼마나 높이 넘겨야 깊이 가나</h3>
      <p class="small muted" style="margin:4px 0 10px">베이스라인에서 허리 높이로 쳤을 때입니다. 느릴수록 높이 넘겨야 깊이 갑니다.</p>
      ${seg('gspeed', GROUND_SPEEDS.map(([v, l]) => [String(v), `${l} ${v}`]), String(s.gspeed))}
      <div id="gClr" style="margin-top:12px"></div>
    </div>
    <div class="sec"><h2>참고 속도</h2>
      <dl class="kv"><dt>남자 프로 첫 서브 평균</dt><dd>189km/h</dd><dt>여자 프로 첫 서브 평균</dt><dd>164km/h</dd><dt>동호인 상급(NTRP 4.0) 플랫</dt><dd>약 137km/h</dd>
      <dt>프로 포핸드</dt><dd>117~126km/h</dd><dt>동호인 포핸드</dt><dd>66~78km/h</dd></dl>
      <p class="small muted" style="margin-top:10px">${esc('ATP·WTA 상위 10명 평균(최근 시즌)과 동호인 실측 연구에서 가져온 값입니다. 높이·틈은 공기 저항과 회전을 넣은 계산값입니다.')}</p></div>`;
  const draw = () => {
    const { reach } = R.reachOf(s.h);
    $('#hV', root).textContent = `${s.h}cm → 리치 약 ${reach}cm`;
    $('#reachFig', root).innerHTML = reachFigure(s.h, null);
    $('#sRows', root).innerHTML = serveRows(s.h, s.hand, null);
    $('#sGap', root).innerHTML = gapRows(reach, s.speed, s.hand);
    $('#sSay', root).textContent = `플랫 ${s.speed}km/h: ${gapSentence(reach, s.speed, 'flat', s.hand)} 회전(슬라이스·킥)을 걸면 공이 떨어지는 힘이 생겨 틈이 넓어집니다.`;
    const g = R.groundTargets(s.h), b = g.body;
    $('#gKv', root).innerHTML = `<dt>좋은 타점 높이</dt><dd>${esc(g.heightSay)} · 바닥에서 ${range(g.height)}cm</dd>
      <dt>내 몸의 높이</dt><dd>무릎 ${b.knee} · 허리 ${b.waist} · 가슴 ${b.chest} · 어깨 ${b.shoulder}cm</dd>
      <dt>포핸드 타점</dt><dd>골반보다 ${range(g.front.forehand)}cm 앞</dd>
      <dt>투핸드 백핸드</dt><dd>골반보다 ${range(g.front.backhand2)}cm 앞</dd>
      <dt>원핸드 백핸드</dt><dd>골반보다 ${range(g.front.backhand1)}cm 앞</dd>`;
    const c = R.groundClearance({ speedKmh: s.gspeed, rpm: 1000, contactCm: Math.round(0.55 * s.h) });
    const line = (label, m, tail) => (Number.isFinite(m) ? `<div class="pattern"><b>${label} <span class="num hl">네트 위 약 ${m.toFixed(1)}m</span></b><span>${tail}</span></div>` : '');
    $('#gClr', root).innerHTML = line('베이스라인 가까이 깊게', c.deepM, `${esc(R.netsText(c.deepNets))} 높이로 넘겨야 합니다.`)
      + line('코트 가운데쯤', c.midM, '서비스라인과 베이스라인 사이에 떨어집니다.')
      + line('서비스라인 근처(짧음)', c.shortM, '네트를 낮게 스치면 짧게 떨어져 상대가 치기 쉽습니다.')
      || '<div class="callout info">이 속도로는 계산할 수 없어요.</div>';
  };
  $('#hR', root).addEventListener('input', (e) => { s.h = Number(e.target.value); draw(); });
  bindSegs(root, (name, v) => { s[name] = Number(v); draw(); });
  draw();
}

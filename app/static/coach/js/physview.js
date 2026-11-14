// 스윙 코치 — '공이 들어가는 각도' 화면. 타점 높이·속도·회전에 따라 네트를 넘고 라인 안에 떨어지는 발사 각도 폭을 보여 준다.
import * as Phys from './physics.js';
import { $, esc, seg, bindSegs } from './ui.js';

const SPIN = { flat: { spin: 'flat', rpm: 0, label: '플랫' }, slice: { spin: 'slice', rpm: 2200, label: '슬라이스' }, kick: { spin: 'kick', rpm: 3200, label: '킥(스핀)' } };
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');

function serveCalc(s) {
  const sp = SPIN[s.type];
  try {
    return Phys.serveWindow({ contactHeight: s.height, speedKmh: s.speed, spin: sp.spin, spinRpm: sp.rpm, court: s.court, target: s.target, rightHanded: s.hand !== 'L' });
  } catch (_) { return null; }
}

/** 옆에서 본 궤적 그림(SVG). launch = serveWindow().best.launch */
function trajectory(r) {
  if (!r || !r.best || !r.best.launch) return '';
  let sim;
  try { sim = Phys.simulate(r.best.launch); } catch (_) { return ''; }
  const X = (x) => 10 + (x / 24) * 300, Z = (z) => 96 - z * 26;
  const pts = sim.path.map((p) => `${X(p.x).toFixed(1)},${Z(p.z).toFixed(1)}`).join(' ');
  return `<svg class="court" viewBox="0 0 320 104" role="img" aria-label="옆에서 본 공의 궤적">
    <line x1="10" y1="96" x2="310" y2="96" stroke="rgba(255,255,255,.25)" stroke-width="1.5"/>
    <line x1="${X(Phys.COURT.netX ?? 11.885)}" y1="96" x2="${X(Phys.COURT.netX ?? 11.885)}" y2="${Z(0.914)}" stroke="#fff" stroke-width="2"/>
    <line x1="${X(18.285)}" y1="92" x2="${X(18.285)}" y2="100" stroke="var(--ball)" stroke-width="2"/>
    <polyline points="${pts}" fill="none" stroke="var(--ball)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="${X(11.885)}" y="12" font-size="9" fill="rgba(255,255,255,.6)" text-anchor="middle">네트</text>
    <text x="${X(18.285)}" y="12" font-size="9" fill="rgba(255,255,255,.6)" text-anchor="middle">서비스 라인</text></svg>`;
}

/**
 * 서브 계산기를 root 안에 그린다. init = { height(공 타점 높이 m), fixed(영상에서 잰 값이면 true), speed, type, hand, note }
 */
export function serveCalculator(root, init = {}) {
  const s = { height: init.height || 2.5, speed: init.speed || 130, type: init.type || 'flat', target: 'T', court: 'deuce', hand: init.hand || 'R' };
  root.innerHTML = `
    <div class="phys">
      <div class="small muted">네트를 넘고 서비스 박스에 들어가는 발사 각도의 폭</div>
      <div class="big"><b class="num" id="pw">—</b><span id="pwUnit">도</span></div>
      <div class="small" id="pwSay"></div>
      <div id="pTraj"></div>
      <div class="field"><div class="label">공 타점 높이 <b class="num" id="pH"></b>${init.fixed ? ' <span class="muted">· 영상에서 잰 손목 높이 + 라켓 길이</span>' : ''}</div>
        <input type="range" id="rH" min="2.0" max="3.1" step="0.05" value="${s.height}" aria-label="공 타점 높이"></div>
      <div class="field"><div class="label">서브 속도 <b class="num" id="pS"></b></div>
        <input type="range" id="rS" min="70" max="210" step="5" value="${s.speed}" aria-label="서브 속도"></div>
      <div class="field"><div class="label">종류</div>${seg('type', Object.entries(SPIN).map(([k, v]) => [k, v.label]), s.type)}</div>
      <div class="field"><div class="label">노리는 곳</div>${seg('target', [['T', 'T존(센터)'], ['body', '몸쪽'], ['wide', '와이드']], s.target)}</div>
      <div class="bars" id="pBars"></div>
      <p class="small muted" style="margin-top:14px" id="pFoot"></p>
    </div>`;
  const draw = () => {
    const r = serveCalc(s);
    $('#pH', root).textContent = `${s.height.toFixed(2)}m`;
    $('#pS', root).textContent = `${s.speed}km/h`;
    const w = r && r.feasible ? r.windowDeg : 0;
    $('#pw', root).textContent = f1(w);
    const up = serveCalc({ ...s, height: s.height + 0.1 });
    const upW = up && up.feasible ? up.windowDeg : 0;
    let say;
    if (!w) say = '이 높이·속도로는 플랫으로 넣을 수 없어요. 속도를 줄이거나, 회전을 걸거나, 타점을 높여야 합니다.';
    else if (w < 1) say = `여유가 거의 없어요(라켓 면 ±${f1(w / 2)}도). 선수들도 이 속도에서는 회전을 섞습니다.`;
    else if (w < 2.5) say = `라켓 면이 ±${f1(w / 2)}도만 어긋나도 폴트입니다.`;
    else say = `라켓 면 ±${f1(w / 2)}도까지 괜찮아요. 넉넉한 편입니다.`;
    if (upW > w) say += ` 타점을 10cm 높이면 ${f1(upW)}도(${w ? `+${Math.round((upW / w - 1) * 100)}%` : '가능해짐'}).`;
    $('#pwSay', root).textContent = say;
    $('#pTraj', root).innerHTML = trajectory(r);
    const rows = [100, 120, 140, 160, 180].map((v) => { const q = serveCalc({ ...s, speed: v }); return [v, q && q.feasible ? q.windowDeg : 0]; });
    const mx = Math.max(0.1, ...rows.map((x) => x[1]));
    $('#pBars', root).innerHTML = rows.map(([v, x]) => `<div><span>${v}km/h</span><i><b style="width:${Math.round((x / mx) * 100)}%"></b></i><em>${x ? f1(x) + '°' : '불가'}</em></div>`).join('');
    const best = r && r.best;
    $('#pFoot', root).textContent = best && r.feasible
      ? `가장 안전하게 치면 네트 위 ${Math.round(best.netClearanceCm)}cm로 지나 네트에서 ${f1(best.landingDepthM)}m 지점에 떨어집니다. 이 코스에서 공이 넘는 네트 높이는 ${Math.round(r.netHeightOnPathCm)}cm(${s.target === 'wide' ? '와이드는 네트가 높은 쪽을 지나고 서비스 박스 모서리까지 더 멉니다' : s.target === 'T' ? 'T존은 네트가 가장 낮은 가운데를 지납니다' : '가운데와 옆줄 사이'}). 공기 저항과 회전을 넣은 계산이고, 실제는 바람·공 상태에 따라 달라집니다.`
      : '중력 없이 일직선으로 넣으려면 타점이 2.6m 넘게 높아야 합니다. 대부분의 동호인은 내리찍을 수 없고, 수평이거나 살짝 위로 보내야 들어갑니다.';
  };
  $('#rH', root).addEventListener('input', (e) => { s.height = Number(e.target.value); draw(); });
  $('#rS', root).addEventListener('input', (e) => { s.speed = Number(e.target.value); draw(); });
  bindSegs(root, (name, v) => { s[name] = v; draw(); });
  draw();
}

/** 스트로크(포핸드·백핸드): 속도·탑스핀별 여유 */
export function groundCalculator(root, init = {}) {
  const s = { speed: init.speed || 80, rpm: init.rpm ?? 1000, height: init.height || 0.9 };
  root.innerHTML = `
    <div class="phys">
      <div class="small muted">베이스라인에서 쳐서 네트를 넘고 라인 안에 떨어지는 발사 각도의 폭</div>
      <div class="big"><b class="num" id="gw">—</b><span>도</span></div>
      <div class="small" id="gSay"></div>
      <div class="field"><div class="label">공 속도 <b class="num" id="gS"></b></div><input type="range" id="grS" min="50" max="140" step="5" value="${s.speed}" aria-label="공 속도"></div>
      <div class="field"><div class="label">탑스핀 <b class="num" id="gR"></b></div><input type="range" id="grR" min="0" max="3200" step="100" value="${s.rpm}" aria-label="탑스핀"></div>
      <div class="field"><div class="label">타점 높이 <b class="num" id="gH"></b></div><input type="range" id="grH" min="0.3" max="1.6" step="0.05" value="${s.height}" aria-label="타점 높이"></div>
      <p class="small muted" style="margin-top:12px">라켓 면 1도가 공 높이 1도를 바꿉니다(스윙 궤도는 1도에 0.3도쯤). 그래서 네트·아웃은 대부분 면의 문제입니다.</p>
    </div>`;
  const draw = () => {
    let r = null;
    try { r = Phys.groundWindow({ contactHeight: s.height, speedKmh: s.speed, spinRpm: s.rpm, spin: s.rpm ? 'topspin' : 'flat', startY: 0 }); } catch (_) { /* 범위 밖 */ }
    const w = r && r.feasible ? r.windowDeg : 0;
    $('#gw', root).textContent = f1(w);
    $('#gS', root).textContent = `${s.speed}km/h`;
    $('#gR', root).textContent = s.rpm ? `${s.rpm}rpm` : '없음(플랫)';
    $('#gH', root).textContent = `${Math.round(s.height * 100)}cm`;
    $('#gSay', root).textContent = !w ? '이 조건으로는 넣기 어렵습니다.'
      : `라켓 면 ±${f1(w / 2)}도까지 들어갑니다. ${s.speed <= 90 ? '동호인 속도에서는 여유가 넉넉하니, 낮게 깔기보다 네트 위 1~2m로 넘기는 편이 깊이 들어갑니다.' : '속도가 빠를수록 여유가 줄어듭니다. 탑스핀이 여유를 되찾아 줍니다.'}`;
  };
  for (const [id, key] of [['grS', 'speed'], ['grR', 'rpm'], ['grH', 'height']]) $(`#${id}`, root).addEventListener('input', (e) => { s[key] = Number(e.target.value); draw(); });
  draw();
}

export function renderPhysicsView(root, profile) {
  const h = Math.round((profile.heightCm / 100) * 1.45 * 20) / 20;       // 선수는 키의 1.5배쯤에서 맞힌다. 동호인은 조금 낮게 잡는다.
  root.innerHTML = `
    <h1>공이 들어가는 각도</h1>
    <p class="lead">빠를수록, 타점이 낮을수록 여유가 줄어듭니다. 내 조건에서 얼마나 남는지 보세요.</p>
    <div class="sec"><h2>서브</h2><div id="pc-serve"></div></div>
    <div class="sec"><h2>포핸드 · 백핸드</h2><div id="pc-ground"></div></div>
    <div class="sec"><h2>참고 속도</h2>
      <dl class="kv"><dt>남자 프로 첫 서브 평균</dt><dd>189km/h</dd><dt>여자 프로 첫 서브 평균</dt><dd>164km/h</dd><dt>동호인 상급(NTRP 4.0) 플랫</dt><dd>약 137km/h</dd>
      <dt>프로 포핸드</dt><dd>117~126km/h</dd><dt>동호인 포핸드</dt><dd>66~78km/h</dd></dl>
      <p class="small muted" style="margin-top:10px">${esc('ATP·WTA 상위 10명 평균(최근 시즌)과 동호인 실측 연구에서 가져온 값입니다.')}</p></div>`;
  serveCalculator($('#pc-serve', root), { height: h, hand: profile.hand, speed: profile.level === 'adv' ? 150 : profile.level === 'beg' ? 100 : 125 });
  groundCalculator($('#pc-ground', root), {});
}

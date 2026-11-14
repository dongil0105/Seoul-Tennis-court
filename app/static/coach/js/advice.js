// 스윙 코치 — 잰 수치를 동호인 눈높이 조언으로 바꾼다. DOM 을 쓰지 않는다(브라우저·Node 공용).
//
// 원칙
//  · 선수와 똑같이 하라는 게 아니다. 선수 분포(reference.json)와 연구 수치로 '동호인 목표 범위'를 넓게 잡고,
//    그 범위를 벗어난 것만, 한 번에 하나씩 고칠 수 있는 말로 알려 준다.
//  · 길이는 cm 로("15cm 더 앞에서"), 각도는 느낌으로("ㄴ자", "의자에 반쯤 앉듯").
//  · 라켓 면은 직접 보지 못한다. 결과(네트·아웃)를 알려 주면 몸에서 잰 것과 묶어 면 조언을 한다.
import { featureDistance, poseFeature, mirrorPose } from './geom.js';

const r5 = (x) => Math.max(5, Math.round(x / 5) * 5);
const cm = (ratio, ctx) => r5(Math.abs(ratio) * ctx.heightCm);
const deg0 = (x) => Math.round(x);

/** 기준 분포에서 목표 범위를 만든다: 선수 가운데값 ± k·표준편차 를 바깥으로 pad 만큼 넓힘. 표본이 적으면 fallback. */
function band(ctx, stroke, phase, key, fallback, { k = 1.6, pad = 0, minN = 12 } = {}) {
  const st = ctx.ref && ctx.ref.stats && ctx.ref.stats[stroke] && ctx.ref.stats[stroke][phase];
  const s = st && (st[ctx.sex] && st[ctx.sex][key] && st[ctx.sex][key].n >= minN ? st[ctx.sex][key] : st.all && st.all[key]);
  if (!s || s.n < minN || !Number.isFinite(s.sd)) return { lo: fallback[0], hi: fallback[1], src: 'default' };
  const sd = Math.max(s.sd, 1e-6);
  // 선수 범위와 기본 범위 중 더 너그러운 쪽(동호인에게 선수 범위를 그대로 요구하지 않는다)
  return { lo: Math.min(fallback[0], s.mean - k * sd - pad), hi: Math.max(fallback[1], s.mean + k * sd + pad), src: 'pro', pro: s };
}

// ── 규칙표 ──────────────────────────────────────────────────────
// get(m): 수치, range(ctx,m): [lo,hi] 목표 범위, low/high: 범위를 벗어났을 때의 말. sev: 중요도(1~3).
// text 함수는 (값, 범위, ctx, m) 을 받아 { title, why, cue } 를 돌려준다.
const P = (m, ph) => (m.phases && m.phases[ph]) || {};
const sideOnly = (m) => m.view === 'side';

const SERVE = [
  { id: 'serve_knee', phase: 'trophy', label: '무릎 굽힘', unit: '°', sev: 2,
    get: (m) => m.kneeBend, range: (c) => band(c, 'serve', 'trophy', 'kneeAvg', [28, 90]),
    low: (v) => ({ title: '무릎을 거의 쓰지 않고 팔로만 치고 있어요', why: '다리로 밀어 올려야 타점이 높아지고 어깨에 힘이 덜 들어갑니다. 깊이보다 타이밍이 중요해요.',
      cue: '토스를 올리면서 의자에 반쯤 걸터앉듯 무릎을 굽혔다가, 위로 솟으면서 치세요.', you: `${deg0(v)}°`, }) },
  { id: 'serve_toss_arm', phase: 'trophy', label: '토스한 팔', unit: 'h', sev: 3,
    get: (m) => m.tossArmUp, range: () => ({ lo: 0.06, hi: 9 }),
    low: () => ({ title: '토스한 팔이 일찍 떨어져요', why: '팔이 먼저 내려오면 어깨가 빨리 열리고 머리가 숙여져서 네트에 걸리기 쉽습니다.',
      cue: "토스한 손으로 공을 가리킨 채 속으로 '하나' 세고 치세요." }) },
  { id: 'serve_trophy_elbow', phase: 'trophy', label: '트로피 팔꿈치', unit: '°', sev: 1,
    get: (m) => P(m, 'trophy').elbowHit, range: (c) => band(c, 'serve', 'trophy', 'elbowHit', [65, 130]),
    low: (v) => ({ title: '트로피 자세에서 팔꿈치가 너무 접혀 있어요', why: '라켓이 등 뒤로 떨어질 공간이 없어 스윙이 작아집니다.', cue: '팔을 ㄴ자(약 90도)로, 팔꿈치는 어깨 높이까지 올리세요.', you: `${deg0(v)}°` }),
    high: (v) => ({ title: '트로피 자세에서 팔이 거의 펴져 있어요', why: '팔이 펴진 채로는 라켓이 등 뒤로 떨어지지 못해 손목으로만 치게 됩니다.', cue: '팔꿈치를 어깨 높이에서 ㄴ자로 접어 라켓 끝이 하늘을 보게 하세요.', you: `${deg0(v)}°` }) },
  { id: 'serve_turn', phase: 'trophy', label: '몸 돌림', unit: '°', sev: 2,
    get: (m) => m.chestAtTrophy, range: () => ({ lo: 62, hi: 175 }),
    low: () => ({ title: '정면을 보고 서서 팔로만 치고 있어요', why: '몸통을 감았다 풀어야 힘이 실립니다.', cue: '옆으로 서서, 토스할 때 등이 상대에게 살짝 보이게 어깨를 돌리세요.' }) },
  { id: 'serve_contact_height', phase: 'contact', label: '타점 높이', unit: 'h', sev: 3,
    get: (m) => m.wristHeightGround, range: (c) => ({ lo: c.level === 'adv' ? 1.14 : 1.08, hi: 9 }),
    low: (v, b, c) => ({ title: `타점이 낮아요 — 약 ${cm(b.lo + 0.04 - v, c)}cm 더 높은 곳에서 맞히세요`, why: '타점이 낮으면 네트를 넘길 수 있는 각도가 급격히 좁아집니다(아래 "들어가는 각도" 참고).',
      cue: '공이 떨어지기를 기다리지 말고, 가장 높은 곳으로 올라가서 팔을 다 편 채 맞히세요.', you: `손목 ${Math.round(v * c.heightCm)}cm` }) },
  { id: 'serve_contact_elbow', phase: 'contact', label: '임팩트 팔꿈치', unit: '°', sev: 2,
    get: (m) => P(m, 'contact').elbowHit, range: () => ({ lo: 138, hi: 181 }),
    low: (v) => ({ title: '맞는 순간 팔꿈치가 굽어 있어요', why: '팔이 굽으면 타점이 낮아지고 공에 힘이 덜 실립니다.', cue: '맞는 순간 팔꿈치를 다 펴세요. 손이 가장 높은 곳에서 공을 만난다는 느낌으로.', you: `${deg0(v)}°` }) },
  { id: 'serve_arm_trunk', phase: 'contact', label: '팔–몸통 각', unit: '°', sev: 1,
    get: (m) => P(m, 'contact').armTrunk, range: (c) => band(c, 'serve', 'contact', 'armTrunk', [80, 150]),
    low: (v) => ({ title: '팔꿈치가 처져서 옆에서 밀어 치고 있어요', why: '어깨에 부담이 가고 타점이 낮아집니다.', cue: '치는 쪽 어깨를 위로, 반대쪽 어깨를 아래로 기울이며 올라가세요.', you: `${deg0(v)}°` }),
    high: (v) => ({ title: '팔을 귀 옆에 붙여 수직으로만 뻗고 있어요', why: '선수도 팔과 몸통은 100도쯤입니다. 높이는 어깨 기울기와 다리에서 나옵니다.', cue: '팔을 더 들지 말고, 반대쪽(토스한 쪽) 어깨를 내려 어깨선을 기울이세요.', you: `${deg0(v)}°` }) },
  { id: 'serve_contact_front', phase: 'contact', label: '타점 앞뒤', unit: 'h', sev: 3, when: sideOnly,
    get: (m) => m.contactFrontFoot,
    range: (c) => (c.serveType === 'kick' ? { lo: -0.12, hi: 0.3 } : c.serveType === 'slice' ? { lo: 0.0, hi: 0.45 } : { lo: 0.04, hi: 0.5 }),
    low: (v, b, c) => ({ title: `타점이 머리 위나 뒤에 있어요 — 약 ${cm(b.lo + 0.08 - v, c)}cm 더 네트 쪽에서`, why: '플랫·슬라이스 서브는 앞발보다 앞에서 맞아야 체중이 실리고 공이 뜨지 않습니다.',
      cue: '토스를 코트 안쪽으로 한 뼘 더 보내세요. 그냥 떨어뜨리면 앞발 앞 한 뼘쯤에 떨어지게.', you: `앞발보다 ${Math.round(v * c.heightCm)}cm` }),
    high: (v, b, c) => ({ title: '토스가 너무 앞이라 몸이 앞으로 쏟아져요', why: '공을 쫓아 내려가며 치게 되어 네트에 걸리기 쉽습니다.', cue: '토스 팔을 앞으로 밀지 말고 위로 올리세요. 가슴을 세우고 위로 올라가서 치세요.', you: `앞발보다 ${Math.round(v * c.heightCm)}cm` }) },
  { id: 'serve_head', phase: 'contact', label: '머리 고정', unit: 'h', sev: 1,
    get: (m) => m.headMove, range: () => ({ lo: -9, hi: 0.13 }),
    high: () => ({ title: '맞는 순간 머리가 많이 움직여요', why: '머리가 먼저 떨어지면 타점이 낮아지고 방향이 흔들립니다.', cue: '공이 라켓에 맞는 것을 끝까지 보고, 턱을 든 채로 치세요.' }) },
];

const groundCommon = (S, opt) => [
  { id: `${S}_contact_front`, phase: 'contact', label: '타점 앞뒤', unit: 'h', sev: 3, when: sideOnly,
    get: (m) => m.contactFront, range: () => ({ lo: opt.front[0], hi: opt.front[1] }),
    low: (v, b, c) => ({ title: `타점이 늦어요 — 약 ${cm(b.lo + 0.06 - v, c)}cm 더 앞에서 맞히세요`, why: '몸 옆이나 뒤에서 맞으면 힘이 안 실리고, 면이 열려 공이 뜨거나 옆으로 밀립니다.',
      cue: opt.frontCue, you: `골반보다 ${Math.round(v * c.heightCm)}cm 앞` }),
    high: (v, b, c) => ({ title: '타점이 너무 앞이에요 — 팔만 뻗어 치고 있어요', why: '팔이 다 펴진 뒤에 맞으면 손목으로 덮게 되어 네트에 걸리거나 당겨집니다.', cue: '공을 반 박자 더 끌어놓고, 발로 한 걸음 더 다가가서 치세요.', you: `골반보다 ${Math.round(v * c.heightCm)}cm 앞` }) },
  { id: `${S}_contact_front3d`, phase: 'contact', label: '타점 앞뒤', unit: 'h', sev: 2, when: (m) => m.view !== 'side',
    get: (m) => P(m, 'contact').wristFront, range: (c) => band(c, opt.refStroke, 'contact', 'wristFront', [0.05, 0.36], { k: 1.8 }),
    low: () => ({ title: '타점이 몸에 가깝거나 늦어 보여요', why: '가슴보다 충분히 앞에서 맞아야 힘이 실립니다. (옆에서 찍으면 몇 cm 인지 정확히 알려 드릴 수 있어요.)', cue: opt.frontCue }) },
  { id: `${S}_knee`, phase: 'load', label: '무릎 굽힘', unit: '°', sev: 2,
    get: (m) => m.kneeBend, range: (c, m) => ({ lo: m.wristHeightGround < 0.42 ? 38 : 22, hi: 95 }),
    low: (v, b, c, m) => (m.wristHeightGround < 0.42
      ? { title: '낮은 공인데 서서 치고 있어요', why: '허리만 숙이면 라켓이 공 밑으로 들어가지 못해 네트에 걸립니다.', cue: '허리 말고 무릎을 굽혀 엉덩이를 공 높이로 낮추세요.', you: `${deg0(v)}°` }
      : { title: '무릎을 펴고 서서 치고 있어요', why: '다리를 못 쓰면 라켓 속도가 크게 떨어지고 높낮이 조절이 안 됩니다.', cue: '치기 전에 의자에 살짝 앉듯 굽혔다가, 일어나면서 치세요.', you: `${deg0(v)}°` }) },
  { id: `${S}_high_ball`, phase: 'contact', label: '타점 높이', unit: 'h', sev: 2,
    get: (m) => m.wristHeightGround, range: () => ({ lo: -9, hi: opt.highBall }),
    high: (v, b, c) => ({ title: '어깨 위 높은 공을 억지로 쳤어요', why: '높은 타점에서는 라켓 속도가 떨어지고 면 조절이 어렵습니다.', cue: opt.highCue, you: `손목 ${Math.round(v * c.heightCm)}cm` }) },
  { id: `${S}_turn`, phase: 'backswing', label: '어깨 턴', unit: '°', sev: 3,
    get: (m) => m.chestAtBackswing, range: () => ({ lo: opt.turn, hi: 181 }),
    low: (v) => ({ title: '어깨 턴이 부족해요 — 팔로만 치고 있어요', why: '몸통을 돌렸다 풀어야 힘이 실리고 타점도 앞으로 나옵니다.', cue: opt.turnCue, you: `${deg0(v)}°` }) },
  { id: `${S}_lean_back`, phase: 'contact', label: '상체 기울기', unit: 'h', sev: 2, when: sideOnly,
    get: (m) => m.headFront, range: () => ({ lo: -0.075, hi: 9 }),
    low: () => ({ title: '상체가 뒤로 젖혀진 채 맞고 있어요', why: '체중이 뒷발에 남으면 면이 열려 공이 길게 뜹니다.', cue: '가슴을 공 쪽으로 내미세요. 코가 앞발 위에 오게.' }) },
  { id: `${S}_head`, phase: 'contact', label: '머리 고정', unit: 'h', sev: 1,
    get: (m) => m.headMove, range: () => ({ lo: -9, hi: 0.11 }),
    high: () => ({ title: '맞는 순간 머리가 돌아가요', why: '머리가 먼저 돌면 타점이 흔들리고 몸이 옆으로 빠집니다.', cue: '맞는 순간 머리를 타점에 남기세요. 공이 있던 자리를 반 박자 더 보세요.' }) },
];

const FOREHAND = [
  ...groundCommon('fh', { front: [0.08, 0.36], refStroke: 'forehand', highBall: 0.78, turn: 68,
    frontCue: '앞발 무릎 앞에서 맞힌다고 생각하세요. 준비(어깨 턴)를 공이 네트를 넘기 전에 끝내면 타점이 앞으로 나옵니다.',
    highCue: '한 발 뒤로 물러나 떨어지는 공을 치거나, 준비를 높게 하고 옆으로(수평으로) 휘두르세요.',
    turnCue: '왼손으로 라켓 목을 잡고 같이 돌리세요. 왼쪽 어깨가 턱 밑에 오면 충분합니다.' }),
  { id: 'fh_rotation', phase: 'contact', label: '몸통 회전', unit: '°', sev: 2,
    get: (m) => m.chestAtContact, range: () => ({ lo: -9, hi: 62 }),
    high: (v) => ({ title: '맞는 순간에도 몸이 옆을 보고 있어요', why: '골반과 가슴이 돌아 나오지 않으면 팔로 밀어 치게 됩니다.', cue: '골반이 먼저, 어깨는 나중에. 맞는 순간 배꼽이 네트를 보게 돌리세요.', you: `${deg0(v)}°` }) },
  { id: 'fh_jammed', phase: 'contact', label: '공과의 거리', unit: '°', sev: 2,
    get: (m) => P(m, 'contact').elbowHit, range: () => ({ lo: 88, hi: 181 }),
    low: (v) => ({ title: '공과 너무 가까워 팔꿈치가 몸에 끼었어요', why: '팔이 접힌 채 맞으면 면이 닫히고 스윙이 작아집니다.', cue: '공과 한 팔 거리를 두세요. 겨드랑이에 주먹 하나 들어갈 틈을 만드세요.', you: `${deg0(v)}°` }) },
  { id: 'fh_finish', phase: 'finish', label: '팔로스루', unit: 'h', sev: 1,
    get: (m) => P(m, 'finish').wristSide, range: () => ({ lo: -9, hi: 0.06 }),
    high: () => ({ title: '팔로스루가 짧게 멈춰요', why: '끝까지 휘두르지 않으면 맞기 전부터 라켓이 느려집니다.', cue: '라켓이 반대쪽 어깨까지 가게 끝까지 휘두르세요. 팔꿈치가 상대를 가리키며 끝나게.' }) },
];

const BACKHAND_2H = [
  ...groundCommon('bh2', { front: [0.05, 0.32], refStroke: 'backhand', highBall: 0.76, turn: 62,
    frontCue: '앞 골반 앞에서 맞히세요. 한 뼘만 더 앞에서!',
    highCue: '한 발 들어가 가슴 높이에서 잡거나, 물러나서 떨어지는 공을 치세요.',
    turnCue: '치는 쪽 어깨 너머로 공을 보세요. 등이 살짝 상대에게 보이게 돌리면 됩니다.' }),
  { id: 'bh2_rotation', phase: 'contact', label: '골반 회전', unit: '°', sev: 2,
    get: (m) => m.chestAtContact, range: () => ({ lo: -9, hi: 78 }),
    high: (v) => ({ title: '골반이 안 돌고 팔로만 치고 있어요', why: '투핸드는 몸통 회전이 힘의 대부분입니다.', cue: '치면서 배꼽이 네트를 보게 돌리세요. 뒷발 뒤꿈치가 들리면 잘한 겁니다.', you: `${deg0(v)}°` }) },
  { id: 'bh2_jammed', phase: 'contact', label: '팔 뻗기', unit: '', sev: 1,
    get: (m) => P(m, 'contact').reach, range: () => ({ lo: 0.7, hi: 9 }),
    low: () => ({ title: '두 팔이 몸에 붙어 스윙이 작아요', why: '공과 가까우면 팔을 펼 공간이 없습니다.', cue: '두 팔을 앞으로 쭉 밀어 주세요. 왼손으로 치는 포핸드라고 생각하면 쉽습니다.' }) },
];

const BACKHAND_1H = [
  ...groundCommon('bh1', { front: [0.13, 0.44], refStroke: 'backhand', highBall: 0.72, turn: 88,
    frontCue: '팔을 쭉 펴고 앞발보다 앞에서 맞히세요. 칼을 뽑듯이 앞으로.',
    highCue: '어깨보다 높으면 슬라이스로 넘기세요. 아니면 한 발 들어가 가슴 높이에서 잡으세요.',
    turnCue: '등이 상대에게 보일 만큼 돌리세요. 턱이 치는 쪽 어깨에 닿으면 충분합니다.' }),
  { id: 'bh1_open', phase: 'contact', label: '어깨 열림', unit: '°', sev: 3,
    get: (m) => m.chestAtContact, range: () => ({ lo: 42, hi: 181 }),
    low: (v) => ({ title: '어깨가 일찍 열려요', why: '원핸드는 맞는 순간까지 옆으로 서 있어야 라켓이 앞으로 나갑니다.', cue: '반대 손을 뒤로 뻗어 가슴을 펴세요. 치고 나서도 옆으로 서 있으세요.', you: `${deg0(v)}°` }) },
  { id: 'bh1_elbow', phase: 'contact', label: '임팩트 팔꿈치', unit: '°', sev: 3,
    get: (m) => P(m, 'contact').elbowHit, range: () => ({ lo: 148, hi: 181 }),
    low: (v) => ({ title: '팔꿈치가 굽은 채 맞고 있어요', why: '원핸드에서 가장 흔한 실수입니다. 팔이 굽으면 라켓 헤드가 올라오지 못합니다.', cue: '스윙을 시작하기 전에 팔을 먼저 펴고, 편 채로 휘두르세요.', you: `${deg0(v)}°` }) },
];

export function rulesFor(m) {
  if (m.stroke === 'serve') return SERVE;
  if (m.stroke === 'forehand') return FOREHAND;
  return m.twoHanded ? BACKHAND_2H : BACKHAND_1H;
}

// ── 결과(네트·아웃)와 몸에서 잰 것을 묶은 한마디 ────────────────
const RESULT = {
  serve: {
    net: [['serve_contact_height', '타점이 낮아 네트를 넘길 각도가 부족했을 가능성이 큽니다.'], ['serve_toss_arm', '토스한 팔이 일찍 떨어지며 머리가 숙여졌을 수 있어요.'], ['serve_contact_front:high', '토스가 너무 앞이라 내려찍었을 수 있어요.']],
    netDefault: '내리찍지 말고 위로 올려 치세요. 네트 위로 라켓 하나 높이를 넘긴다는 생각으로, 면은 조금 더 열린 느낌으로.',
    long: [['serve_contact_front', '타점이 머리 위·뒤라서 면이 열린 채 맞았을 가능성이 큽니다.']],
    longDefault: '토스를 한 뼘만 더 앞으로 보내고, 공의 뒤가 아니라 뒤쪽 위를 쓸어 올리듯(면을 살짝 닫는 느낌) 치세요.',
  },
  ground: {
    net: [['_knee', '낮은 공에 서서 쳐서 라켓이 공 밑으로 못 들어갔을 가능성이 큽니다.'], ['_contact_front:high', '타점이 너무 앞이라 손목으로 덮었을 수 있어요.'], ['_jammed', '공과 가까워 면이 닫힌 채 맞았을 수 있어요.']],
    netDefault: '라켓을 공보다 30cm 아래에서 출발시켜 아래에서 위로 쓸어 올리세요. 면은 5도쯤 더 여는 느낌으로.',
    long: [['_contact_front', '타점이 늦어 면이 열린 채 맞았을 가능성이 큽니다.'], ['_lean_back', '상체가 뒤로 젖혀져 공이 떴을 가능성이 큽니다.'], ['_high_ball', '높은 공을 걷어 올려 길어졌을 수 있어요.']],
    longDefault: '면을 5도쯤 닫는 느낌으로, 더 앞에서 맞히세요. 면 1도가 공 높이 1도를 바꿉니다(스윙 궤도보다 3배 민감).',
    wide: [['_contact_front', '타점이 늦으면 공이 치는 손 쪽으로 밀려 나갑니다.'], ['_turn', '어깨 턴이 부족해 팔로 방향을 만들고 있어요.']],
    wideDefault: '준비를 일찍 끝내고, 발로 공에 다가가서 몸 앞에서 맞히세요.',
    short: [['_turn', '몸통 회전 없이 팔로만 쳐서 힘이 안 실렸습니다.'], ['_contact_front', '몸 옆에서 밀어 쳐서 짧았습니다.'], ['_knee', '다리를 못 써서 라켓 속도가 떨어졌습니다.']],
    shortDefault: '네트 위 2~3m 높이로 넘긴다고 생각하세요. 동호인 속도에서는 높이 넘겨야 깊이 들어갑니다.',
  },
};

/**
 * 조언 만들기.
 * m = swingMetrics 결과, ctx = { ref(reference.json 내용), sex 'M'|'F'|'U', heightCm, level 'beg'|'mid'|'adv', serveType 'flat'|'slice'|'kick', result 'net'|'long'|'wide'|'short'|'good'|null }
 * 돌려주는 것: { score, grade, items:[{id,phase,label,sev,side,title,why,cue,you,target,delta}], good:[{label,text}], resultNote, notes:[...] }
 */
export function advise(m, ctxIn = {}) {
  const ctx = { sex: 'U', heightCm: 170, level: 'mid', serveType: 'flat', result: null, ref: null, ...ctxIn };
  const items = [], good = [], notes = [];
  for (const rule of rulesFor(m)) {
    if (rule.when && !rule.when(m)) continue;
    const v = rule.get(m);
    if (!Number.isFinite(v)) continue;
    const b = rule.range(ctx, m);
    // 타점 앞뒤는 프레임 간격 때문에 생기는 위치 오차(posErr)보다 크게 벗어났을 때만 말한다
    const tol = /contact_front$/.test(rule.id) && Number.isFinite(m.posErr) ? Math.min(0.12, m.posErr) : 0;
    const sideHit = v < b.lo - tol ? 'low' : v > b.hi + tol ? 'high' : null;
    if (tol && !sideHit && (v < b.lo || v > b.hi)) notes.push('타점 앞뒤가 경계선에 있는데, 영상 프레임 간격 때문에 확실히 말하기 어렵습니다. 슬로모션으로 찍으면 정확해집니다.');
    if (!sideHit || !rule[sideHit]) {
      if (b.src === 'pro' || rule.sev >= 2) good.push({ id: rule.id, label: rule.label, phase: rule.phase });
      continue;
    }
    const t = rule[sideHit](v, b, ctx, m);
    const span = Math.max(1e-6, (Number.isFinite(b.hi) && b.hi < 8 && b.lo > -8 ? b.hi - b.lo : Math.abs(b.lo > -8 ? b.lo : b.hi)) || 1);
    const off = sideHit === 'low' ? b.lo - v : v - b.hi;
    items.push({ id: rule.id, phase: rule.phase, label: rule.label, sev: rule.sev, side: sideHit, weight: rule.sev * (1 + Math.min(1.5, off / span)), ...t });
  }
  items.sort((a, b2) => b2.weight - a.weight);

  // 점수: 걸린 항목의 무게만큼 깎는다. 화질이 낮으면 점수 대신 '참고용'이라고 알린다.
  const penalty = items.reduce((s, it) => s + 6 * it.weight, 0);
  const score = Math.round(Math.max(38, Math.min(97, 96 - penalty)));
  const grade = score >= 88 ? '아주 좋아요' : score >= 76 ? '좋아요' : score >= 62 ? '조금만 다듬으면' : '기본부터 하나씩';
  if (m.conf < 0.6) notes.push('화면에서 팔다리가 잘 안 보여 정확도가 낮습니다. 몸 전체가 크게 나오게, 밝은 곳에서 다시 찍어 보세요.');
  if (m.view !== 'side') notes.push('옆에서 찍으면 타점이 몇 cm 앞·뒤인지까지 알려 드릴 수 있어요.');
  if (m.sf > 1.5) notes.push(m.sfAuto ? '슬로모션 영상으로 보고 분석했습니다. 일반 속도 영상이면 위에서 바꿔 주세요.' : '슬로모션 영상이라 타점 위치가 더 정확하게 잡힙니다.');
  if (m.uncertain) notes.push('포핸드인지 백핸드인지 확실하지 않습니다. 종류를 직접 골라 주세요.');

  let resultNote = null;
  if (ctx.result && ctx.result !== 'good') {
    const table = m.stroke === 'serve' ? RESULT.serve : RESULT.ground;
    const list = table[ctx.result] || [];
    const hit = list.find(([key]) => {
      const [suffix, sideWant] = key.split(':');
      return items.some((it) => it.id.endsWith(suffix) && (!sideWant || it.side === sideWant) && (sideWant || it.side === 'low' || !/contact_front$/.test(suffix)));
    });
    resultNote = hit ? hit[1] : table[`${ctx.result}Default`] || null;
    if (hit && table[`${ctx.result}Default`]) resultNote += ' ' + table[`${ctx.result}Default`];
  }
  return { score, grade, items, good, resultNote, notes };
}

/**
 * 대조군 찾기: 같은 스트로크·같은 순간의 선수 자세 중 내 자세와 가장 닮은 것.
 * 닮은 것 중에서도 선수 분포의 한가운데에 가까운(따라 하기 쉬운) 자세를 앞에 둔다.
 */
export function matchReference(ref, stroke, phase, pose, { hand = 'R', sex = 'U', top = 3 } = {}) {
  if (!ref || !ref.samples || !pose) return [];
  const feat = poseFeature(hand === 'L' ? mirrorPose(pose) : pose);
  const cands = ref.samples.filter((s) => s.stroke === stroke && s.phase === phase && s.feat);
  const scored = cands.map((s) => {
    const d = featureDistance(feat, s.feat);
    const bonus = (sex !== 'U' && s.sex === sex ? -0.008 : 0) + 0.02 * (s.extreme || 0);
    return { sample: s, dist: d, score: d + bonus };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, top);
}

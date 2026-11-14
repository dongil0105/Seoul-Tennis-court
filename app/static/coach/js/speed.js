// 스윙 코치 — 공 속도 예측. 공을 직접 재지 않는다. 영상에서 잰 '손목이 가장 빨랐던 속도'에 환산 계수를 곱해 참고 범위로 말한다.
// DOM 을 쓰지 않는다(브라우저·Node 공용).
//
// 왜 손목인가: 휴대폰 영상(초당 30~60장)에서 공은 한두 장에만 흐릿하게 찍혀 직접 재기 어렵다. 손목은 자세 인식으로 매 장 잡힌다.
//
// 환산 계수는 검증된 값이 아니다. 같은 방식으로 잰 영상 몇 개와 알려진 평균 속도를 맞춘 경험값이다.
//  · 포핸드·백핸드 2.4: 이 앱의 방식으로 잰 프로 경기 포핸드 한 개의 손목 속도(약 14.5 m/s)와 프로 포핸드 평균 공 속도(117~126 km/h)를 맞춘 값.
//    백핸드(원핸드·투핸드)는 따로 맞춰 보지 못해 같은 값을 쓴다.
//  · 서브 3.0: 실험실에서 잰 값(손목 10.8 → 라켓 헤드 27.4 → 공 46.4 m/s, 공 ÷ 손목 ≈ 4.3)과는 재는 방식이 다르다.
//    실험실은 '맞는 순간의 손목 속도'이고, 이 앱은 '스윙 중 가장 빨랐던 손목 속도'(골반 기준, 자세 인식의 떨림 포함)라 더 높게 잡힌다.
//    그래서 시범 영상의 값이 그럴듯한 범위에 들어오도록 낮춰 잡았다.
//  · 같은 스윙이면 회전에 힘이 나뉘어 슬라이스는 플랫의 약 0.9배, 킥은 약 0.79배(선수 실측 187 / 167 / 147 km/h).
// 그래서 값 하나가 아니라 ±25~30% 참고 범위로 보여 주고, 화면에도 '예측'이며 실제 값은 범위를 벗어날 수 있다고 적는다.
// 스피드건이나 다른 앱으로 잰 실제 속도를 한 번 알려 주면 그 비율로 맞춘다(cal). 스트로크마다 따로 맞춘다.
const K = { serve: 3.0, forehand: 2.4, backhand: 2.4 };
const SERVE_TYPE = { flat: 1, slice: 0.9, kick: 0.79 };
export const LIMIT = { serve: [40, 230], forehand: [25, 170], backhand: [25, 160] };   // 이 범위를 벗어나면 잘못 잰 것으로 보고 숫자를 내지 않는다
const MAX_GAP = 1 / 20;        // 가장 빠른 순간 앞뒤 프레임 간격이 이보다 넓으면(초당 20장 미만) 속도를 말하지 않는다
const r5 = (x) => Math.round(x / 5) * 5;

/** 프레임 간격이 길수록 가장 빠른 순간이 뭉개져 낮게 잡힌다 → 초당 30장이면 12%, 60장이면 4% 올려 잡는다(120장 이상은 그대로) */
export function frameGain(step) {
  if (!(step > 0)) return 1.08;
  const t = Math.min(1, Math.max(0, (step - 1 / 120) / (1 / 30 - 1 / 120)));
  return 1 + 0.12 * t;
}

/**
 * 공 속도 예측.
 * o = { stroke 'serve'|'forehand'|'backhand', serveType 'flat'|'slice'|'kick', peak(손목 최고 속도: 모델 미터/영상 1초), bodyH(모델 미터로 잰 키),
 *       heightCm(실제 키), sf(슬로모션 배수), sfAuto(배수를 영상에서 예측했는지), step(가장 빠른 순간 앞뒤 프레임 간격의 평균, 영상 시간 초),
 *       stepMax(앞뒤 간격 중 넓은 쪽. 없으면 step),
 *       sfGiven(영상 속도를 사용자가 직접 골랐는지), sfIgnored(슬로모션이라고 골랐지만 분석에 반영하지 못했는지 — 긴 영상),
 *       vis(또렷함 0~1), view, suspect, cal(사용자가 실제 속도로 맞춘 비율. 없으면 1) }
 * 돌려주는 것: { ok, stroke, kmh, lo, hi, wristKmh, pct(±%), cal(맞췄는지), raw(맞추기 전 km/h), assumed(일반 속도 영상이라고 가정했는지),
 *              slow(계산에 쓴 슬로모션 배수. 일반 속도면 0), calOut(맞춘 값 때문에 범위를 벗어났는지), why(ok 가 아닐 때 이유) }
 */
export function estimateSpeed(o) {
  const no = (why) => ({ ok: false, stroke: o.stroke, kmh: NaN, lo: NaN, hi: NaN, wristKmh: NaN, pct: NaN, cal: false, raw: NaN, assumed: false, slow: 0, calOut: false, why });
  const k = K[o.stroke];
  if (!k) return no('종류를 알 수 없어요');
  if (o.suspect) return no('공을 치는 스윙이 아닌 것 같아요');
  if (o.sub) return no('발리·스매시는 아직 속도를 예측하지 않아요');
  if (!(o.peak > 0) || !(o.bodyH > 0.5) || !(o.heightCm > 100)) return no('손목 속도를 재지 못했어요');
  if (Number.isFinite(o.vis) && o.vis < 0.6) return no('팔이 또렷하게 보이지 않아 속도를 예측할 수 없어요');
  // 슬로모션: 배수를 사용자가 알려 줬으면 그만큼 곱한다. 영상에서 예측한 배수는 '보통 속도로 쳤다'고 가정한 값이라 속도 계산에 쓸 수 없다.
  if (o.sfAuto) return no('슬로모션 영상은 실제 시간을 알 수 없어 속도를 예측할 수 없어요(영상 속도를 직접 고르면 됩니다)');
  // 긴 영상은 일반 속도로 보고 분석한다. 사용자가 슬로모션이라고 했으면 그 가정이 틀린 것이므로 숫자를 내지 않는다.
  if (o.sfIgnored) return no('긴 슬로모션 영상은 속도를 예측할 수 없어요(스윙 부분만 25초 안쪽으로 잘라 올리면 됩니다)');
  const sf = o.sf > 1 ? o.sf : 1;
  const gap = o.step > 0 ? o.step / sf : NaN;                         // 실제 시간으로 본 프레임 간격
  if (!(gap > 0)) return no('프레임 간격을 알 수 없어 속도를 예측할 수 없어요');
  // 판정은 앞뒤 간격 중 넓은 쪽으로 한다(한쪽만 프레임이 빠져도 가장 빠른 순간을 놓친 것이다). 올려 잡는 정도(frameGain)는 평균 간격으로.
  const worst = (o.stepMax > 0 ? o.stepMax : o.step) / sf;
  if (worst > MAX_GAP + 1e-9) return no('가장 빠른 순간의 화면이 드문드문 찍혀 속도를 예측할 수 없어요');
  const wrist = o.peak * (o.heightCm / 100 / o.bodyH) * sf * frameGain(gap);   // 실제 m/s
  const type = o.stroke === 'serve' ? (SERVE_TYPE[o.serveType] || 1) : 1;
  const [min, max] = LIMIT[o.stroke];
  const base = wrist * k * type * 3.6;                                // 맞추기 전
  const cal = Number.isFinite(o.cal) && o.cal > 0 ? Math.min(2, Math.max(0.5, o.cal)) : 1;
  const kmh = base * cal;
  // 범위를 벗어난 값은 자르지 않는다 — 잘못 잰 것(슬로모션을 일반 속도로 읽었거나 자세 인식이 튄 경우)이라 숫자를 내지 않는다.
  // 맞추기 전 값부터 본다: 잘못 잰 값이 맞춘 비율 때문에 그럴듯한 숫자로 바뀌어 나오면 안 된다.
  const E = 1e-6;
  if (base < min - E) return no('스윙이 너무 느리게 잡혀 속도를 예측할 수 없어요(슬로모션 영상이면 영상 속도를 직접 골라 주세요)');
  if (base > max + E) return no('손목 속도가 터무니없이 크게 잡혀 속도를 예측할 수 없어요');
  if (kmh < min - E || kmh > max + E) return { ...no('맞춘 값을 곱하면 나올 수 없는 속도가 돼요. 맞춘 값을 지우고 다시 맞춰 주세요'), calOut: true };
  // 참고 범위: 옆에서 찍지 않았으면 깊이 방향 움직임을 덜 정확하게 재므로 넓힌다. 한 번 맞췄다고 좁히지 않는다(오차를 검증한 것이 아니다).
  const pct = (o.view === 'side' ? 0.25 : 0.3) + (sf > 1 ? 0.05 : 0);
  return { ok: true, stroke: o.stroke, kmh: r5(kmh), lo: r5(kmh * (1 - pct)), hi: r5(kmh * (1 + pct)), wristKmh: Math.round(wrist * 3.6), pct: Math.round(pct * 100), cal: cal !== 1, raw: base,
    assumed: sf === 1 && !o.sfGiven,                                  // 일반 속도 영상이라고 '가정'한 값(슬로모션이면 실제보다 낮게 나온다) → 화면에 적는다
    slow: sf > 1 ? sf : 0, calOut: false,
    why: null };
}

/** 가장 빠른 순간(ip) 앞뒤의 실제 프레임 간격(초): 평균(step)과 넓은 쪽(stepMax). 사람이 안 잡혀 빠진 프레임이 있으면 그만큼 넓게 나온다. */
function gapAtPeak(shot) {
  const f = shot.frames, ip = shot.swing ? shot.swing.ip : NaN;
  if (Array.isArray(f) && Number.isInteger(ip) && ip > 0 && ip < f.length - 1) {
    const before = f[ip].t - f[ip - 1].t, after = f[ip + 1].t - f[ip].t;
    return { step: (before + after) / 2, stepMax: Math.max(before, after) };
  }
  return { step: shot.step, stepMax: shot.step };
}

/** 샷(스윙 + 잰 값)에서 바로 예측한다. cal = { serve, forehand, backhand } (없으면 맞추지 않음) */
export function shotSpeed(shot, { heightCm, serveType, cal } = {}) {
  const sw = shot.swing || {}, m = shot.m || {};
  const stroke = m.stroke || sw.stroke;
  return estimateSpeed({ cal: cal ? cal[stroke] : 1, stroke, serveType: serveType || shot.serveType || 'flat', peak: sw.peak, bodyH: sw.h, heightCm,
    sf: sw.sf, sfAuto: sw.sfAuto, sfGiven: !!shot.sfGiven, sfIgnored: !!shot.sfIgnored, ...gapAtPeak(shot), vis: m.vis, view: m.view, suspect: m.suspect || sw.suspect, sub: m.sub || sw.sub || null });
}

/**
 * 사용자가 아는 실제 속도(km/h)로 맞출 비율을 구한다: 실제 ÷ 맞추기 전 예측값.
 * 그 스트로크에서 나올 수 없는 속도이거나 예측값의 절반~2배 밖이면 받지 않는다(null).
 */
export function calibration(est, knownKmh) {
  if (!est || !est.ok || !(est.raw > 0) || !LIMIT[est.stroke]) return null;
  const [min, max] = LIMIT[est.stroke];
  if (!(knownKmh >= min) || !(knownKmh <= max)) return null;
  const f = knownKmh / est.raw;
  return f >= 0.5 && f <= 2 ? f : null;                             // 반올림하지 않는다(경계값을 넣었을 때 다시 계산해도 그 값이 나오게)
}

/** 견줄 기준 속도(km/h). ATP·WTA 최근 시즌 평균과 동호인 실측 연구에서 가져온 값. */
export function benchmarks(stroke) {
  if (stroke === 'serve') return [['동호인 상급 플랫', 137], ['여자 프로 첫 서브', 164], ['남자 프로 첫 서브', 189]];
  if (stroke === 'forehand') return [['동호인 포핸드', 72], ['프로 포핸드', 122]];
  return [['동호인 백핸드', 68], ['프로 백핸드', 106]];
}

/** 여러 샷의 속도 요약: 예측할 수 있었던 샷들의 평균과 가장 큰 값. of = 전체 샷 수, assumed = 일반 속도 영상이라고 가정한 샷이 있는지. 없으면 null */
export function speedSummary(list) {
  const ok = list.filter((e) => e && e.ok);
  if (!ok.length) return null;
  const avg = ok.reduce((s, e) => s + e.kmh, 0) / ok.length;
  return { n: ok.length, of: list.length, avg: r5(avg), max: Math.max(...ok.map((e) => e.kmh)), cal: ok.some((e) => !!e.cal), assumed: ok.some((e) => !!e.assumed) };
}

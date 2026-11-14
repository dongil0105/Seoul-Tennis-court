// 스윙 코치 — 여러 샷(영상 여러 개 포함)을 모아 종합 판단을 만든다. DOM 을 쓰지 않는다(브라우저·Node 공용).
//
// 샷 하나 = { m: swingMetrics 결과, a: advise 결과, vid: 영상 번호 }.
// 종합은 '되풀이되는 것'을 본다: 한 번 나온 문제보다 열 번 중 여덟 번 나온 문제가 먼저다.
const KINDS = ['serve', 'forehand', 'backhand'];
const KIND_LABEL = { serve: '서브', forehand: '포핸드', backhand: '백핸드' };
export const gradeOf = (score) => (score >= 88 ? '아주 좋아요' : score >= 76 ? '좋아요' : score >= 62 ? '조금만 다듬으면' : '기본부터 하나씩');

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs) => { if (xs.length < 2) return NaN; const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const finite = (xs) => xs.filter((x) => Number.isFinite(x));
/** 제목에서 '— 약 15cm 더 앞에서' 같은 샷마다 다른 꼬리를 뗀다 */
export const baseTitle = (t) => String(t || '').replace(/\s+—\s+.*$/, '');

/**
 * 서브 준비 동작(공 튀기기·테이크백·토스)이 포핸드·백핸드로 잘못 잡힌 것을 뺀다.
 * 같은 영상에서 서브 임팩트 3초 전부터 1.2초 뒤까지는 같은 사람이 다른 스트로크를 칠 수 없다(슬로모션이면 그만큼 늘려 본다).
 */
export function dropServePrep(shots) {
  const serves = shots.filter((s) => s.m.stroke === 'serve');
  if (!serves.length) return shots;
  return shots.filter((s) => s.m.stroke === 'serve' || !serves.some((v) => {
    const sf = v.swing.sf || 1;
    return (v.vid ?? 0) === (s.vid ?? 0) && s.swing.tc > v.swing.tc - 3 * sf && s.swing.tc < v.swing.tc + 1.2 * sf;
  }));
}

/** 가운데값에 해당하는 항목(그림·문구의 대표로 쓴다) */
function medianItem(occ) {
  const withValue = occ.filter((o) => Number.isFinite(o.item.value)).sort((a, b) => a.item.value - b.item.value);
  return withValue.length ? withValue[withValue.length >> 1] : occ[0];
}

/** 스트로크 한 종류의 요약 */
function block(kind, shots, idx) {
  const list = idx.filter((i) => shots[i].m.stroke === kind);
  const rated = list.filter((i) => shots[i].a.score != null);
  const clear = rated.filter((i) => shots[i].m.vis >= 0.6);
  const pool = clear.length >= 2 ? clear : rated;
  const ranked = pool.slice().sort((a, b) => shots[b].a.score - shots[a].a.score);
  const best = ranked.slice(0, Math.min(2, Math.ceil(ranked.length / 2)));
  const worst = ranked.length > best.length ? ranked.slice(-Math.min(2, ranked.length - best.length)).reverse() : [];

  // 되풀이되는 문제: 같은 조언이 몇 개의 샷에서 나왔나(점수를 매긴 샷만 센다)
  const occ = {};
  // 같은 항목이라도 방향이 반대면(타점이 늦음 / 너무 앞) 다른 문제다 → 따로 센다
  for (const i of rated) for (const item of shots[i].a.items) (occ[`${item.id}:${item.side || ''}`] ||= []).push({ item, shot: i });
  const need = rated.length <= 1 ? 1 : Math.max(2, Math.ceil(rated.length * 0.4));
  const patterns = Object.entries(occ).filter(([, o]) => o.length >= need).map(([, o]) => {
    const rep = medianItem(o);
    return { kind, id: rep.item.id, side: rep.item.side, n: o.length, of: rated.length, share: o.length / rated.length, weight: mean(o.map((x) => x.item.weight || x.item.sev || 1)),
      item: rep.item, shot: rep.shot, title: baseTitle(rep.item.title), cue: rep.item.cue, why: rep.item.why, label: rep.item.label };
  }).sort((a, b) => b.share * b.weight - a.share * a.weight);

  // 꾸준히 잘하는 것: 점수를 매긴 샷의 70% 이상에서 '좋음'
  const goodCount = {};
  for (const i of rated) for (const g of new Set((shots[i].a.good || []).map((x) => x.label))) goodCount[g] = (goodCount[g] || 0) + 1;
  const strengths = Object.entries(goodCount).filter(([label, n]) => rated.length && n / rated.length >= 0.7 && !patterns.some((p) => p.label === label))
    .map(([label, n]) => ({ kind, label, n, of: rated.length })).sort((a, b) => b.n - a.n);

  // 타점이 샷마다 얼마나 흔들리나(키의 몇 배 단위 표준편차). 점수를 매길 만큼 또렷한 샷에서 세 개 이상 잰 값이 있을 때만.
  const front = finite(pool.map((i) => (shots[i].m.view === 'side' ? (kind === 'serve' ? shots[i].m.contactFrontFoot : shots[i].m.contactFront) : NaN)));
  const high = finite(pool.map((i) => shots[i].m.wristHeightGround));
  const spread = { front: front.length >= 3 ? sd(front) : NaN, height: high.length >= 3 ? sd(high) : NaN, heightMean: high.length ? mean(high) : NaN, frontMean: front.length ? mean(front) : NaN };

  return { kind, label: KIND_LABEL[kind], list, n: list.length, rated: rated.length, avg: rated.length ? Math.round(mean(rated.map((i) => shots[i].a.score))) : null,
    best, worst, patterns, strengths, spread, twoHanded: list.filter((i) => shots[i].m.twoHanded).length > list.length / 2 };
}

/**
 * 종합 판단.
 * 돌려주는 것: { n, rated, score, grade, kinds:[block…], priorities:[pattern…](가장 먼저 고칠 것, 많아야 3개), strengths:[…], videos }
 */
export function summarize(shots) {
  const idx = shots.map((_, i) => i);
  const kinds = KINDS.map((k) => block(k, shots, idx)).filter((b) => b.n > 0);
  const ratedAll = idx.filter((i) => shots[i].a.score != null);
  const clear = ratedAll.filter((i) => shots[i].m.vis >= 0.6);
  const pool = clear.length >= Math.max(1, ratedAll.length / 2) ? clear : ratedAll;
  const score = pool.length ? Math.round(mean(pool.map((i) => shots[i].a.score))) : null;

  // 가장 먼저 고칠 것: (얼마나 자주 × 얼마나 중요한가) 순. 샷이 많은 종류의 문제를 조금 더 앞에. 한 종류에서 많아야 둘.
  const all = [];
  for (const b of kinds) for (const p of b.patterns) all.push({ ...p, kindLabel: b.label, rank: p.share * p.weight * Math.min(1, 0.55 + b.rated / 8) });
  all.sort((a, b) => b.rank - a.rank);
  const priorities = [], perKind = {};
  for (const p of all) {
    if ((perKind[p.kind] || 0) >= 2) continue;
    priorities.push(p); perKind[p.kind] = (perKind[p.kind] || 0) + 1;
    if (priorities.length === 3) break;
  }
  const strengths = kinds.flatMap((b) => b.strengths.slice(0, 3).map((s) => ({ ...s, kindLabel: b.label })));
  return { n: shots.length, rated: ratedAll.length, scored: pool.length, score, grade: score == null ? '평가 불가' : gradeOf(score), kinds, priorities, strengths,
    videos: new Set(shots.map((s) => s.vid ?? 0)).size };
}

/** '포핸드 12개 중 8개에서' */
export const countText = (p) => (p.of <= 1 ? `${p.kindLabel || KIND_LABEL[p.kind]}에서` : `${p.kindLabel || KIND_LABEL[p.kind]} ${p.of}개 중 ${p.n}개에서`);

/** 타점이 일정한지 한 줄로(샷마다 평균에서 벗어나는 정도 = 표준편차). heightCm = 키. 말할 것이 없으면 null */
export function spreadText(b, heightCm = 170) {
  const cm = (x) => Math.round(x * heightCm);
  const f = b.spread.front, h = b.spread.height;
  const say = (what, x, big) => (cm(x) <= 6 ? `${what}가 일정해요` : cm(x) >= big ? `${what}가 샷마다 ${cm(x)}cm쯤 흔들려요` : `${what}는 샷마다 ${cm(x)}cm쯤 달라요`);
  const parts = [];
  if (Number.isFinite(f)) parts.push(say('타점 앞뒤', f, 12));
  if (Number.isFinite(h)) parts.push(say('타점 높이', h, 14));
  return parts.length ? parts.join(' · ') : null;
}
